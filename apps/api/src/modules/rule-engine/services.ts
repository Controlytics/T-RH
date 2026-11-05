import os from 'node:os';
import dns from 'node:dns';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { Prisma, type Alarm, type PrismaClient } from '@prisma/client';
import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import { getProducer } from '@digilog/queue';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { writeBatchOrDeadLetter } from '../instruments/ingest-core.js';
import { classifyValue, DEVICE_TS_MAX_AHEAD_MS, DEVICE_TS_MIN } from '../instruments/payload-parser.js';
import { NUMERIC_READING } from '../instruments/telemetry.repository.js';
import { offsetKeyTest } from '../instruments/load-offsets.js';
import { publishAttributeDownlink } from '../instruments/attribute-downlink.js';
import { announceChildAttributeChange } from '../instruments/child-attributes-bundle.js';
import { enqueueAlarmEvaluation } from '../alarms/enqueue-evaluation.js';
import { enqueueAlarmNotification } from '../alarms/enqueue-notification.js';
import { enqueueAlarmWebhook } from '../alarm-webhooks/enqueue.js';
import { claimClear } from '../../workers/alarm-evaluation.worker.js';
import { sendNotification } from '../notification-delivery/delivery.service.js';
import { resolveTemplate } from '../notification-delivery/template-engine.js';
import { getApplicationAttributes, type RuleEngineConfig } from './config.js';
import { getChain } from './service.js';
import { emitTelemetry, emitAttributes, emitAttributesDeleted, emitAlarm } from './emit.js';
import { DURABLE_JOB_MAX_ATTEMPTS, durableJobPayload, parseRuleNodeOrigin, ruleNodeOrigin, type RuleMessage } from './message.js';
import { currentReentryDepth } from './context.js';
import { targetNotAllowed } from './nodes/external/target-guard.js';

/**
 * THE SERVICES a rule node may use (rule chains, 2026-11-03; spec §6, §7) —
 * thin adapters over the code paths this system already has, so a chain
 * writes exactly what the rest of the system writes:
 *  - telemetry → `writeBatchOrDeadLetter` (ingest-core.ts) with transport
 *    `rule-engine` and NO sensor-offset pass — the one write path, partition
 *    split and dead letters included. It enqueues an alarm evaluation (the
 *    readings are judged like any others) and does NOT stamp last-seen (the
 *    device did not speak);
 *  - attributes → the attribute table under the routes' advisory lock, one
 *    audit row per CHANGED key with user `SYSTEM` (ruling T2-A), the downlink
 *    published after the commit when `notifyDevice`. An unchanged value is
 *    neither written nor audited. ATTRIBUTES_UPDATED follows the caller's
 *    `updated` option (TB-P 7). Sensor-offset keys are refused (SUPER_ADMIN
 *    only — a chain shifting every reading is not a chain's call);
 *  - alarms → `alarms` rows `source RULE`, `metric CUSTOM` (the dedupe is the
 *    partial unique index `alarms_active_rule_type_unique`); the clear is
 *    `claimClear`; both enqueue the notification and the webhook the
 *    evaluator's alarms do (spec §12) and emit their ALARM / ALARM_CLEAR;
 *  - notifications → `sendNotification` (a `notification_logs` row, durable
 *    retries);
 *  - mqtt → one lazily connected client per node (`ctx.nodeKey`), closed on
 *    the node's destroy; protocol 3.1 / 3.1.1 / 5 as the node names it, a
 *    dropped client fails fast; the broker judged by the S-6 guard as the REST
 *    node's target is (review B M-4: resolved ONCE, every address judged, the
 *    client connects to the judged address). There is NO http service: the REST
 *    API call and Slack nodes use their own guarded transport (ruling S-6).
 * Every write takes the node's ORIGIN (`ctx.origin`) and passes it to the emit
 * helper of the event it causes — the loop guard (spec §5) reads it.
 */
export interface RuleTelemetryReading {
  key: string;
  value: unknown;
  ts: Date;
}

export interface RuleAttributeSaveOptions {
  /**
   * The ATTRIBUTES_UPDATED message a save emits (TB-P 7, 2026-11-05), through the
   * emit path and its loop guard: `changed` (the default) — the keys that changed;
   * `all` — every key of the save (ThingsBoard's `updateAttributesOnlyOnValueChange`
   * off); `none` — no message (the node's `sendAttributesUpdatedNotification` off, or
   * a Math function result). NEVER when nothing changed: a write that changes nothing
   * emits nothing, so re-entry stays bounded (rulings C-1, RE-1).
   */
  updated?: 'changed' | 'all' | 'none';
}

export type RuleTelemetryAggregation = 'NONE' | 'AVG' | 'MIN' | 'MAX' | 'SUM' | 'COUNT';

export interface RuleDurableOptions {
  /** Default: the running flow's depth (context.ts); 0 outside a flow. */
  reentryDepth?: number;
  /** The relation the message resumes on; default `Success` (Delay and Checkpoint). */
  relation?: string;
}

export interface RuleAlarmInput {
  instrumentId: string;
  alarmType: string;
  severity: string;
  details: unknown;
  nodeId: string;
  chainId: string;
}

export interface RuleEmailPayload {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  /** Only informs the log: the email channel decides HTML by the body's content. */
  isHtml?: boolean;
  origin?: string;
}

export interface RuleSmsPayload {
  numbers: string | string[];
  message: string;
  origin?: string;
}

export interface RuleSendResult {
  sent: number;
  failed: { recipient: string; error: string }[];
}

export interface RuleMqttConfig {
  host: string;
  port?: number;
  clientId?: string;
  appendClientIdSuffix?: boolean;
  connectTimeoutSec?: number;
  cleanSession?: boolean;
  ssl?: boolean;
  protocolVersion?: number;
  credentials?: {
    type?: string;
    username?: string;
    password?: string;
    caCert?: string;
    cert?: string;
    privateKey?: string;
    privateKeyPassword?: string;
  };
}

export interface RuleInstrument {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  isGateway: boolean;
  gatewayId: string | null;
  profileId: string;
  profileName: string | null;
  functionalLocationId: string | null;
  functionalLocationName: string | null;
  description: string | null;
  createdAt: Date;
}

export interface RuleLogger {
  debug(text: string, meta?: Record<string, unknown>): void;
  info(text: string, meta?: Record<string, unknown>): void;
  warn(text: string, meta?: Record<string, unknown>): void;
  error(text: string, meta?: Record<string, unknown>): void;
}

export interface RuleServices {
  prisma: PrismaClient;
  telemetry: {
    /**
     * Only readings that are NEW, or whose stored value at that instant DIFFERS, are judged
     * and emitted; the same value written back is a no-op that emits nothing. That alone does
     * NOT bound re-entry: a write that changes something on every pass (useServerTs, a
     * transform adding 1) is new every time. What ends it is the re-entry depth (ruling RE-1,
     * context.ts): the emit of a write made by a message that itself re-entered is skipped.
     * `skipLatest`: history only, `instrument_telemetry_latest` untouched (TB's skipLatestPersistence).
     * An instant before 2000 or more than 10 minutes ahead REFUSES the whole write
     * (`TIMESTAMP_OUT_OF_WINDOW`, ruling TS-1) — the node's Failure, nothing stored.
     */
    write(instrumentId: string, readings: RuleTelemetryReading[], origin: string, opts?: { skipLatest?: boolean }): Promise<void>;
    latest(instrumentId: string, keys: string[]): Promise<Record<string, { value: unknown; ts: Date }>>;
    /** Per key: NONE → the rows (ts ms + value), at most `limit` per key; an aggregation → one row `{ ts: to, value }`. */
    history(
      instrumentId: string, keys: string[], from: Date, to: Date,
      agg: RuleTelemetryAggregation, order: 'ASC' | 'DESC', limit: number,
    ): Promise<Record<string, { ts: number; value: unknown }[]>>;
  };
  attributes: {
    /** Every attribute, or only `keys` (exact names). */
    get(instrumentId: string, keys?: string[]): Promise<Record<string, string>>;
    /** Returns the keys that CHANGED (written and audited). An unchanged value is never written, audited or told to the device. */
    save(instrumentId: string, kv: Record<string, string>, origin: string, notifyDevice: boolean, scope?: string, opts?: RuleAttributeSaveOptions): Promise<string[]>;
    /**
     * Returns the keys that existed and were removed (each audited). Only after a removal, and only
     * when asked (Delete attributes' toggles, ThingsBoard's defaults OFF): `notifyDevice` tells the
     * instrument; `sendDeleted` emits ATTRIBUTES_DELETED naming the removed keys, through the loop guard.
     */
    delete(instrumentId: string, keys: string[], origin: string, scope?: string, opts?: { notifyDevice?: boolean; sendDeleted?: boolean }): Promise<string[]>;
  };
  instruments: {
    byId(id: string): Promise<RuleInstrument | null>;
    /** Case-insensitive, as the code is unique ignoring case. */
    byCode(code: string): Promise<RuleInstrument | null>;
    gatewayOf(id: string): Promise<RuleInstrument | null>;
    /**
     * The Originator fields node's vocabulary (`RULE_ORIGINATOR_FIELDS`) as strings; null for an unknown
     * instrument. `type` is the instrument's PROFILE name — ThingsBoard's device `type` is its device
     * profile (ruling recorded 2026-11-04).
     */
    fields(id: string): Promise<Record<string, string> | null>;
  };
  alarms: {
    /**
     * Opens the RULE alarm of that type, or updates the open one. An update that changes neither
     * the severity nor the details (by content) writes nothing and emits nothing (ruling RE-1) —
     * it still returns `{ alarm, created: false }`, so the node answers `Updated`.
     */
    createOrUpdate(input: RuleAlarmInput): Promise<{ alarm: Alarm; created: boolean }>;
    /** Clears the ACTIVE RULE alarm of that type; null when there is none. */
    /** `origin` REQUIRED (`ctx.origin`): the ALARM_CLEAR it emits goes through the loop guard. */
    clear(instrumentId: string, alarmType: string, details: unknown | undefined, origin: string): Promise<Alarm | null>;
    byId(id: string): Promise<Alarm | null>;
  };
  notifications: {
    /**
     * ONE message per recipient — To, Cc and Bcc alike — through `sendNotification` (a
     * `notification_logs` row and durable retries each). The email channel sends to ONE
     * address and has no Cc / Bcc (`channels/email-channel.ts`), so Cc and Bcc are delivered
     * as separate single-recipient messages: nobody sees another recipient's address.
     */
    email(payload: RuleEmailPayload): Promise<RuleSendResult>;
    sms(payload: RuleSmsPayload): Promise<RuleSendResult>;
    byTemplate(templateId: string, targets: { roles: string[]; userIds: string[] }, variables: Record<string, string>): Promise<RuleSendResult>;
  };
  // No `http` here (fix round 3, task-6b-review Minor 1): the unguarded `http.fetch` no node used was
  // removed — the REST API call and Slack nodes send through nodes/external/http.ts, which refuses
  // link-local and metadata targets after DNS (ruling S-6). Add no outbound primitive that skips it.
  mqtt: {
    /** One client per `nodeKey` (`ctx.nodeKey` = `<chainId>:<nodeId>`): two chains sharing node ids never share a client. */
    publish(nodeKey: string, config: RuleMqttConfig, topic: string, payload: string, qos: 0 | 1 | 2, retain: boolean): Promise<void>;
    close(nodeKey: string): Promise<void>;
  };
  /** Configuration → Application Attributes (the Tenant attributes node). */
  appAttributes(): Promise<Record<string, string>>;
  /** The Tenant details node: TITLE (company name), APP_NAME, SERVER_NAME, SERVER_VERSION. */
  appDetails(): Promise<Record<string, string>>;
  config(): RuleEngineConfig;
  durable: {
    /**
     * Hand the message to graphile-worker (`rule_engine_message`); it resumes AFTER `nodeId` on `Success`
     * (or `opts.relation`) at `runAt`, with its hop count, call stack and RE-ENTRY DEPTH (ruling RE-1) —
     * the running flow's, unless `opts.reentryDepth` says otherwise (the engine's stop hands a waiting
     * resume back with the depth it was admitted at).
     */
    enqueue(msg: RuleMessage, chainId: string, nodeId: string, runAt?: Date, opts?: RuleDurableOptions): Promise<void>;
  };
  stats: { inc(name: string): void };
  log: RuleLogger;
}

/** What the engine gives the services. */
export interface RuleServicesHooks {
  config(): RuleEngineConfig;
  inc(name: string): void;
}

export interface RuleServicesHandle extends RuleServices {
  /** Close every MQTT client (engine stop). */
  dispose(): Promise<void>;
}

/** The graphile task the Delay and Checkpoint nodes hand messages to. */
export const RULE_ENGINE_MESSAGE_TASK = 'rule_engine_message';
/** Per-originator order in graphile-worker: jobs sharing a queue run one at a time. */
export const ruleEngineQueueName = (originatorId: string) => `rule-engine:${originatorId}`;

/**
 * How many jobs wait on one durable queue, counted no further than `limit` — read from
 * graphile's tables as delay.ts reads them. Only jobs with attempts left count: graphile
 * keeps a permanently failed job, which would otherwise hold a place for good.
 * The plan (graphile 0.16, EXPLAINed on the test database 2026-11-05): the queue row is
 * found by its unique name; `_private_jobs` has NO index leading on `job_queue_id` (it is
 * only an INCLUDE column of the partial `jobs_main_index`), so the jobs are a scan of the
 * pending-jobs table — completed jobs are deleted, so it holds only what waits — stopped
 * at `limit` matches. delay.ts's `pendingAt` reads the same table the same way.
 */
export async function durableQueueDepth(queueName: string, limit: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
      WHERE q.queue_name = ${queueName} AND j.attempts < j.max_attempts
      LIMIT ${limit}::int
    ) waiting`;
  return rows[0]?.n ?? 0;
}

const ATTRIBUTE_LOCK_CLASS = 20260807; // the instrument routes' lock: one key space with them

/**
 * Every attribute lock this write needs, ALL before the first `auditLog`, in
 * sorted key order. `auditLog` takes the audit chain's advisory lock and holds
 * it to commit (instruments/routes.ts, LOCK-ORDER RULE): a key locked after it
 * would cycle against a route that holds that key and waits for the chain —
 * and two node writes of {a, b} and {b, a} would cycle on each other. Postgres
 * would kill one with 40P01.
 */
async function lockAttributes(tx: Prisma.TransactionClient, instrumentId: string, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ATTRIBUTE_LOCK_CLASS}::int, hashtext(${`${instrumentId}:${key}`}))`;
  }
}
const SIGNATURE_MAX = 255;
const clampSig = (s: string) => (s.length <= SIGNATURE_MAX ? s : `${s.slice(0, SIGNATURE_MAX - 1)}…`);
const short = (s: string) => (s.length <= 40 ? s : `${s.slice(0, 39)}…`);

/** Who wrote: `rule chain "X" node "Y"` from a `rule_node:` origin, else the origin itself. */
async function writerOf(origin: string): Promise<{ label: string; chainName: string | null; nodeName: string | null }> {
  const frame = parseRuleNodeOrigin(origin);
  if (!frame) return { label: origin, chainName: null, nodeName: null };
  const chain = await getChain(frame.chainId).catch(() => null);
  const node = chain?.nodesById.get(frame.nodeId);
  const chainName = chain?.name ?? frame.chainId;
  const nodeName = node?.name ?? frame.nodeId;
  return { label: `rule chain "${chainName}" node "${nodeName}"`, chainName, nodeName };
}

const instrumentSelect = {
  id: true, code: true, name: true, isActive: true, isGateway: true, gatewayId: true, profileId: true,
  functionalLocationId: true, description: true, createdAt: true,
  profile: { select: { name: true } }, functionalLocation: { select: { name: true } },
} as const;

type InstrumentRow = Prisma.InstrumentGetPayload<{ select: typeof instrumentSelect }>;

const toInstrument = (r: InstrumentRow | null): RuleInstrument | null => (r ? {
  id: r.id, code: r.code, name: r.name, isActive: r.isActive, isGateway: r.isGateway, gatewayId: r.gatewayId,
  profileId: r.profileId, profileName: r.profile?.name ?? null,
  functionalLocationId: r.functionalLocationId, functionalLocationName: r.functionalLocation?.name ?? null,
  description: r.description, createdAt: r.createdAt,
} : null);

/** JSON with object keys sorted — jsonb reorders keys, so a stored object compares by content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v));
}

/**
 * THE TIMESTAMP WINDOW of a rule-engine write (ruling TS-1, 2026-11-05; review B I-4):
 * ingest's plausibility window (`instruments/payload-parser.ts` — the SAME constants,
 * the same comparisons), but a rule write REFUSES where ingest replaces. An instant
 * before 2000-01-01 or more than 10 minutes ahead of the server fails the whole
 * write, naming it — nothing stored: an explicit instant a chain wrote is never
 * silently restamped, and a future one would pin `instrument_telemetry_latest` (the
 * reason ingest has the window, INGEST-6). An in-window BACKDATED reading is stored
 * as ingest stores one, unaudited (a new reading is process data, spec D5).
 * Returns the refusal, or null.
 */
export function timestampOutOfWindow(ts: Date, now: number = Date.now()): string | null {
  const t = ts.getTime();
  if (Number.isNaN(t)) return 'TIMESTAMP_OUT_OF_WINDOW: a reading has no valid instant; nothing was stored';
  if (t > now + DEVICE_TS_MAX_AHEAD_MS) {
    return `TIMESTAMP_OUT_OF_WINDOW: ${ts.toISOString()} is more than ${DEVICE_TS_MAX_AHEAD_MS / 60_000} minutes ahead of the server's time (${new Date(now).toISOString()}); nothing was stored`;
  }
  if (t < DEVICE_TS_MIN.getTime()) return `TIMESTAMP_OUT_OF_WINDOW: ${ts.toISOString()} is before ${DEVICE_TS_MIN.toISOString()}; nothing was stored`;
  return null;
}

/** The history rows already stored at these (key, instant) pairs, by `key\0ms`. */
async function storedAt(instrumentId: string, readings: RuleTelemetryReading[]): Promise<Map<string, { value: unknown; raw_value: unknown }>> {
  const keys = [...new Set(readings.map((r) => r.key))];
  const instants = [...new Set(readings.map((r) => r.ts.getTime()))].map((ms) => new Date(ms));
  const rows = await prisma.$queryRaw<{ key: string; ts: Date; value: unknown; raw_value: unknown }[]>`
    SELECT key, ts, value, raw_value FROM instrument_telemetry_history
    WHERE instrument_id = ${instrumentId} AND key IN (${Prisma.join(keys)}) AND ts IN (${Prisma.join(instants)})`;
  return new Map(rows.map((r) => [`${r.key}\u0000${r.ts.getTime()}`, { value: r.value, raw_value: r.raw_value }]));
}

/** ThingsBoard's `TbMqttNode`: MQTT_3_MAX_CLIENT_ID_LENGTH = 23 (the 3.1 spec's limit), MQTT_5_MAX_CLIENT_ID_LENGTH = 256. */
export const MQTT_3_1_MAX_CLIENT_ID_LENGTH = 23;
export const MQTT_MAX_CLIENT_ID_LENGTH = 256;

/**
 * The MQTT client id of a node: the configured one (with `_<suffix>` when
 * `appendClientIdSuffix`), else `digilog-rule-<suffix>`. The suffix is 10 hex
 * of sha1(nodeKey), so it is stable for the node, differs between two chains
 * that share node ids, and the generated id stays within MQTT 3.1's 23
 * characters. A SET id longer than ThingsBoard allows — 23 on MQTT 3.1
 * (protocol 3), its suffix included, else 256 — is refused with ThingsBoard's
 * own words (`TbMqttNode.getClientId`), never cut short: a shortened id could
 * collide with another client's and knock it off the broker.
 */
export function mqttClientIdFor(nodeKey: string, config: Pick<RuleMqttConfig, 'clientId' | 'appendClientIdSuffix' | 'protocolVersion'>): string {
  const suffix = createHash('sha1').update(nodeKey).digest('hex').slice(0, 10);
  const set = config.clientId?.trim();
  if (!set) return `digilog-rule-${suffix}`;
  const id = config.appendClientIdSuffix ? `${set}_${suffix}` : set;
  const max = config.protocolVersion === 3 ? MQTT_3_1_MAX_CLIENT_ID_LENGTH : MQTT_MAX_CLIENT_ID_LENGTH;
  if (id.length > max) throw new Error(`The length of Client ID cannot be longer than ${max}, but current length is ${id.length}.`);
  return id;
}

/** The node's protocol level as mqtt.js takes it: 3 = MQTT 3.1 (protocol name MQIsdp), 5 = MQTT 5, anything else 3.1.1. */
export function mqttProtocolOptions(protocolVersion: number | undefined): Pick<IClientOptions, 'protocolVersion' | 'protocolId'> {
  if (protocolVersion === 3) return { protocolVersion: 3, protocolId: 'MQIsdp' };
  if (protocolVersion === 5) return { protocolVersion: 5 };
  return { protocolVersion: 4 };
}

/**
 * Where an MQTT node may connect (review B M-4, 2026-11-05): the S-6 guard the
 * REST and Slack nodes go through (`nodes/external/target-guard.ts`) — link-local,
 * unspecified and cloud-metadata addresses refused; loopback and private allowed.
 * An IP literal is judged as it is, before any I/O. A NAME is resolved ONCE and
 * EVERY address it resolves to is judged (one refused → refused); the client then
 * connects to the first judged address, with `servername` = the name, so TLS still
 * sends SNI for and verifies the certificate against the name. mqtt.js reconnects
 * to that address, so no later DNS answer can move the connection (no rebinding);
 * a broker that changes address is picked up when the node's client is next made
 * (a config change, a chain save, a restart).
 */
export async function judgedBrokerAddress(host: string): Promise<{ address: string; servername?: string }> {
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) !== 0) {
    const refused = targetNotAllowed(literal);
    if (refused) throw new Error(refused);
    return { address: literal };
  }
  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
  for (const a of addresses) {
    const refused = targetNotAllowed(a.address);
    if (refused) throw new Error(refused);
  }
  return { address: addresses[0].address, servername: host };
}

const SEVERITIES = new Set(['CRITICAL', 'MAJOR', 'MINOR']);
/** ThingsBoard's WARNING / INDETERMINATE have no counterpart here: they read as MINOR (spec §7). */
export function ruleAlarmSeverity(value: string): 'CRITICAL' | 'MAJOR' | 'MINOR' {
  const v = String(value ?? '').trim().toUpperCase();
  return (SEVERITIES.has(v) ? v : 'MINOR') as 'CRITICAL' | 'MAJOR' | 'MINOR';
}

const list = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((s) => s.trim()).filter(Boolean);

function detailsText(details: unknown): string {
  if (details === null || details === undefined) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

export function createRuleServices(hooks: RuleServicesHooks): RuleServicesHandle {
  const log: RuleLogger = {
    debug: (t, m) => logger.debug(m ?? {}, `[rule-engine] ${t}`),
    info: (t, m) => logger.info(m ?? {}, `[rule-engine] ${t}`),
    warn: (t, m) => logger.warn(m ?? {}, `[rule-engine] ${t}`),
    error: (t, m) => logger.error(m ?? {}, `[rule-engine] ${t}`),
  };
  /**
   * One per nodeKey, set BEFORE the broker is judged (the lookup awaits), so two messages racing to
   * a node's first publish share ONE client. `client` is null until the judged connect starts.
   */
  const mqttClients = new Map<string, { client: MqttClient | null; fingerprint: string; ready: Promise<void>; closed: boolean }>();

  async function instrumentOrThrow(id: string): Promise<{ id: string; code: string; gatewayId: string | null }> {
    const row = await prisma.instrument.findUnique({ where: { id }, select: { id: true, code: true, gatewayId: true } });
    if (!row) throw new Error(`INSTRUMENT_NOT_FOUND: instrument ${id} does not exist`);
    return row;
  }

  /** The routes' downlink, after the commit: the full set on the instrument's slot and the gateway's change event. */
  async function announce(instrument: { id: string; code: string; gatewayId: string | null }, changes: [string, string | null][]): Promise<void> {
    try {
      const rows = await prisma.instrumentAttribute.findMany({ where: { instrumentId: instrument.id }, select: { key: true, value: true } });
      const attributes = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const gateway = instrument.gatewayId
        ? await prisma.instrument.findUnique({ where: { id: instrument.gatewayId }, select: { code: true } })
        : null;
      const warn = (m: string, meta?: Record<string, unknown>) => log.warn(`[downlink:attributes] ${m}`, meta);
      for (const [key, value] of changes) {
        await publishAttributeDownlink({
          instrumentId: instrument.id, gatewayId: instrument.gatewayId, code: instrument.code,
          gatewayCode: gateway?.code ?? null, attributes, changedKey: key, changedValue: value, ts: new Date(),
        }, warn);
        if (instrument.gatewayId) await announceChildAttributeChange(instrument.gatewayId, { code: instrument.code, key, value }, warn);
      }
    } catch (e) {
      log.warn('attribute downlink could not be built — the device was NOT told', { instrumentId: instrument.id, err: (e as Error).message });
    }
  }

  async function refuseOffsetKeys(keys: string[]): Promise<void> {
    const isOffset = await offsetKeyTest();
    const offsets = keys.filter((k) => isOffset(k));
    if (offsets.length > 0) {
      throw new Error(`OFFSET_KEY_REFUSED: ${offsets.map((k) => `"${k}"`).join(', ')} ${offsets.length === 1 ? 'is a sensor offset' : 'are sensor offsets'}, which only a super admin may change`);
    }
  }

  /** Raise / clear announcements, exactly as the evaluator words them. Never throws. */
  async function announceAlarm(kind: 'raised' | 'cleared', alarm: Alarm, alarmType: string, details: unknown): Promise<void> {
    try {
      const inst = await prisma.instrument.findUnique({ where: { id: alarm.instrumentId }, select: { code: true, name: true } });
      const payload = {
        alarmId: alarm.id,
        instrumentId: alarm.instrumentId,
        instrumentCode: inst?.code ?? null,
        instrumentName: inst?.name ?? null,
        metric: alarm.metric,
        ruleName: alarmType,
        condition: detailsText(details) || alarmType,
        triggeredValue: null,
        raisedAt: alarm.raisedAt,
        ...(kind === 'cleared' ? { clearedAt: alarm.clearedAt } : {}),
      };
      await enqueueAlarmNotification(kind, payload);
      await enqueueAlarmWebhook(kind === 'raised' ? 'RAISED' : 'CLEARED', payload);
    } catch (e) {
      log.error('a rule alarm notification could not be enqueued', { alarmId: alarm.id, err: (e as Error).message });
    }
  }

  async function sendEach(channel: 'EMAIL' | 'SMS', recipients: string[], subject: string | undefined, message: string, origin: string | undefined): Promise<RuleSendResult> {
    const result: RuleSendResult = { sent: 0, failed: [] };
    const writer = origin ? await writerOf(origin) : null;
    for (const recipient of [...new Set(recipients)]) {
      try {
        const r = await sendNotification({
          channel, recipient, message, ...(subject !== undefined ? { subject } : {}),
          triggeredBy: 'rule-engine',
          metadata: { source: 'rule-engine', ...(writer ? { ruleChain: writer.chainName, ruleNode: writer.nodeName, origin } : {}) },
        });
        if (r.success) result.sent++;
        else result.failed.push({ recipient, error: r.error ?? 'send failed' });
      } catch (e) {
        result.failed.push({ recipient, error: (e as Error).message });
      }
    }
    return result;
  }

  const services: RuleServicesHandle = {
    prisma: prisma as unknown as PrismaClient,

    telemetry: {
      async write(instrumentId, readings, origin, opts = {}) {
        if (readings.length === 0) return;
        // TS-1: judged before anything is read or written — one refused instant fails the whole write.
        const now = Date.now();
        for (const r of readings) {
          const refused = timestampOutOfWindow(r.ts, now);
          if (refused) throw new Error(refused);
        }
        const instrument = await instrumentOrThrow(instrumentId);
        // THE SAME READING WRITTEN BACK IS A NO-OP (found by the e2e, 2026-11-03).
        // A chain carries no `rawValue`, so writing back an offset-corrected
        // reading unchanged would set history's `raw_value` to NULL — erasing
        // what the device sent and auditing a "rewrite" of a value that did not
        // change. Where the stored value at that instant EQUALS the incoming
        // one, its stored raw value is carried along, and `writeBatch` (which
        // updates only a row that differs) writes nothing. A DIFFERENT value is
        // a real rewrite: it lands without a raw value, and `writeBatch` audits
        // TELEMETRY_READING_REWRITTEN with the old value and raw value.
        const prior = await storedAt(instrumentId, readings);
        const instantOf = (key: string, ts: Date) => `${key}\u0000${ts.getTime()}`;
        /** Instants whose stored value already EQUALS the incoming one: written as a no-op, and NOT emitted. */
        const unchanged = new Set<string>();
        const rows = readings.map((r) => {
          const p = prior.get(instantOf(r.key, r.ts));
          const same = p !== undefined && canonical(p.value) === canonical(r.value);
          if (same) unchanged.add(instantOf(r.key, r.ts));
          return {
            instrumentId, key: r.key, value: r.value, valueType: classifyValue(r.value), ts: r.ts,
            ...(same && p.raw_value !== null ? { rawValue: p.raw_value } : {}),
          };
        });
        const writer = await writerOf(origin);
        const raw = Buffer.from(JSON.stringify({ source: writer.label, readings: rows.map((r) => ({ key: r.key, value: r.value, ts: r.ts.toISOString() })) }));
        const result = await writeBatchOrDeadLetter(rows, { id: instrument.id, code: `rule-engine: ${writer.label}` }, 'rule-engine', raw,
          { applyOffsets: false, skipLatest: opts.skipLatest === true });
        if (result.failure !== null) throw new Error(`TELEMETRY_WRITE_FAILED: ${result.failure}`);
        if (result.unplaceable.length > 0 && result.stored.length === 0) {
          throw new Error('TIMESTAMP_OUT_OF_RANGE: every reading is older than the oldest telemetry partition');
        }
        // ONLY what is new or changed is judged and emitted (ruled 2026-11-04): a write
        // back of what is already stored (an ingest reading through Save Timeseries) is
        // quiet. A write that CHANGES something re-enters once with Re-enter ON, and its
        // re-entered message's write is stopped by the depth check in emit.ts (RE-1).
        const changed = result.stored.filter((r) => !unchanged.has(instantOf(r.key, r.ts)));
        if (changed.length === 0) return;
        await enqueueAlarmEvaluation();
        await emitTelemetry(instrumentId, changed, 'rule-engine', origin, instrument.code);
      },

      async latest(instrumentId, keys) {
        const rows = keys.length > 0
          ? await prisma.$queryRaw<{ key: string; value: unknown; ts: Date }[]>`
              SELECT key, value, ts FROM instrument_telemetry_latest WHERE instrument_id = ${instrumentId} AND key IN (${Prisma.join(keys)})`
          : await prisma.$queryRaw<{ key: string; value: unknown; ts: Date }[]>`
              SELECT key, value, ts FROM instrument_telemetry_latest WHERE instrument_id = ${instrumentId}`;
        return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, ts: r.ts }]));
      },

      async history(instrumentId, keys, from, to, agg, order, limit) {
        const out: Record<string, { ts: number; value: unknown }[]> = {};
        if (keys.length === 0) return out;
        const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
        if (agg === 'NONE') {
          const dir = order === 'ASC' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
          const rows = await prisma.$queryRaw<{ key: string; value: unknown; ts: Date }[]>`
            SELECT key, value, ts FROM (
              SELECT key, value, ts, row_number() OVER (PARTITION BY key ORDER BY ts ${dir}) AS rn
              FROM instrument_telemetry_history
              WHERE instrument_id = ${instrumentId} AND key IN (${Prisma.join(keys)}) AND ts >= ${from} AND ts <= ${to}
            ) r WHERE r.rn <= ${lim} ORDER BY key, ts ${dir}`;
          for (const r of rows) (out[r.key] ??= []).push({ ts: r.ts.getTime(), value: r.value });
          return out;
        }
        const fn = {
          AVG: Prisma.sql`avg(${NUMERIC_READING})`, MIN: Prisma.sql`min(${NUMERIC_READING})`, MAX: Prisma.sql`max(${NUMERIC_READING})`,
          SUM: Prisma.sql`sum(${NUMERIC_READING})`, COUNT: Prisma.sql`count(*)`,
        }[agg];
        const rows = await prisma.$queryRaw<{ key: string; value: unknown }[]>`
          SELECT key, ${fn}::float8 AS value FROM instrument_telemetry_history
          WHERE instrument_id = ${instrumentId} AND key IN (${Prisma.join(keys)}) AND ts >= ${from} AND ts <= ${to}
          GROUP BY key`;
        for (const r of rows) out[r.key] = [{ ts: to.getTime(), value: r.value }];
        return out;
      },
    },

    attributes: {
      async get(instrumentId, keys) {
        const rows = await prisma.instrumentAttribute.findMany({
          where: { instrumentId, ...(keys && keys.length > 0 ? { key: { in: keys } } : {}) },
          select: { key: true, value: true },
        });
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
      },

      async save(instrumentId, kv, origin, notifyDevice, scope, opts = {}) {
        const entries = Object.entries(kv).map(([k, v]) => [k.trim(), v] as [string, string]).filter(([k]) => k.length > 0);
        if (entries.length === 0) return [];
        await refuseOffsetKeys(entries.map(([k]) => k));
        const instrument = await instrumentOrThrow(instrumentId);
        const writer = await writerOf(origin);
        const changed: [string, string][] = [];
        await prisma.$transaction(async (tx) => {
          await lockAttributes(tx, instrumentId, entries.map(([k]) => k));
          for (const [key, value] of entries) {
            const before = await tx.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId, key } }, select: { value: true } });
            if (before && before.value === value) continue;
            await tx.instrumentAttribute.upsert({
              where: { instrumentId_key: { instrumentId, key } },
              create: { instrumentId, key, value },
              update: { value },
            });
            await auditLog({
              action: 'INSTRUMENT_ATTRIBUTE_SET', targetType: 'Instrument', targetId: instrumentId,
              ...(before ? { beforeValue: { code: instrument.code, attribute: key, value: before.value } } : {}),
              afterValue: { code: instrument.code, attribute: key, value, writtenBy: writer.label },
              reason: `Written by ${writer.label}`,
              signatureMeaning: clampSig(`Attribute "${short(key)}" on instrument "${short(instrument.code)}" ${before ? 'changed' : 'set'} by ${writer.label}`),
              userId: 'SYSTEM', userRole: 'SYSTEM',
            }, tx);
            changed.push([key, value]);
          }
        }, { timeout: 30_000 });
        if (changed.length === 0) return [];
        if (notifyDevice) await announce(instrument, changed);
        const updated = opts.updated ?? 'changed';
        if (updated !== 'none') {
          await emitAttributes(instrumentId, updated === 'all' ? entries : changed, origin, { type: 'ATTRIBUTES_UPDATED', scope: scope ?? 'SERVER_SCOPE', code: instrument.code });
        }
        return changed.map(([k]) => k);
      },

      async delete(instrumentId, keys, origin, scope, opts = {}) {
        const wanted = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
        if (wanted.length === 0) return [];
        await refuseOffsetKeys(wanted);
        const instrument = await instrumentOrThrow(instrumentId);
        const writer = await writerOf(origin);
        const removed: string[] = [];
        await prisma.$transaction(async (tx) => {
          await lockAttributes(tx, instrumentId, wanted);
          for (const key of wanted) {
            const before = await tx.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId, key } }, select: { value: true } });
            if (!before) continue;
            await tx.instrumentAttribute.delete({ where: { instrumentId_key: { instrumentId, key } } });
            await auditLog({
              action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetType: 'Instrument', targetId: instrumentId,
              beforeValue: { code: instrument.code, attribute: key, value: before.value },
              reason: `Removed by ${writer.label}`,
              signatureMeaning: clampSig(`Attribute "${short(key)}" removed from instrument "${short(instrument.code)}" by ${writer.label}`),
              userId: 'SYSTEM', userRole: 'SYSTEM',
            }, tx);
            removed.push(key);
          }
        }, { timeout: 30_000 });
        if (removed.length === 0) return [];
        if (opts.notifyDevice === true) await announce(instrument, removed.map((k) => [k, null]));
        if (opts.sendDeleted === true) await emitAttributesDeleted(instrumentId, removed, origin, scope ?? 'SERVER_SCOPE');
        return removed;
      },
    },

    instruments: {
      async byId(id) {
        return toInstrument(await prisma.instrument.findUnique({ where: { id }, select: instrumentSelect }));
      },
      async byCode(code) {
        return toInstrument(await prisma.instrument.findFirst({ where: { code: { equals: code.trim(), mode: 'insensitive' } }, select: instrumentSelect }));
      },
      async gatewayOf(id) {
        const row = await prisma.instrument.findUnique({ where: { id }, select: { gatewayId: true } });
        if (!row?.gatewayId) return null;
        return toInstrument(await prisma.instrument.findUnique({ where: { id: row.gatewayId }, select: instrumentSelect }));
      },
      async fields(id) {
        const r = await prisma.instrument.findUnique({ where: { id }, select: { ...instrumentSelect, instrumentType: true } });
        if (!r) return null;
        return {
          id: r.id,
          name: r.name,
          code: r.code,
          label: r.name,
          type: r.profile?.name ?? '',
          profileName: r.profile?.name ?? '',
          functionalLocation: r.functionalLocation?.name ?? '',
          isGateway: String(r.isGateway),
          createdTime: String(r.createdAt.getTime()),
          additionalInfo: r.description ?? '',
        };
      },
    },

    alarms: {
      async createOrUpdate(input) {
        const alarmType = input.alarmType.trim();
        if (!alarmType) throw new Error('ALARM_TYPE_REQUIRED: the alarm type is blank');
        const severity = ruleAlarmSeverity(input.severity);
        const snapshot = { alarmType, nodeId: input.nodeId, chainId: input.chainId, details: input.details ?? {} };
        const origin = ruleNodeOrigin(input.chainId, input.nodeId);
        const openId = async () => (await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM alarms WHERE instrument_id = ${input.instrumentId} AND source = 'RULE' AND state = 'ACTIVE'
            AND rule_snapshot ->> 'alarmType' = ${alarmType} LIMIT 1`)[0]?.id;
        // The open one first: a Create alarm node fires on EVERY message while its
        // condition holds, and going straight to the INSERT would make each of
        // those a unique violation Prisma logs at error level.
        let id = await openId();
        if (!id) {
          let created: Alarm | null = null;
          try {
            created = await prisma.alarm.create({
              data: {
                source: 'RULE', metric: 'CUSTOM', severity, state: 'ACTIVE', limitKind: null, triggeredValue: null,
                ruleSnapshot: snapshot as unknown as Prisma.InputJsonObject,
                instrumentId: input.instrumentId,
              },
            });
          } catch (e) {
            // The ONE partial unique index on RULE alarms is (instrument, alarmType)
            // WHERE ACTIVE: a P2002 means another message opened it just now → update that one.
            if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
          }
          if (created) {
            await announceAlarm('raised', created, alarmType, snapshot.details);
            await emitAlarm('ALARM', created, { isNewAlarm: true, origin });
            return { alarm: created, created: true };
          }
          id = await openId();
          if (!id) throw new Error(`ALARM_CONFLICT: an alarm "${alarmType}" was open and is not any more; try again`);
        }
        const existing = await prisma.alarm.findUniqueOrThrow({ where: { id } });
        const prior = existing.ruleSnapshot && typeof existing.ruleSnapshot === 'object' && !Array.isArray(existing.ruleSnapshot)
          ? existing.ruleSnapshot as Record<string, unknown> : {};
        // CHANGED-ONLY (ruling RE-1, 2026-11-05): the same severity and the same details
        // (by content — jsonb reorders keys) are no change — no UPDATE, no ALARM message. A
        // Create alarm node fires on EVERY message while its condition holds; re-announcing an
        // unchanged alarm pushed an extra ALARM into the root chain each time, and looped a
        // chain that feeds Create alarm its own ALARM. The node still answers `Updated`.
        if (existing.severity === severity && canonical(prior.details ?? {}) === canonical(input.details ?? {})) {
          return { alarm: existing, created: false };
        }
        const alarm = await prisma.alarm.update({
          where: { id: existing.id },
          data: {
            severity,
            ruleSnapshot: { ...prior, alarmType, nodeId: input.nodeId, chainId: input.chainId, details: input.details ?? {} } as unknown as Prisma.InputJsonObject,
          },
        });
        await emitAlarm('ALARM', alarm, { isExistingAlarm: true, origin });
        return { alarm, created: false };
      },

      async clear(instrumentId, alarmType, details, origin) {
        const type = alarmType.trim();
        const open = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM alarms WHERE instrument_id = ${instrumentId} AND source = 'RULE' AND state = 'ACTIVE'
            AND rule_snapshot ->> 'alarmType' = ${type} LIMIT 1`;
        if (open.length === 0) return null;
        const existing = await prisma.alarm.findUniqueOrThrow({ where: { id: open[0].id } });
        const prior = existing.ruleSnapshot && typeof existing.ruleSnapshot === 'object' && !Array.isArray(existing.ruleSnapshot)
          ? existing.ruleSnapshot as Record<string, unknown> : {};
        const closed = await claimClear(existing.id, {
          state: 'CLEARED', clearedAt: new Date(), clearedValue: null,
          ...(details !== undefined ? { ruleSnapshot: { ...prior, clearDetails: details } as unknown as Prisma.InputJsonObject } : {}),
        });
        if (!closed) return null;
        await announceAlarm('cleared', closed, type, prior.details);
        await emitAlarm('ALARM_CLEAR', closed, { isClearedAlarm: true, origin });
        return closed;
      },

      byId(id) {
        return prisma.alarm.findUnique({ where: { id } });
      },
    },

    notifications: {
      email(payload) {
        const to = [...list(payload.to), ...list(payload.cc), ...list(payload.bcc)];
        if (to.length === 0) return Promise.reject(new Error('EMAIL_NO_RECIPIENT: the message names no recipient'));
        return sendEach('EMAIL', to, payload.subject, payload.body, payload.origin);
      },
      sms(payload) {
        const numbers = list(payload.numbers);
        if (numbers.length === 0) return Promise.reject(new Error('SMS_NO_RECIPIENT: no phone number'));
        return sendEach('SMS', numbers, undefined, payload.message, payload.origin);
      },
      async byTemplate(templateId, targets, variables) {
        const template = await prisma.notificationTemplate.findUnique({ where: { id: templateId } });
        if (!template) throw new Error(`NOTIFICATION_TEMPLATE_NOT_FOUND: template ${templateId} does not exist`);
        if (!template.isActive) throw new Error(`NOTIFICATION_TEMPLATE_INACTIVE: template "${template.name}" is switched off`);
        const users = await prisma.user.findMany({
          where: {
            status: 'ENABLED',
            OR: [
              ...(targets.roles.length > 0 ? [{ role: { in: targets.roles } }] : []),
              ...(targets.userIds.length > 0 ? [{ id: { in: targets.userIds } }] : []),
            ],
          },
          select: { id: true, email: true, fullName: true },
        });
        if (users.length === 0 || (targets.roles.length === 0 && targets.userIds.length === 0)) return { sent: 0, failed: [] };
        const result: RuleSendResult = { sent: 0, failed: [] };
        const phones = template.channel === 'SMS'
          ? new Map((await prisma.systemConfig.findMany({ where: { configKey: { in: users.map((u) => `user-phone-${u.id}`) } } }))
            .map((c) => [c.configKey, (c.configValue as { phone?: string } | null)?.phone ?? '']))
          : new Map<string, string>();
        for (const u of users) {
          const vars = { ...variables, recipientName: u.fullName, recipientEmail: u.email ?? '' };
          const recipient = template.channel === 'EMAIL' ? (u.email ?? '') : (phones.get(`user-phone-${u.id}`) ?? '');
          if (!recipient) {
            result.failed.push({ recipient: u.fullName, error: template.channel === 'EMAIL' ? 'no email address' : 'no phone number' });
            continue;
          }
          try {
            const r = await sendNotification({
              channel: template.channel === 'SMS' ? 'SMS' : 'EMAIL', recipient,
              message: resolveTemplate(template.bodyTemplate, vars),
              ...(template.channel === 'EMAIL' ? { subject: resolveTemplate(template.subject ?? '', vars) } : {}),
              templateId: template.id, triggeredBy: 'rule-engine', metadata: { source: 'rule-engine', userId: u.id },
            });
            if (r.success) result.sent++;
            else result.failed.push({ recipient, error: r.error ?? 'send failed' });
          } catch (e) {
            result.failed.push({ recipient, error: (e as Error).message });
          }
        }
        return result;
      },
    },

    mqtt: {
      async publish(nodeKey, config, topic, payload, qos, retain) {
        const host = (config.host ?? '').trim();
        if (!host) throw new Error('MQTT_HOST_REQUIRED: the node has no broker host');
        const creds = config.credentials ?? {};
        const masked = Object.entries(creds).find(([k, v]) => k !== 'type' && v === '***');
        if (masked) throw new Error(`CREDENTIAL_NOT_SET: the ${masked[0]} was masked on export — re-enter it`);
        const fingerprint = JSON.stringify(config);
        let entry = mqttClients.get(nodeKey);
        if (entry && entry.fingerprint !== fingerprint) {
          await services.mqtt.close(nodeKey);
          entry = undefined;
        }
        if (!entry) {
          const ssl = config.ssl === true;
          // ThingsBoard builds a TLS context only when SSL is on (TbMqttNode.getSslContext), so a PEM
          // certificate with SSL off is not used there either: the connection is plain. Kept as
          // ThingsBoard does — an imported chain behaves the same — and said, since nothing in the
          // editor shows it: refusing would fail a chain ThingsBoard runs.
          if (creds.type === 'cert.PEM' && !ssl) {
            log.warn('MQTT node: its credentials are a client certificate (PEM) but SSL is off — the certificate is NOT used and the connection is plain TCP, as in ThingsBoard. Switch SSL on to use it.',
              { nodeKey, host });
          }
          const options: IClientOptions = {
            port: config.port ?? (ssl ? 8883 : 1883), protocol: ssl ? 'mqtts' : 'mqtt',
            // ThingsBoard: a blank client id is generated; `appendClientIdSuffix` makes a set one unique per node.
            clientId: mqttClientIdFor(nodeKey, config),
            clean: config.cleanSession !== false,
            connectTimeout: Math.max(1, config.connectTimeoutSec ?? 10) * 1000,
            reconnectPeriod: 5_000,
            ...mqttProtocolOptions(config.protocolVersion),
            ...(creds.type === 'basic' ? { username: creds.username, password: creds.password } : {}),
            ...(creds.type === 'cert.PEM' && ssl ? {
              ...(creds.caCert ? { ca: creds.caCert } : {}), ...(creds.cert ? { cert: creds.cert } : {}),
              ...(creds.privateKey ? { key: creds.privateKey } : {}), ...(creds.privateKeyPassword ? { passphrase: creds.privateKeyPassword } : {}),
            } : {}),
          };
          const made = { client: null as MqttClient | null, fingerprint, ready: Promise.resolve(), closed: false };
          made.ready = (async () => {
            // M-4: the broker through the S-6 guard. A refused target (or a failed lookup) leaves NO entry
            // and NO client — nothing reconnects to it every 5 s; the next message judges it again.
            let target: { address: string; servername?: string };
            try {
              target = await judgedBrokerAddress(host);
            } catch (e) {
              if (mqttClients.get(nodeKey) === made) mqttClients.delete(nodeKey);
              throw e;
            }
            if (made.closed) throw new Error('MQTT_CLOSED: the node was stopped while its broker was being resolved');
            const client = mqtt.connect({ ...options, host: target.address, ...(target.servername ? { servername: target.servername } : {}) });
            made.client = client;
            client.on('error', (err) => log.warn('MQTT node connection error', { nodeKey, err: err.message }));
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`MQTT_CONNECT_TIMEOUT: ${host} did not answer`)), (options.connectTimeout as number) + 1_000);
              timer.unref();
              client.once('connect', () => { clearTimeout(timer); resolve(); });
            });
          })();
          made.ready.catch(() => undefined);
          entry = made;
          mqttClients.set(nodeKey, entry);
        }
        if (!entry.client || !entry.client.connected) {
          // Never connected yet: wait for the judged connect (or its refusal / timeout). Connected once
          // and then DROPPED: `ready` is long resolved, so this FAILS FAST — mqtt.js would hold the publish
          // in its offline queue until it reconnects, and the message would sit out its whole 30 s budget.
          await entry.ready;
          if (!entry.client?.connected) throw new Error(`MQTT_NOT_CONNECTED: the connection to ${host} dropped — reconnecting every 5 s`);
        }
        await entry.client.publishAsync(topic, payload, { qos, retain });
      },
      async close(nodeKey) {
        const entry = mqttClients.get(nodeKey);
        if (!entry) return;
        mqttClients.delete(nodeKey);
        entry.closed = true;
        if (entry.client) await entry.client.endAsync(true).catch(() => undefined);
      },
    },

    appAttributes: () => getApplicationAttributes(),

    async appDetails() {
      const rows = await prisma.systemConfig.findMany({ where: { configKey: { in: ['branding', 'report-page-titles'] } }, select: { configKey: true, configValue: true } });
      const of = (key: string) => (rows.find((r) => r.configKey === key)?.configValue ?? {}) as Record<string, unknown>;
      const branding = of('branding');
      const titles = of('report-page-titles');
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      return {
        TITLE: str(titles.companyName) || str(branding.companyName),
        APP_NAME: str(titles.appName) || str(branding.appName),
        SERVER_NAME: os.hostname(),
        SERVER_VERSION: str(branding.version) || process.env.npm_package_version || '',
      };
    },

    config: () => hooks.config(),

    durable: {
      async enqueue(msg, chainId, nodeId, runAt, opts = {}) {
        const depth = opts.reentryDepth ?? currentReentryDepth();
        const queueName = ruleEngineQueueName(msg.originator.id);
        // THE DURABLE CAP (fw-api open item 3, 2026-11-05): a fan-out cycle through Delay /
        // Checkpoint restarts its step count at every durable resume, so the engine's STEP_LIMIT
        // never ends it; this does. `queueCapacity` waiting jobs on this originator's queue →
        // refused, nothing enqueued (the node's Failure). Count, then add: two hand-overs of ONE
        // originator racing in the same instant can each see room and overshoot by one apiece.
        const capacity = hooks.config().queueCapacity;
        const waiting = await durableQueueDepth(queueName, capacity);
        if (waiting >= capacity) {
          throw new Error(`DURABLE_QUEUE_FULL: ${waiting} messages of this originator already wait in the Delay / Checkpoint queue (${queueName}) — the queue capacity (Configuration → Rule Engine); this message was not queued`);
        }
        const producer = await getProducer();
        // The ONE job shape (message.ts): the engine's stop hands its backlog back through the same builder (M6).
        await producer.addJob(RULE_ENGINE_MESSAGE_TASK, durableJobPayload(msg, chainId, nodeId, { reentryDepth: depth, relation: opts.relation }), {
          queueName,
          ...(runAt ? { runAt } : {}),
          maxAttempts: DURABLE_JOB_MAX_ATTEMPTS,
        });
      },
    },

    stats: { inc: (name) => hooks.inc(name) },
    log,

    async dispose() {
      await Promise.all([...mqttClients.keys()].map((id) => services.mqtt.close(id)));
    },
  };
  return services;
}
