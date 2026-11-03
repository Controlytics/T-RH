import { logger } from '../../lib/logger.js';
import {
  newMessage, isRuleNodeOrigin, parseRuleNodeOrigin, metadataValue,
  RULE_ENGINE_ORIGIN_KEY, INGEST_ORIGIN, SYSTEM_ORIGIN, USER_ORIGIN,
  type RuleMessage,
} from './message.js';

/**
 * EMIT HELPERS (rule chains, 2026-11-03; spec §5) — where every event enters
 * the rule engine: ingest-core (telemetry), attribute-report (a device's
 * attributes), the alarm evaluator (raise / clear / inactivity), the
 * acknowledge route, the instrument routes, and the engine's own services (a
 * rule node's writes).
 *
 * The rules every helper keeps:
 *  - it is called AFTER the caller's transaction committed;
 *  - it NEVER throws into its caller and never waits on the database: with no
 *    engine started, or the engine switched off, it returns at once; anything
 *    that goes wrong is counted (`emit_errors`) and logged;
 *  - enqueueing is O(1) (engine.ts / queue.ts);
 *  - THE LOOP GUARD (spec §5, ruling S-2): a write made BY a rule node carries
 *    `rule_engine_origin = rule_node:<chainId>:<nodeId>`; its event is skipped
 *    unless THAT chain's "Re-enter on rule-node writes" is on.
 *
 * No static import of the engine: the engine installs itself here as the SINK
 * when it starts (`setRuleEngineSink`), which keeps ingest-core → emit free of
 * the engine → services → ingest-core cycle.
 */
export interface RuleEngineSink {
  /** Started AND switched on (Configuration → Rule Engine). Synchronous: a cached flag. */
  accepting(): boolean;
  /** O(1); false when the message was not admitted. */
  enqueue(msg: RuleMessage): boolean;
  /** The chain's "Re-enter on rule-node writes" switch. */
  reEnterAllowed(chainId: string): Promise<boolean>;
}

let sink: RuleEngineSink | null = null;
const counters = { emitted: 0, emit_errors: 0, loop_skipped: 0 };
let lastErrorLogAt = 0;

export function setRuleEngineSink(next: RuleEngineSink | null): void {
  sink = next;
}

export function emitCounters(): Readonly<typeof counters> {
  return { ...counters };
}

/** Test seam. */
export function resetEmitCounters(): void {
  counters.emitted = 0;
  counters.emit_errors = 0;
  counters.loop_skipped = 0;
}

function logError(err: unknown, what: string): void {
  const now = Date.now();
  if (now - lastErrorLogAt < 60_000) return;
  lastErrorLogAt = now;
  logger.error({ err: err instanceof Error ? err.message : String(err) }, `[rule-engine] could not emit ${what} (logged once a minute)`);
}

/**
 * The one path every helper takes: accepting? → loop guard → build → stamp
 * the origin → enqueue. Returns how many messages were admitted.
 */
async function deliver(what: string, origin: string, build: () => RuleMessage[]): Promise<number> {
  const s = sink;
  if (!s) return 0;
  try {
    if (!s.accepting()) return 0;
    if (isRuleNodeOrigin(origin)) {
      const frame = parseRuleNodeOrigin(origin);
      if (!frame || !(await s.reEnterAllowed(frame.chainId))) {
        counters.loop_skipped++;
        return 0;
      }
    }
    let admitted = 0;
    for (const msg of build()) {
      msg.metadata[RULE_ENGINE_ORIGIN_KEY] = origin;
      if (s.enqueue(msg)) admitted++;
    }
    counters.emitted += admitted;
    return admitted;
  } catch (err) {
    counters.emit_errors++;
    logError(err, what);
    return 0;
  }
}

export interface EmittedReading {
  key: string;
  value: unknown;
  ts: Date;
  /** What the device sent when a sensor offset corrected `value` (ingest only). */
  rawValue?: unknown;
}

const sameJson = (a: unknown, b: unknown) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/**
 * `POST_TELEMETRY_REQUEST` (spec §5): ONE message per instrument per instant —
 * a batch is one instant, so normally one per instrument per batch — with the
 * ThingsBoard data shape `{ ts, values: { key: value } }` (ts in ms). Values
 * are the STORED ones, after sensor offsets; a device value an offset
 * corrected is in `metadata.raw_<key>`. `instrumentCode` / `instrumentName` /
 * `profileName` are filled in by the engine before the first node (no lookup
 * here, on the ingest path).
 */
export function emitTelemetry(
  instrumentId: string,
  readings: readonly EmittedReading[],
  transport: string,
  origin: string = INGEST_ORIGIN,
  code?: string,
): Promise<number> {
  return deliver('telemetry', origin, () => {
    const byTs = new Map<number, EmittedReading[]>();
    for (const r of readings) {
      const t = r.ts.getTime();
      const list = byTs.get(t);
      if (list) list.push(r);
      else byTs.set(t, [r]);
    }
    return [...byTs.entries()].map(([ts, rows]) => {
      const values: Record<string, unknown> = {};
      const metadata: Record<string, unknown> = { ts, transport, ...(code ? { instrumentCode: code } : {}) };
      for (const r of rows) {
        values[r.key] = r.value;
        if (r.rawValue !== undefined && !sameJson(r.rawValue, r.value)) metadata[`raw_${r.key}`] = metadataValue(r.rawValue);
      }
      return newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: instrumentId, ...(code ? { code } : {}) }, { ts, values }, metadata);
    });
  });
}

/** A gateway batch: one `emitTelemetry` per instrument in it. */
export async function emitTelemetryBatch(
  readings: readonly (EmittedReading & { instrumentId: string })[],
  transport: string,
  origin: string = INGEST_ORIGIN,
): Promise<number> {
  if (!sink) return 0;
  const byInstrument = new Map<string, EmittedReading[]>();
  for (const r of readings) {
    const list = byInstrument.get(r.instrumentId);
    if (list) list.push(r);
    else byInstrument.set(r.instrumentId, [r]);
  }
  let n = 0;
  for (const [id, rows] of byInstrument) n += await emitTelemetry(id, rows, transport, origin);
  return n;
}

export type EmittedAttributes = readonly (readonly [string, string])[] | Readonly<Record<string, string>>;

/**
 * Attributes that CHANGED, as `{ key: value }`.
 *  - A device's report (origin `ingest`): `POST_ATTRIBUTES_REQUEST`, `scope=CLIENT_SCOPE`.
 *  - A rule node's Save attributes (origin `rule_node:…`): `ATTRIBUTES_UPDATED`, `scope=SERVER_SCOPE`.
 * `opts` overrides either.
 */
export function emitAttributes(
  instrumentId: string,
  changed: EmittedAttributes,
  origin: string,
  opts: { type?: 'POST_ATTRIBUTES_REQUEST' | 'ATTRIBUTES_UPDATED'; scope?: string; code?: string } = {},
): Promise<number> {
  return deliver('attributes', origin, () => {
    const data: Record<string, string> = Array.isArray(changed)
      ? Object.fromEntries(changed as readonly (readonly [string, string])[])
      : { ...(changed as Record<string, string>) };
    if (Object.keys(data).length === 0) return [];
    const fromDevice = origin === INGEST_ORIGIN;
    const type = opts.type ?? (fromDevice ? 'POST_ATTRIBUTES_REQUEST' : 'ATTRIBUTES_UPDATED');
    const scope = opts.scope ?? (type === 'POST_ATTRIBUTES_REQUEST' ? 'CLIENT_SCOPE' : 'SERVER_SCOPE');
    return [newMessage(type, { type: 'INSTRUMENT', id: instrumentId, ...(opts.code ? { code: opts.code } : {}) }, data, {
      scope, ts: Date.now(), ...(opts.code ? { instrumentCode: opts.code } : {}),
    })];
  });
}

/** `ATTRIBUTES_DELETED` — a rule node's Delete attributes: `{ attributes: [keys] }`. */
export function emitAttributesDeleted(instrumentId: string, keys: readonly string[], origin: string, scope = 'SERVER_SCOPE'): Promise<number> {
  return deliver('attributes deleted', origin, () => (keys.length === 0 ? [] : [
    newMessage('ATTRIBUTES_DELETED', { type: 'INSTRUMENT', id: instrumentId }, { attributes: [...keys] }, { scope, ts: Date.now() }),
  ]));
}

/** The alarm columns the message is built from — a Prisma `Alarm` row fits. */
export interface EmittedAlarm {
  id: string;
  instrumentId: string;
  source: string;
  metric: string;
  severity: string;
  state: string;
  limitKind?: string | null;
  triggeredValue?: number | null;
  clearedValue?: number | null;
  raisedAt: Date;
  clearedAt?: Date | null;
  acknowledgedAt?: Date | null;
  acknowledgedBy?: string | null;
  ruleSnapshot?: unknown;
}

export type AlarmMessageKind = 'ALARM' | 'ALARM_CLEAR' | 'ALARM_ACK';

export interface AlarmEmitFlags {
  isNewAlarm?: boolean;
  isExistingAlarm?: boolean;
  isClearedAlarm?: boolean;
  acknowledgedBy?: string | null;
  /** The administered name the caller already resolved (the evaluator's `ruleName`). */
  typeName?: string;
  instrumentCode?: string | null;
  /** Default `system` (the evaluator); the acknowledge route passes `user`; a rule node its `rule_node:` origin. */
  origin?: string;
}

const snapshotOf = (a: EmittedAlarm): Record<string, unknown> =>
  (a.ruleSnapshot && typeof a.ruleSnapshot === 'object' && !Array.isArray(a.ruleSnapshot) ? a.ruleSnapshot as Record<string, unknown> : {});

/** ThingsBoard's alarm status from state + acknowledgement. */
export function alarmStatus(a: Pick<EmittedAlarm, 'state' | 'acknowledgedAt'>): 'ACTIVE_UNACK' | 'ACTIVE_ACK' | 'CLEARED_UNACK' | 'CLEARED_ACK' {
  const acked = !!a.acknowledgedAt;
  if (a.state === 'ACTIVE') return acked ? 'ACTIVE_ACK' : 'ACTIVE_UNACK';
  return acked ? 'CLEARED_ACK' : 'CLEARED_UNACK';
}

/** The alarm type a chain filters on: a RULE alarm's own `alarmType`, else the caller's name, else source / metric / bound. */
export function alarmTypeOf(a: EmittedAlarm, typeName?: string): string {
  const snap = snapshotOf(a);
  if (a.source === 'RULE' && typeof snap.alarmType === 'string' && snap.alarmType) return snap.alarmType;
  if (typeName) return typeName;
  return [a.source, a.metric, a.limitKind].filter(Boolean).join(' ');
}

/** The alarm as ThingsBoard's alarm JSON, plus this system's own columns. */
export function alarmMessageData(a: EmittedAlarm, typeName?: string): Record<string, unknown> {
  const snap = snapshotOf(a);
  const ms = (d: Date | null | undefined) => (d ? d.getTime() : 0);
  return {
    id: a.id,
    type: alarmTypeOf(a, typeName),
    originator: { entityType: 'INSTRUMENT', id: a.instrumentId },
    severity: a.severity,
    status: alarmStatus(a),
    acknowledged: !!a.acknowledgedAt,
    cleared: a.state !== 'ACTIVE',
    startTs: ms(a.raisedAt),
    endTs: Math.max(ms(a.raisedAt), ms(a.clearedAt), ms(a.acknowledgedAt)),
    ackTs: ms(a.acknowledgedAt),
    clearTs: ms(a.clearedAt),
    details: a.source === 'RULE' ? (snap.details ?? {}) : snap,
    source: a.source,
    metric: a.metric,
    limitKind: a.limitKind ?? null,
    triggeredValue: a.triggeredValue ?? null,
    clearedValue: a.clearedValue ?? null,
    acknowledgedBy: a.acknowledgedBy ?? null,
  };
}

/**
 * `ALARM` (raised, or a RULE alarm updated), `ALARM_CLEAR`, `ALARM_ACK` — the
 * originator is the ALARM; the instrument is in `metadata.instrumentId`
 * (`instrumentCode` filled by the engine). Flags as ThingsBoard sets them.
 */
export function emitAlarm(kind: AlarmMessageKind, alarm: EmittedAlarm, flags: AlarmEmitFlags = {}): Promise<number> {
  const origin = flags.origin ?? SYSTEM_ORIGIN;
  return deliver(`alarm ${kind}`, origin, () => {
    const metadata: Record<string, unknown> = {
      instrumentId: alarm.instrumentId,
      ...(flags.instrumentCode ? { instrumentCode: flags.instrumentCode } : {}),
      ts: Date.now(),
    };
    if (kind === 'ALARM') {
      metadata.isNewAlarm = flags.isNewAlarm === true;
      metadata.isExistingAlarm = flags.isExistingAlarm === true;
    }
    if (kind === 'ALARM_CLEAR') metadata.isClearedAlarm = true;
    if (kind === 'ALARM_ACK') metadata.acknowledgedBy = flags.acknowledgedBy ?? alarm.acknowledgedBy ?? '';
    return [newMessage(kind, { type: 'ALARM', id: alarm.id }, alarmMessageData(alarm, flags.typeName), metadata)];
  });
}

/** `INACTIVITY_EVENT` — the instrument went quiet (the inactivity alarm's raise). */
export function emitInactivity(instrumentId: string, lastActivity: Date | null, inactivityAlarmTime: Date = new Date()): Promise<number> {
  return deliver('inactivity', SYSTEM_ORIGIN, () => [
    newMessage('INACTIVITY_EVENT', { type: 'INSTRUMENT', id: instrumentId }, {
      lastActivityTime: lastActivity ? lastActivity.getTime() : null,
      inactivityAlarmTime: inactivityAlarmTime.getTime(),
    }, { ts: Date.now() }),
  ]);
}

/** `ACTIVITY_EVENT` — data resumed (the inactivity alarm's clear). */
export function emitActivity(instrumentId: string, lastActivity: Date | null): Promise<number> {
  return deliver('activity', SYSTEM_ORIGIN, () => [
    newMessage('ACTIVITY_EVENT', { type: 'INSTRUMENT', id: instrumentId }, {
      lastActivityTime: lastActivity ? lastActivity.getTime() : null,
    }, { ts: Date.now() }),
  ]);
}

export type EntityMessageKind = 'ENTITY_CREATED' | 'ENTITY_UPDATED' | 'ENTITY_DELETED';

/** The instrument columns a message may carry: never a token, a credential or a certificate. */
const ENTITY_FIELDS = [
  'id', 'code', 'name', 'description', 'instrumentType', 'manufacturer', 'model', 'serialNumber',
  'isActive', 'isGateway', 'gatewayId', 'profileId', 'functionalLocationId', 'location', 'area', 'block',
  'expectedIntervalSec', 'modbusHost', 'modbusPort', 'modbusUnitId', 'modbusIntervalSec',
  'createdAt', 'updatedAt', 'createdBy',
] as const;

/** The instrument as JSON for an ENTITY_* message — a whitelist, dates as ISO text. */
export function entityData(instrument: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENTITY_FIELDS) {
    if (!(k in instrument)) continue;
    const v = instrument[k];
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  const profile = instrument.profile as { name?: unknown } | null | undefined;
  if (profile && typeof profile.name === 'string') out.profileName = profile.name;
  else if (typeof instrument.profileName === 'string') out.profileName = instrument.profileName;
  return out;
}

/** `ENTITY_CREATED` / `ENTITY_UPDATED` / `ENTITY_DELETED` for an instrument (the routes; origin `user`). */
export function emitEntity(kind: EntityMessageKind, instrument: Record<string, unknown> & { id: string }, origin: string = USER_ORIGIN): Promise<number> {
  return deliver(`entity ${kind}`, origin, () => {
    const data = entityData(instrument);
    const code = typeof data.code === 'string' ? data.code : undefined;
    return [newMessage(kind, { type: 'INSTRUMENT', id: instrument.id, ...(code ? { code } : {}) }, data, {
      ts: Date.now(),
      ...(code ? { instrumentCode: code } : {}),
      ...(typeof data.name === 'string' ? { instrumentName: data.name } : {}),
      ...(typeof data.profileName === 'string' ? { profileName: data.profileName } : {}),
    })];
  });
}
