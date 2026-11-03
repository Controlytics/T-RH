import os from 'node:os';
import { Prisma, type Alarm, type PrismaClient } from '@prisma/client';
import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import { getProducer } from '@digilog/queue';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { writeBatchOrDeadLetter } from '../instruments/ingest-core.js';
import { classifyValue } from '../instruments/payload-parser.js';
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
import { parseRuleNodeOrigin, ruleNodeOrigin, serialisableMessage, type RuleMessage } from './message.js';

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
 *    neither written nor audited. Sensor-offset keys are refused (SUPER_ADMIN
 *    only — a chain shifting every reading is not a chain's call);
 *  - alarms → `alarms` rows `source RULE`, `metric CUSTOM` (the dedupe is the
 *    partial unique index `alarms_active_rule_type_unique`); the clear is
 *    `claimClear`; both enqueue the notification and the webhook the
 *    evaluator's alarms do (spec §12) and emit their ALARM / ALARM_CLEAR;
 *  - notifications → `sendNotification` (a `notification_logs` row, durable
 *    retries);
 *  - http → Node's fetch with a timeout; mqtt → one lazily connected client
 *    per node, closed on the node's destroy.
 * Every write takes the node's ORIGIN (`ctx.origin`) and passes it to the emit
 * helper of the event it causes — the loop guard (spec §5) reads it.
 */
export interface RuleTelemetryReading {
  key: string;
  value: unknown;
  ts: Date;
}

export type RuleTelemetryAggregation = 'NONE' | 'AVG' | 'MIN' | 'MAX' | 'SUM' | 'COUNT';

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
    write(instrumentId: string, readings: RuleTelemetryReading[], origin: string): Promise<void>;
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
    /** Returns the keys that CHANGED (written and audited). */
    save(instrumentId: string, kv: Record<string, string>, origin: string, notifyDevice: boolean, scope?: string): Promise<string[]>;
    /** Returns the keys that existed and were removed. */
    delete(instrumentId: string, keys: string[], origin: string, scope?: string): Promise<string[]>;
  };
  instruments: {
    byId(id: string): Promise<RuleInstrument | null>;
    /** Case-insensitive, as the code is unique ignoring case. */
    byCode(code: string): Promise<RuleInstrument | null>;
    gatewayOf(id: string): Promise<RuleInstrument | null>;
    /** The Originator fields node's vocabulary (`RULE_ORIGINATOR_FIELDS`) as strings; null for an unknown instrument. */
    fields(id: string): Promise<Record<string, string> | null>;
  };
  alarms: {
    createOrUpdate(input: RuleAlarmInput): Promise<{ alarm: Alarm; created: boolean }>;
    /** Clears the ACTIVE RULE alarm of that type; null when there is none. */
    clear(instrumentId: string, alarmType: string, details?: unknown, origin?: string): Promise<Alarm | null>;
    byId(id: string): Promise<Alarm | null>;
  };
  notifications: {
    email(payload: RuleEmailPayload): Promise<RuleSendResult>;
    sms(payload: RuleSmsPayload): Promise<RuleSendResult>;
    byTemplate(templateId: string, targets: { roles: string[]; userIds: string[] }, variables: Record<string, string>): Promise<RuleSendResult>;
  };
  http: {
    fetch(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
  };
  mqtt: {
    publish(nodeId: string, config: RuleMqttConfig, topic: string, payload: string, qos: 0 | 1 | 2, retain: boolean): Promise<void>;
    close(nodeId: string): Promise<void>;
  };
  /** Configuration → Application Attributes (the Tenant attributes node). */
  appAttributes(): Promise<Record<string, string>>;
  /** The Tenant details node: TITLE (company name), APP_NAME, SERVER_NAME, SERVER_VERSION. */
  appDetails(): Promise<Record<string, string>>;
  config(): RuleEngineConfig;
  durable: {
    /** Hand the message to graphile-worker (`rule_engine_message`); it resumes AFTER `nodeId` on `Success` (at `runAt`). */
    enqueue(msg: RuleMessage, chainId: string, nodeId: string, runAt?: Date): Promise<void>;
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

const ATTRIBUTE_LOCK_CLASS = 20260807; // the instrument routes' lock: one key space with them
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

/** The history rows already stored at these (key, instant) pairs, by `key\0ms`. */
async function storedAt(instrumentId: string, readings: RuleTelemetryReading[]): Promise<Map<string, { value: unknown; raw_value: unknown }>> {
  const keys = [...new Set(readings.map((r) => r.key))];
  const instants = [...new Set(readings.map((r) => r.ts.getTime()))].map((ms) => new Date(ms));
  const rows = await prisma.$queryRaw<{ key: string; ts: Date; value: unknown; raw_value: unknown }[]>`
    SELECT key, ts, value, raw_value FROM instrument_telemetry_history
    WHERE instrument_id = ${instrumentId} AND key IN (${Prisma.join(keys)}) AND ts IN (${Prisma.join(instants)})`;
  return new Map(rows.map((r) => [`${r.key}\u0000${r.ts.getTime()}`, { value: r.value, raw_value: r.raw_value }]));
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
  const mqttClients = new Map<string, { client: MqttClient; fingerprint: string; ready: Promise<void> }>();

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
      async write(instrumentId, readings, origin) {
        if (readings.length === 0) return;
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
        const rows = readings.map((r) => {
          const p = prior.get(`${r.key}\u0000${r.ts.getTime()}`);
          const same = p !== undefined && p.raw_value !== null && canonical(p.value) === canonical(r.value);
          return {
            instrumentId, key: r.key, value: r.value, valueType: classifyValue(r.value), ts: r.ts,
            ...(same ? { rawValue: p.raw_value } : {}),
          };
        });
        const writer = await writerOf(origin);
        const raw = Buffer.from(JSON.stringify({ source: writer.label, readings: rows.map((r) => ({ key: r.key, value: r.value, ts: r.ts.toISOString() })) }));
        const result = await writeBatchOrDeadLetter(rows, { id: instrument.id, code: `rule-engine: ${writer.label}` }, 'rule-engine', raw, { applyOffsets: false });
        if (result.failure !== null) throw new Error(`TELEMETRY_WRITE_FAILED: ${result.failure}`);
        if (result.unplaceable.length > 0 && result.stored.length === 0) {
          throw new Error('TIMESTAMP_OUT_OF_RANGE: every reading is older than the oldest telemetry partition');
        }
        if (result.stored.length === 0) return;
        await enqueueAlarmEvaluation();
        await emitTelemetry(instrumentId, result.stored, 'rule-engine', origin, instrument.code);
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

      async save(instrumentId, kv, origin, notifyDevice, scope) {
        const entries = Object.entries(kv).map(([k, v]) => [k.trim(), v] as [string, string]).filter(([k]) => k.length > 0);
        if (entries.length === 0) return [];
        await refuseOffsetKeys(entries.map(([k]) => k));
        const instrument = await instrumentOrThrow(instrumentId);
        const writer = await writerOf(origin);
        const changed: [string, string][] = [];
        await prisma.$transaction(async (tx) => {
          for (const [key, value] of entries) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ATTRIBUTE_LOCK_CLASS}::int, hashtext(${`${instrumentId}:${key}`}))`;
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
        await emitAttributes(instrumentId, changed, origin, { type: 'ATTRIBUTES_UPDATED', scope: scope ?? 'SERVER_SCOPE', code: instrument.code });
        return changed.map(([k]) => k);
      },

      async delete(instrumentId, keys, origin, scope) {
        const wanted = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
        if (wanted.length === 0) return [];
        await refuseOffsetKeys(wanted);
        const instrument = await instrumentOrThrow(instrumentId);
        const writer = await writerOf(origin);
        const removed: string[] = [];
        await prisma.$transaction(async (tx) => {
          for (const key of wanted) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ATTRIBUTE_LOCK_CLASS}::int, hashtext(${`${instrumentId}:${key}`}))`;
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
        await announce(instrument, removed.map((k) => [k, null]));
        await emitAttributesDeleted(instrumentId, removed, origin, scope ?? 'SERVER_SCOPE');
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
          // WHERE ACTIVE: a P2002 means this type is already open → update it.
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        }
        if (created) {
          await announceAlarm('raised', created, alarmType, snapshot.details);
          await emitAlarm('ALARM', created, { isNewAlarm: true, origin });
          return { alarm: created, created: true };
        }
        const open = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM alarms WHERE instrument_id = ${input.instrumentId} AND source = 'RULE' AND state = 'ACTIVE'
            AND rule_snapshot ->> 'alarmType' = ${alarmType} LIMIT 1`;
        if (open.length === 0) throw new Error(`ALARM_CONFLICT: an alarm "${alarmType}" was open and is not any more; try again`);
        const existing = await prisma.alarm.findUniqueOrThrow({ where: { id: open[0].id } });
        const prior = existing.ruleSnapshot && typeof existing.ruleSnapshot === 'object' && !Array.isArray(existing.ruleSnapshot)
          ? existing.ruleSnapshot as Record<string, unknown> : {};
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
        await emitAlarm('ALARM_CLEAR', closed, { isClearedAlarm: true, ...(origin ? { origin } : {}) });
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

    http: {
      fetch(url, init, timeoutMs) {
        return fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutMs ?? hooks.config().httpTimeoutMs)) });
      },
    },

    mqtt: {
      async publish(nodeId, config, topic, payload, qos, retain) {
        const host = (config.host ?? '').trim();
        if (!host) throw new Error('MQTT_HOST_REQUIRED: the node has no broker host');
        const creds = config.credentials ?? {};
        const masked = Object.entries(creds).find(([k, v]) => k !== 'type' && v === '***');
        if (masked) throw new Error(`CREDENTIAL_NOT_SET: the ${masked[0]} was masked on export — re-enter it`);
        const fingerprint = JSON.stringify(config);
        let entry = mqttClients.get(nodeId);
        if (entry && entry.fingerprint !== fingerprint) {
          await services.mqtt.close(nodeId);
          entry = undefined;
        }
        if (!entry) {
          const ssl = config.ssl === true;
          const options: IClientOptions = {
            host, port: config.port ?? (ssl ? 8883 : 1883), protocol: ssl ? 'mqtts' : 'mqtt',
            // ThingsBoard: a blank client id is generated; `appendClientIdSuffix` makes a set one unique per node.
            clientId: config.clientId?.trim()
              ? `${config.clientId.trim()}${config.appendClientIdSuffix ? `_${nodeId.slice(0, 8)}` : ''}`
              : `digilog-rule-${nodeId.slice(0, 8)}`,
            clean: config.cleanSession !== false,
            connectTimeout: Math.max(1, config.connectTimeoutSec ?? 10) * 1000,
            reconnectPeriod: 5_000,
            ...(config.protocolVersion === 5 ? { protocolVersion: 5 as const } : {}),
            ...(creds.type === 'basic' ? { username: creds.username, password: creds.password } : {}),
            ...(creds.type === 'cert.PEM' ? {
              ...(creds.caCert ? { ca: creds.caCert } : {}), ...(creds.cert ? { cert: creds.cert } : {}),
              ...(creds.privateKey ? { key: creds.privateKey } : {}), ...(creds.privateKeyPassword ? { passphrase: creds.privateKeyPassword } : {}),
            } : {}),
          };
          const client = mqtt.connect(options);
          client.on('error', (err) => log.warn('MQTT node connection error', { nodeId, err: err.message }));
          const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`MQTT_CONNECT_TIMEOUT: ${host} did not answer`)), (options.connectTimeout as number) + 1_000);
            timer.unref();
            client.once('connect', () => { clearTimeout(timer); resolve(); });
          });
          ready.catch(() => undefined);
          entry = { client, fingerprint, ready };
          mqttClients.set(nodeId, entry);
        }
        if (!entry.client.connected) await entry.ready;
        await entry.client.publishAsync(topic, payload, { qos, retain });
      },
      async close(nodeId) {
        const entry = mqttClients.get(nodeId);
        if (!entry) return;
        mqttClients.delete(nodeId);
        await entry.client.endAsync(true).catch(() => undefined);
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
      async enqueue(msg, chainId, nodeId, runAt) {
        const producer = await getProducer();
        await producer.addJob(RULE_ENGINE_MESSAGE_TASK, {
          message: serialisableMessage(msg), chainId, resumeAfterNodeId: nodeId,
        }, {
          queueName: ruleEngineQueueName(msg.originator.id),
          ...(runAt ? { runAt } : {}),
          maxAttempts: 5,
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
