/**
 * THE ENRICHMENT / ACTION NODES end to end (Task 5 of the rule-chains plan;
 * spec docs/superpowers/specs/2026-11-03-rule-chains-design.md §5, §7) — the
 * REAL handlers in the REAL engine singleton, the real services, debug writer
 * and job queue, on the TEST database.
 *
 * Pins:
 *   - Create alarm → an `alarms` row source RULE, metric CUSTOM, ruleSnapshot
 *     { alarmType, nodeId, chainId, details } → `Created`; a second message
 *     UPDATES that row (`Updated`, one row); eight at once open ONE (the partial
 *     unique index `alarms_active_rule_type_unique` settles the race); the
 *     Alarms list serves it and `alarmDisplayName` names it by its alarmType;
 *   - Clear alarm → `claimClear` (state CLEARED, `clearDetails`) → `Cleared`;
 *     again → `False`; with a CUSTOM clear script its details are what the
 *     Cleared message and the emitted ALARM_CLEAR carry (TB-P 2);
 *   - Save attributes → `instrument_attributes` + an INSTRUMENT_ATTRIBUTE_SET
 *     audit row by user SYSTEM naming the chain and node; with
 *     `sendAttributesUpdatedNotification` and the chain's "Re-enter" ON its
 *     ATTRIBUTES_UPDATED reaches the root chain — with the notification OFF none
 *     does; with `updateAttributesOnlyOnValueChange` OFF it lists every key while
 *     only the changed one is written and audited, and nothing changed sends nothing (TB-P 7);
 *   - Save time series over an INGEST-origin reading: skip ON → no write at
 *     all; skip OFF → written, an upsert no-op (no TELEMETRY_READING_REWRITTEN);
 *   - Delay → a `rule_engine_message` job on `rule-engine:<instrument>` with
 *     runAt ≈ now + period; at maxPendingMsgs the next message fails;
 *   - Math function ADD over two body keys → the result key;
 *   - Generator / Message count: their real lifecycle (armed by
 *     `syncLifecycles`) and real timers;
 *   - AL-1: every alarm message comes from the alarm's instrument (`metadata.alarmId`);
 *   - DP-1: ThingsBoard's v4.2 root chain + "Alarm Created" / "Alarm Cleared" branches —
 *     a real `evaluateAlarms` raise / clear leaves the Device profile on its label only; a
 *     rule node's alarm and an acknowledge pass on Success.
 *
 * Every chain here is this file's own (name prefix `T5 e2e `), one of them made
 * root for the run exactly as Task 3's e2e does (ruling T3-8): beforeAll first
 * removes a crashed run's chains and puts the seeded root back; afterAll does
 * the same, restoring Configuration → Rule Engine FIRST. Owns its super admin,
 * instrument and profile. Fake timers are for the unit tests only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Every attribute downlink the services publish, recorded and then sent on to the REAL publisher
 * (Delete attributes' `notifyDevice`, P-10). Nothing else about the downlink changes.
 */
const downlinks = vi.hoisted(() => [] as { instrumentId: string; changedKey: string | null | undefined; changedValue: string | null | undefined }[]);
vi.mock('../modules/instruments/attribute-downlink.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/instruments/attribute-downlink.js')>();
  return {
    ...real,
    publishAttributeDownlink: async (...args: Parameters<typeof real.publishAttributeDownlink>) => {
      downlinks.push({ instrumentId: args[0].instrumentId, changedKey: args[0].changedKey, changedValue: args[0].changedValue });
      return real.publishAttributeDownlink(...args);
    },
  };
});
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fromThingsboardExport, newRuleNodeConfig, parseRuleChainDocument, type RuleChainDocument } from '@digilog/shared';
import { evaluateAlarms } from '../workers/alarm-evaluation.worker.js';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { ensurePartitions } from '../workers/telemetry-partition.worker.js';
import { ruleEngine } from '../modules/rule-engine/engine.js';
import { getChain, invalidateChainCache } from '../modules/rule-engine/service.js';
import { invalidateRuleEngineConfigCache } from '../modules/rule-engine/config.js';
import { newMessage, ruleNodeOrigin, type RuleMessage } from '../modules/rule-engine/message.js';
import type { RuleTelemetryReading } from '../modules/rule-engine/services.js';
import { alarmDisplayName, loadAlarmTypeNames } from '../modules/alarms/load-type-names.js';
import { invalidateOffsetConfigCache } from '../modules/instruments/load-offsets.js';

const SEEDED = 'b1a7e000-0000-4000-8000-000000000000';
const STAMP = Date.now().toString(36);
const PREFIX = 'T5 e2e ';
const SA = `t5_sa_${STAMP}`;
const PW = 'RuleNodes@2026';
const ALARM_TYPE = `High temp ${STAMP}`;
const RACE_TYPE = `Race ${STAMP}`;
const ALARM_TYPE_2 = `Door ${STAMP}`;

let app: FastifyInstance;
let sa: Record<string, string>;
let userId: string | undefined;
let inst: { id: string; code: string; token: string } | undefined;
let engineCfgBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;
const startedAt = new Date();
const createdAlarms = new Set<string>();

interface Built { chainId: string; nodeId: string; name: string }
let ROOT: Built;
let CREATE: Built;
let RACE: Built;
let CLEAR: Built;
let ATTR: Built;
let ATTR_QUIET: Built;
let ATTR_ALL: Built;
let CREATE_2: Built;
let CLEAR_2: Built;
let DELAY: Built;
let MATH: Built;
let SAVE_HISTORY_ONLY: Built;
let SAVE_WITH_LATEST: Built;

// ─── helpers ─────────────────────────────────────────────────────────────────

async function setEngineConfig(patch: Record<string, unknown>) {
  const base = { enabled: true, skipSaveNodesForIngestOrigin: true, scriptTimeoutMs: 2000, queueCapacity: 10000, concurrency: 8,
    debugRetentionHours: 24, debugMaxEventsPerNode: 1000, httpTimeoutMs: 10000, hopLimit: 200 };
  const value = { ...base, ...patch };
  await prisma.systemConfig.upsert({
    where: { configKey: 'rule-engine' },
    update: { configValue: value as never },
    create: { configKey: 'rule-engine', configValue: value as never, configType: 'system', requiresReauth: false },
  });
  invalidateRuleEngineConfigCache();
  await ruleEngine.refreshConfig();
}

/** One chain of ONE node (debug all) — the node's config is the catalogue default with `config` over it, so the forgiving read keeps its type. */
async function makeChain(label: string, type: string, config: Record<string, unknown> = {}, reEnter = false): Promise<Built> {
  const chainId = randomUUID();
  const nodeId = randomUUID();
  const name = `${PREFIX}${label} ${STAMP}`;
  const doc: RuleChainDocument = {
    version: 1, firstNodeId: nodeId, connections: [],
    nodes: [{ id: nodeId, type, name: label, debugMode: 'all', config: { ...newRuleNodeConfig(type), ...config }, x: 0, y: 0 }],
  };
  await prisma.ruleChain.create({ data: { id: chainId, name, firstNodeId: nodeId, document: doc as never, reEnterOnRuleNodeWrites: reEnter } });
  invalidateChainCache();
  const loaded = await getChain(chainId);
  expect(loaded?.nodesById.get(nodeId)?.type, `${label} must load as ${type}, not as Unsupported`).toBe(type);
  return { chainId, nodeId, name };
}

async function dropChain(b: Built) {
  await prisma.ruleChain.deleteMany({ where: { id: b.chainId } });
  invalidateChainCache();
  await ruleEngine.syncLifecycles();
}

/** The seeded chain is the root again, and no chain of this file is left (a crashed run's included). */
async function restoreSeededRoot() {
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE root AND id <> ${SEEDED}::uuid`,
    prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${SEEDED}::uuid`,
    prisma.$executeRaw`DELETE FROM rule_chains WHERE name LIKE ${`${PREFIX}%`}`,
  ]);
  invalidateChainCache();
}

type DebugRow = { node_id: string; direction: string; relation: string | null; msg_id: string; msg_type: string; originator_id: string; data: any; metadata: any; error: string | null };
/** `alarmId`: an alarm message's `metadata.alarmId` — since ruling AL-1 its ORIGINATOR is the alarm's instrument. */
type Where = { msgType?: string; originatorId?: string; msgId?: string; direction?: 'IN' | 'OUT'; alarmId?: string };

const rows = (chainId: string, where: Where = {}) => prisma.$queryRaw<DebugRow[]>`
  SELECT node_id::text, direction, relation, msg_id, msg_type, originator_id, data, metadata, error
  FROM rule_node_debug_events
  WHERE chain_id = ${chainId}::uuid AND ts >= ${startedAt}
    AND (${where.msgType ?? null}::text IS NULL OR msg_type = ${where.msgType ?? null})
    AND (${where.originatorId ?? null}::text IS NULL OR originator_id = ${where.originatorId ?? null})
    AND (${where.msgId ?? null}::text IS NULL OR msg_id = ${where.msgId ?? null})
    AND (${where.direction ?? null}::text IS NULL OR direction = ${where.direction ?? null})
    AND (${where.alarmId ?? null}::text IS NULL OR metadata ->> 'alarmId' = ${where.alarmId ?? null})
  ORDER BY id`;

async function waitForRows(chainId: string, where: Where, atLeast: number, ms = 3_000): Promise<DebugRow[]> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await rows(chainId, where);
    if (found.length >= atLeast || Date.now() > until) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A message from the fixture instrument, as an injected (not ingest) one. */
const instMsg = (type: string, data: unknown, metadata: Record<string, unknown> = {}): RuleMessage =>
  newMessage(type, { type: 'INSTRUMENT', id: inst!.id, code: inst!.code }, data, { rule_engine_origin: 'rest_api', ...metadata });

const ingest = (body: unknown) => app.inject({ method: 'POST', url: '/api/ingest/v1/telemetry', headers: { authorization: `Bearer ${inst!.token}` }, payload: body as never });

const activeRule = (type: string) => prisma.alarm.findMany({
  where: { instrumentId: inst!.id, source: 'RULE', state: 'ACTIVE', ruleSnapshot: { path: ['alarmType'], equals: type } },
});

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = await buildApp();
  await ensurePartitions(1);
  await restoreSeededRoot();
  expect(await prisma.ruleChain.count({ where: { id: SEEDED, root: true } }), 'the seeded root chain must exist').toBe(1);
  const cfgRow = await prisma.systemConfig.findUnique({ where: { configKey: 'rule-engine' } });
  engineCfgBefore = cfgRow ? { configValue: cfgRow.configValue, configType: cfgRow.configType, requiresReauth: cfgRow.requiresReauth } : null;
  invalidateOffsetConfigCache();

  const u = await prisma.user.create({
    data: { username: SA, fullName: SA, role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false },
  });
  userId = u.id;
  sa = { authorization: `Bearer ${await loginAs(app, SA, PW)}` };

  ROOT = await makeChain('root save-timeseries', 'tb:action:save-timeseries');
  CREATE = await makeChain('create-alarm', 'tb:action:create-alarm', { alarmType: ALARM_TYPE, severity: 'MAJOR', alarmDetailsBuildJs: 'return { t: msg.t };' });
  RACE = await makeChain('create-alarm race', 'tb:action:create-alarm', { alarmType: RACE_TYPE, severity: 'MINOR' });
  CLEAR = await makeChain('clear-alarm', 'tb:action:clear-alarm', { alarmType: ALARM_TYPE });
  ATTR = await makeChain('save-attributes', 'tb:action:save-attributes', { sendAttributesUpdatedNotification: true }, true);
  // TB-P 7: ThingsBoard's default (notification off) sends nothing, Re-enter or not.
  ATTR_QUIET = await makeChain('save-attributes quiet', 'tb:action:save-attributes', {}, true);
  ATTR_ALL = await makeChain('save-attributes all keys', 'tb:action:save-attributes',
    { sendAttributesUpdatedNotification: true, updateAttributesOnlyOnValueChange: false }, true);
  // TB-P 2: a CUSTOM clear script (the shipped one returns the previous details, so it cannot show the gap).
  CREATE_2 = await makeChain('create-alarm 2', 'tb:action:create-alarm', { alarmType: ALARM_TYPE_2, severity: 'MINOR', alarmDetailsBuildJs: 'return { raisedAt: msg.t };' });
  CLEAR_2 = await makeChain('clear-alarm 2', 'tb:action:clear-alarm', { alarmType: ALARM_TYPE_2, alarmDetailsBuildJs: 'return { closedAt: msg.t };' }, true);
  DELAY = await makeChain('delay', 'tb:action:delay', { periodInSeconds: 120, maxPendingMsgs: 1 });
  MATH = await makeChain('math-function', 'tb:action:math-function', {
    operation: 'ADD', arguments: [{ name: 'a', type: 'MESSAGE_BODY', key: 'a' }, { name: 'b', type: 'MESSAGE_BODY', key: 'b' }],
    result: { type: 'MESSAGE_BODY', key: 'sum', resultValuePrecision: 2 },
  });
  SAVE_HISTORY_ONLY = await makeChain('save-timeseries history only', 'tb:action:save-timeseries', { skipLatestPersistence: true });
  SAVE_WITH_LATEST = await makeChain('save-timeseries with latest', 'tb:action:save-timeseries');
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE id = ${SEEDED}::uuid`,
    prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${ROOT.chainId}::uuid`,
  ]);
  invalidateChainCache();
  await setEngineConfig({});
  await ruleEngine.start();

  const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: sa,
    payload: { profileId: await fixtureProfileId('fixture:rule-engine-nodes'), name: `T5 ${STAMP}`, code: `T5-${STAMP}` } });
  expect(res.statusCode, res.body).toBe(201);
  inst = res.json();
});

afterAll(async () => {
  try { await ruleEngine.stop(); } catch (e) { console.error('engine stop', e); }
  // Configuration → Rule Engine back FIRST, whatever else fails.
  try {
    if (engineCfgBefore) await prisma.systemConfig.update({ where: { configKey: 'rule-engine' }, data: engineCfgBefore as never });
    else if (engineCfgBefore === null) await prisma.systemConfig.deleteMany({ where: { configKey: 'rule-engine' } });
  } catch (e) { console.error('restore rule-engine config', e); }
  invalidateRuleEngineConfigCache();
  // The seeded root back, every chain of this file deleted (their debug rows cascade).
  try { await restoreSeededRoot(); } catch (e) { console.error('restore seeded root', e); }
  if (inst) {
    try {
      await prisma.$executeRaw`DELETE FROM graphile_worker._private_jobs j USING graphile_worker._private_job_queues q
        WHERE j.job_queue_id = q.id AND q.queue_name = ${`rule-engine:${inst.id}`}`;
    } catch (e) { console.error('job cleanup', e); }
    try {
      for (const a of await prisma.alarm.findMany({ where: { instrumentId: inst.id }, select: { id: true } })) createdAlarms.add(a.id);
    } catch (e) { console.error('alarm list', e); }
  }
  // The notification / webhook jobs those alarms enqueued (no job runner in the e2e app).
  for (const alarmId of createdAlarms) {
    try {
      await prisma.$executeRaw`DELETE FROM graphile_worker._private_jobs j USING graphile_worker._private_tasks t
        WHERE j.task_id = t.id AND t.identifier IN ('notification', 'alarm_webhook') AND j.payload::text LIKE ${`%${alarmId}%`}`;
    } catch (e) { console.error('job cleanup', e); }
  }
  if (inst) {
    try { await prisma.alarm.deleteMany({ where: { instrumentId: inst.id } }); } catch (e) { console.error('alarm cleanup', e); }
    try { await prisma.deadLetter.deleteMany({ where: { instrumentId: inst.id } }); } catch (e) { console.error(e); }
    try { await app.inject({ method: 'DELETE', url: `/api/instruments/${inst.id}`, headers: sa }); } catch (e) { console.error(e); }
  }
  if (userId) {
    try {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } catch (e) { console.error('user cleanup', e); }
  }
  await app.close();
});

// ─── Create alarm / Clear alarm ─────────────────────────────────────────────

describe('Create alarm and Clear alarm', () => {
  it('creates a RULE alarm: source RULE, metric CUSTOM, ruleSnapshot { alarmType, nodeId, chainId, details } → Created', async () => {
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 30 }), { chainId: CREATE.chainId });
    const open = await activeRule(ALARM_TYPE);
    expect(open).toHaveLength(1);
    createdAlarms.add(open[0].id);
    expect(open[0]).toMatchObject({ source: 'RULE', metric: 'CUSTOM', severity: 'MAJOR', state: 'ACTIVE', limitKind: null, triggeredValue: null });
    expect(open[0].ruleSnapshot).toEqual({ alarmType: ALARM_TYPE, nodeId: CREATE.nodeId, chainId: CREATE.chainId, details: { t: 30 } });
    const [out] = await waitForRows(CREATE.chainId, { direction: 'OUT' }, 1);
    expect(out).toMatchObject({ relation: 'Created (unconnected)', msg_type: 'ALARM' });
    expect(out.metadata.isNewAlarm).toBe('true');
    expect(out.data).toMatchObject({ id: open[0].id, type: ALARM_TYPE, status: 'ACTIVE_UNACK', severity: 'MAJOR', source: 'RULE', metric: 'CUSTOM' });
  });

  it('a second message UPDATES the open alarm — still one row, details replaced → Updated', async () => {
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 31 }), { chainId: CREATE.chainId });
    const open = await activeRule(ALARM_TYPE);
    expect(open).toHaveLength(1);
    expect((open[0].ruleSnapshot as { details: unknown }).details).toEqual({ t: 31 });
    const out = await waitForRows(CREATE.chainId, { direction: 'OUT' }, 2);
    expect(out.map((r) => r.relation)).toEqual(['Created (unconnected)', 'Updated (unconnected)']);
    expect(out[1].metadata.isExistingAlarm).toBe('true');
  });

  it('the Alarms list serves it as RULE / CUSTOM, and it is announced under its alarmType', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/alarms?instrumentId=${inst!.id}`, headers: sa });
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json() as { data: { source: string; metric: string; limitKind: string | null; ruleSnapshot: { alarmType?: string } }[] }).data
      .find((a) => a.ruleSnapshot?.alarmType === ALARM_TYPE);
    expect(row, 'the RULE alarm is on the Alarms list').toBeDefined();
    expect(row).toMatchObject({ source: 'RULE', metric: 'CUSTOM' });
    const names = await loadAlarmTypeNames();
    expect(alarmDisplayName(names, row!.source, row!.metric, row!.limitKind, row!.ruleSnapshot)).toBe(ALARM_TYPE);
  });

  it('Clear alarm clears it through claimClear (state CLEARED, clearDetails) → Cleared; a second clear → False', async () => {
    const [before] = await activeRule(ALARM_TYPE);
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 20 }), { chainId: CLEAR.chainId });
    const after = await prisma.alarm.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.state).toBe('CLEARED');
    expect(after.clearedAt).not.toBeNull();
    // The shipped details script returns the alarm's own details (metadata.prevAlarmDetails).
    expect((after.ruleSnapshot as { clearDetails: unknown }).clearDetails).toEqual({ t: 31 });
    const [cleared] = await waitForRows(CLEAR.chainId, { direction: 'OUT' }, 1);
    expect(cleared).toMatchObject({ relation: 'Cleared (unconnected)', msg_type: 'ALARM' });
    expect(cleared.metadata.isClearedAlarm).toBe('true');
    expect(cleared.data).toMatchObject({ id: before.id, cleared: true, status: 'CLEARED_UNACK' });
    // Re-enter is OFF for this chain: its ALARM_CLEAR carries the node's origin (REQUIRED, review item 5)
    // and the loop guard holds it back — with a system origin it would enter the root regardless.
    // (The ON half is the TB-P 2 case below: CLEAR_2's ALARM_CLEAR does enter.)
    // AL-1: an alarm message comes from the alarm's INSTRUMENT, the alarm is metadata.alarmId.
    await new Promise((r) => setTimeout(r, 500));
    await ruleEngine.drain();
    expect(await rows(ROOT.chainId, { msgType: 'ALARM_CLEAR', originatorId: inst!.id, alarmId: before.id })).toEqual([]);
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 19 }), { chainId: CLEAR.chainId });
    const out = await waitForRows(CLEAR.chainId, { direction: 'OUT' }, 2);
    expect(out[1].relation).toBe('False (unconnected)');
  });

  it('TB-P 2: a CUSTOM clear script\'s details are what the Cleared message AND the emitted ALARM_CLEAR carry; the raise details stay recorded', async () => {
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 40 }), { chainId: CREATE_2.chainId });
    const [open] = await activeRule(ALARM_TYPE_2);
    expect(open, 'the second alarm is open').toBeDefined();
    createdAlarms.add(open.id);
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 18 }), { chainId: CLEAR_2.chainId });
    const after = await prisma.alarm.findUniqueOrThrow({ where: { id: open.id } });
    expect(after.state).toBe('CLEARED');
    expect(after.ruleSnapshot).toMatchObject({ details: { raisedAt: 40 }, clearDetails: { closedAt: 18 } });
    const [cleared] = await waitForRows(CLEAR_2.chainId, { direction: 'OUT' }, 1);
    expect(cleared).toMatchObject({ relation: 'Cleared (unconnected)', msg_type: 'ALARM' });
    expect(cleared.data.details).toEqual({ closedAt: 18 });
    // Re-enter is ON for that chain: its ALARM_CLEAR enters the root chain carrying the same details.
    // From the alarm's INSTRUMENT (ruling AL-1), the alarm in metadata.alarmId and the data.
    const [entered] = await waitForRows(ROOT.chainId, { msgType: 'ALARM_CLEAR', originatorId: inst!.id, alarmId: open.id, direction: 'IN' }, 1);
    expect(entered, 'the ALARM_CLEAR entered the root chain').toBeDefined();
    expect(entered.data).toMatchObject({ id: open.id, cleared: true, details: { closedAt: 18 } });
  });

  it('acknowledging it fires the ACKNOWLEDGED webhook under its alarmType, not its metric (alarms/routes.ts)', async () => {
    const [alarm] = await prisma.alarm.findMany({ where: { instrumentId: inst!.id, source: 'RULE', ruleSnapshot: { path: ['alarmType'], equals: ALARM_TYPE } } });
    const res = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`,
      headers: { ...sa, 'x-reauth-password': PW }, payload: { reason: 'Rule chain alarm reviewed by the e2e' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const jobs = await prisma.$queryRaw<{ payload: { event: string; variables: { ruleName: string } } }[]>`
      SELECT j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = 'alarm_webhook' AND j.payload ->> 'alarmId' = ${alarm.id} AND j.payload ->> 'event' = 'ACKNOWLEDGED'`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.variables.ruleName).toBe(ALARM_TYPE);
    // AL-1 through the REAL acknowledge route: its ALARM_ACK (origin user) enters the root chain FROM THE
    // INSTRUMENT, the alarm in metadata.alarmId and the data — as ThingsBoard's ack (alarm.getOriginator()).
    const [ack] = await waitForRows(ROOT.chainId, { msgType: 'ALARM_ACK', alarmId: alarm.id, direction: 'IN' }, 1);
    expect(ack, 'the ALARM_ACK entered the root chain').toBeDefined();
    expect(ack.originator_id).toBe(inst!.id);
    expect(ack.metadata).toMatchObject({ alarmId: alarm.id, acknowledgedBy: SA, rule_engine_origin: 'user', instrumentCode: inst!.code });
    expect(ack.data).toMatchObject({ id: alarm.id, acknowledged: true });
  });

  it('eight Create alarm messages AT ONCE open ONE alarm (the partial unique index settles the race)', async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => instMsg('POST_TELEMETRY_REQUEST', { i }));
    await Promise.all(msgs.map((m) => ruleEngine.processNow(m, { chainId: RACE.chainId })));
    const open = await activeRule(RACE_TYPE);
    for (const a of open) createdAlarms.add(a.id);
    expect(open).toHaveLength(1);
    const out = await waitForRows(RACE.chainId, { direction: 'OUT' }, 8);
    expect(out).toHaveLength(8);
    expect(out.filter((r) => r.relation === 'Created (unconnected)')).toHaveLength(1);
    expect(out.filter((r) => r.relation === 'Updated (unconnected)')).toHaveLength(7);
  });
});

// ─── Save attributes ─────────────────────────────────────────────────────────

describe('Save attributes', () => {
  const value = `2.${STAMP}`;

  it('writes instrument_attributes and audits it as SYSTEM naming the chain and node; with Re-enter ON its ATTRIBUTES_UPDATED reaches the root', async () => {
    await ruleEngine.processNow(instMsg('POST_ATTRIBUTES_REQUEST', { fw: value }), { chainId: ATTR.chainId });
    const attr = await prisma.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId: inst!.id, key: 'fw' } } });
    expect(attr?.value).toBe(value);
    const audits = await prisma.auditTrail.findMany({ where: { action: 'INSTRUMENT_ATTRIBUTE_SET', targetId: inst!.id }, orderBy: { timestamp: 'asc' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: 'SYSTEM', userRole: 'SYSTEM', reason: `Written by rule chain "${ATTR.name}" node "save-attributes"` });
    expect(audits[0].afterValue).toMatchObject({ code: inst!.code, attribute: 'fw', value });
    const [out] = await waitForRows(ATTR.chainId, { direction: 'OUT' }, 1);
    expect(out.relation).toBe('Success (unconnected)');

    const [entered] = await waitForRows(ROOT.chainId, { msgType: 'ATTRIBUTES_UPDATED', originatorId: inst!.id, direction: 'IN' }, 1);
    expect(entered, 'the ATTRIBUTES_UPDATED message entered the root chain').toBeDefined();
    expect(entered.data).toEqual({ fw: value });
    expect(entered.metadata.scope).toBe('SERVER_SCOPE');
    expect(entered.metadata.rule_engine_origin).toBe(ruleNodeOrigin(ATTR.chainId, ATTR.nodeId));
  });

  it('the same value again is neither re-written nor re-audited', async () => {
    await ruleEngine.processNow(instMsg('POST_ATTRIBUTES_REQUEST', { fw: value }), { chainId: ATTR.chainId });
    expect(await prisma.auditTrail.count({ where: { action: 'INSTRUMENT_ATTRIBUTE_SET', targetId: inst!.id } })).toBe(1);
  });

  const audits = () => prisma.auditTrail.count({ where: { action: 'INSTRUMENT_ATTRIBUTE_SET', targetId: inst!.id } });
  const updatedAtRoot = (atLeast: number, ms?: number) =>
    waitForRows(ROOT.chainId, { msgType: 'ATTRIBUTES_UPDATED', originatorId: inst!.id, direction: 'IN' }, atLeast, ms);

  it('TB-P 7: notification OFF (ThingsBoard\'s default) — written and audited, but NO Attributes Updated message, even with Re-enter ON', async () => {
    const before = await audits();
    await ruleEngine.processNow(instMsg('POST_ATTRIBUTES_REQUEST', { quiet: value }), { chainId: ATTR_QUIET.chainId });
    expect((await prisma.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId: inst!.id, key: 'quiet' } } }))?.value).toBe(value);
    expect(await audits()).toBe(before + 1);
    const [out] = await waitForRows(ATTR_QUIET.chainId, { direction: 'OUT' }, 1);
    expect(out.relation).toBe('Success (unconnected)');
    // Give a message time to arrive, then: none naming `quiet` entered the root.
    const entered = await updatedAtRoot(999, 1_500);
    expect(entered.some((r) => r.data && 'quiet' in r.data)).toBe(false);
  });

  it('TB-P 7: updateAttributesOnlyOnValueChange OFF — the message lists EVERY key, only the changed one is written and audited; nothing changed → no message', async () => {
    const site = `QC ${STAMP}`;
    const before = await audits();
    const rowsBefore = (await updatedAtRoot(0, 0)).length;
    await ruleEngine.processNow(instMsg('POST_ATTRIBUTES_REQUEST', { fw: value, site }), { chainId: ATTR_ALL.chainId });
    expect(await audits(), 'site written; fw (unchanged) is not re-written or audited').toBe(before + 1);
    const got = await updatedAtRoot(rowsBefore + 1);
    expect(got).toHaveLength(rowsBefore + 1);
    expect(got[rowsBefore].data).toEqual({ fw: value, site });
    expect(got[rowsBefore].metadata.rule_engine_origin).toBe(ruleNodeOrigin(ATTR_ALL.chainId, ATTR_ALL.nodeId));
    // The same message again changes nothing: no write, no audit, and NO message (re-entry stays bounded).
    await ruleEngine.processNow(instMsg('POST_ATTRIBUTES_REQUEST', { fw: value, site }), { chainId: ATTR_ALL.chainId });
    expect(await audits()).toBe(before + 1);
    expect(await updatedAtRoot(rowsBefore + 2, 1_500)).toHaveLength(rowsBefore + 1);
  });
});

// ─── Delete attributes: its two toggles (P-10) ──────────────────────────────

describe('Delete attributes — its two toggles honoured as ThingsBoard\'s, default OFF (P-10)', () => {
  const quietKey = `delq_${STAMP}`;
  const loudKey = `dell_${STAMP}`;
  let DEL_QUIET: Built;
  let DEL_LOUD: Built;
  /** The ATTRIBUTES_DELETED messages naming `key` that entered the root — waiting until `atLeast` (or the time is up). */
  async function deletedAtRoot(key: string, atLeast = 999, ms = 1_500) {
    const until = Date.now() + ms;
    for (;;) {
      const found = (await rows(ROOT.chainId, { msgType: 'ATTRIBUTES_DELETED', originatorId: inst!.id, direction: 'IN' }))
        .filter((r) => Array.isArray(r.data?.attributes) && r.data.attributes.includes(key));
      if (found.length >= atLeast || Date.now() > until) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const toldAbout = (key: string) => downlinks.filter((d) => d.instrumentId === inst!.id && d.changedKey === key);
  const seed = (key: string) => prisma.instrumentAttribute.upsert({
    where: { instrumentId_key: { instrumentId: inst!.id, key } }, create: { instrumentId: inst!.id, key, value: 'v' }, update: { value: 'v' },
  });

  beforeAll(async () => {
    // Re-enter ON for both: a message they send WOULD reach the root, so its absence is the toggle's doing.
    DEL_QUIET = await makeChain('delete-attributes defaults', 'tb:action:delete-attributes', { keys: [quietKey] }, true);
    DEL_LOUD = await makeChain('delete-attributes toggles on', 'tb:action:delete-attributes',
      { keys: [loudKey, `missing_${STAMP}`], sendAttributesDeletedNotification: true, notifyDevice: true }, true);
  });

  it('defaults (both OFF, as ThingsBoard): removed and audited as SYSTEM — but NO Attributes Deleted message and the instrument NOT told', async () => {
    await seed(quietKey);
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 1 }), { chainId: DEL_QUIET.chainId });
    expect(await prisma.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId: inst!.id, key: quietKey } } })).toBeNull();
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetId: inst!.id, beforeValue: { path: ['attribute'], equals: quietKey } } });
    expect(audit).toMatchObject({ userId: 'SYSTEM', userRole: 'SYSTEM', reason: `Removed by rule chain "${DEL_QUIET.name}" node "delete-attributes defaults"` });
    expect((await waitForRows(DEL_QUIET.chainId, { direction: 'OUT' }, 1))[0].relation).toBe('Success (unconnected)');
    expect(await deletedAtRoot(quietKey)).toEqual([]);
    expect(toldAbout(quietKey)).toEqual([]);
  });

  it('metadata.notifyDevice = "true" tells the instrument even with the toggle OFF (ThingsBoard\'s checkNotifyDevice) — still no message', async () => {
    await seed(quietKey);
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 1 }, { notifyDevice: 'true' }), { chainId: DEL_QUIET.chainId });
    expect(toldAbout(quietKey)).toEqual([{ instrumentId: inst!.id, changedKey: quietKey, changedValue: null }]);
    expect(await deletedAtRoot(quietKey)).toEqual([]);
  });

  it('both ON: the Attributes Deleted message names ONLY the key removed and reaches the root; the instrument is told; nothing left to remove → neither', async () => {
    await seed(loudKey);
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 1 }), { chainId: DEL_LOUD.chainId });
    const [entered] = await deletedAtRoot(loudKey, 1, 3_000);
    expect(entered, 'the Attributes Deleted message entered the root chain').toBeDefined();
    expect(entered.data).toEqual({ attributes: [loudKey] });
    expect(entered.metadata.rule_engine_origin).toBe(ruleNodeOrigin(DEL_LOUD.chainId, DEL_LOUD.nodeId));
    expect(toldAbout(loudKey)).toEqual([{ instrumentId: inst!.id, changedKey: loudKey, changedValue: null }]);
    // Again: nothing exists to remove — no message, no downlink (re-entry stays bounded).
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { t: 2 }), { chainId: DEL_LOUD.chainId });
    expect(await deletedAtRoot(loudKey)).toHaveLength(1);
    expect(toldAbout(loudKey)).toHaveLength(1);
  });
});

// ─── Save time series over an ingest-origin reading (ruling S-3) ────────────

describe('Save time series (ruling S-3)', () => {
  type WriteCall = [string, RuleTelemetryReading[], string, { skipLatest?: boolean } | undefined];
  /** Every `telemetry.write` the engine's services make for the fixture instrument, while `fn` runs. */
  async function countingWrites(fn: () => Promise<void>): Promise<WriteCall[]> {
    const svc = ruleEngine.services.telemetry;
    const original = svc.write;
    const calls: WriteCall[] = [];
    svc.write = async (id, readings, origin, opts) => {
      if (id === inst!.id) calls.push([id, readings, origin, opts]);
      return original.call(svc, id, readings, origin, opts);
    };
    try {
      await fn();
    } finally {
      svc.write = original;
    }
    return calls;
  }

  it('skip ON: the stored reading reaches Save time series and is NOT written again; it passes on Success', async () => {
    await setEngineConfig({ skipSaveNodesForIngestOrigin: true });
    const ts = Date.now() - 8_000;
    const calls = await countingWrites(async () => {
      expect((await ingest({ ts, temp: 21.5 })).statusCode).toBe(200);
      const out = await waitForRows(ROOT.chainId, { msgType: 'POST_TELEMETRY_REQUEST', originatorId: inst!.id, direction: 'OUT' }, 1);
      expect(out.map((r) => r.relation)).toEqual(['Success (unconnected)']);
      expect(out[0].metadata.rule_engine_origin).toBe('ingest');
    });
    expect(calls).toEqual([]);
  });

  it('skip OFF: it IS written through the ingest write path — an upsert no-op: same value, no TELEMETRY_READING_REWRITTEN', async () => {
    await setEngineConfig({ skipSaveNodesForIngestOrigin: false });
    const ts = Date.now() - 6_000;
    const before = (await rows(ROOT.chainId, { msgType: 'POST_TELEMETRY_REQUEST', originatorId: inst!.id, direction: 'OUT' })).length;
    const calls = await countingWrites(async () => {
      expect((await ingest({ ts, temp: 22.5 })).statusCode).toBe(200);
      const out = await waitForRows(ROOT.chainId, { msgType: 'POST_TELEMETRY_REQUEST', originatorId: inst!.id, direction: 'OUT' }, before + 1);
      expect(out.slice(before).map((r) => r.relation)).toEqual(['Success (unconnected)']);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([{ key: 'temp', value: 22.5, ts: new Date(ts) }]);
    expect(calls[0][2]).toBe(ruleNodeOrigin(ROOT.chainId, ROOT.nodeId));
    expect(calls[0][3]).toEqual({ skipLatest: false });
    expect(await prisma.auditTrail.count({ where: { action: 'TELEMETRY_READING_REWRITTEN', targetId: inst!.id } })).toBe(0);
    const stored = await prisma.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM instrument_telemetry_history WHERE instrument_id = ${inst!.id} AND key = 'temp' AND ts = ${new Date(ts)}`;
    expect(stored.map((s) => s.value)).toEqual([22.5]);
    await setEngineConfig({ skipSaveNodesForIngestOrigin: true });
  });

  it('skipLatestPersistence writes history ONLY; without it the latest readings move too', async () => {
    const ts = Date.now() - 4_000;
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { histOnly: 7 }, { ts: String(ts) }), { chainId: SAVE_HISTORY_ONLY.chainId });
    await ruleEngine.processNow(instMsg('POST_TELEMETRY_REQUEST', { withLatest: 8 }, { ts: String(ts) }), { chainId: SAVE_WITH_LATEST.chainId });
    const history = await prisma.$queryRaw<{ key: string; value: unknown }[]>`
      SELECT key, value FROM instrument_telemetry_history
      WHERE instrument_id = ${inst!.id} AND key IN ('histOnly', 'withLatest') AND ts = ${new Date(ts)} ORDER BY key`;
    expect(history).toEqual([{ key: 'histOnly', value: 7 }, { key: 'withLatest', value: 8 }]);
    const latest = await prisma.$queryRaw<{ key: string }[]>`
      SELECT key FROM instrument_telemetry_latest WHERE instrument_id = ${inst!.id} AND key IN ('histOnly', 'withLatest') ORDER BY key`;
    expect(latest.map((r) => r.key)).toEqual(['withLatest']);
  });
});

// ─── Delay ───────────────────────────────────────────────────────────────────

describe('Delay (durable)', () => {
  type Job = { run_at: Date; payload: any; queue_name: string };
  const jobs = () => prisma.$queryRaw<Job[]>`
    SELECT j.run_at, j.payload, q.queue_name
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
    WHERE t.identifier = 'rule_engine_message' AND j.payload ->> 'chainId' = ${DELAY.chainId}`;

  it('hands the message to a rule_engine_message job on rule-engine:<instrument> at now + period; nothing goes out now', async () => {
    const msg = instMsg('POST_TELEMETRY_REQUEST', { x: 1 });
    const before = Date.now();
    await ruleEngine.processNow(msg, { chainId: DELAY.chainId });
    const found = await jobs();
    expect(found).toHaveLength(1);
    expect(found[0].queue_name).toBe(`rule-engine:${inst!.id}`);
    expect(found[0].payload).toMatchObject({ chainId: DELAY.chainId, resumeAfterNodeId: DELAY.nodeId, message: { id: msg.id, type: 'POST_TELEMETRY_REQUEST', data: { x: 1 } } });
    const delayMs = new Date(found[0].run_at).getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(119_000);
    expect(delayMs).toBeLessThanOrEqual(125_000);
    await waitForRows(DELAY.chainId, { msgId: msg.id, direction: 'IN' }, 1);
    expect(await rows(DELAY.chainId, { msgId: msg.id, direction: 'OUT' })).toEqual([]);
  });

  it('with maxPendingMsgs (1) already waiting at the node, the next message fails (counted in the job table)', async () => {
    const msg = instMsg('POST_TELEMETRY_REQUEST', { x: 2 });
    await ruleEngine.processNow(msg, { chainId: DELAY.chainId });
    const [out] = await waitForRows(DELAY.chainId, { msgId: msg.id, direction: 'OUT' }, 1);
    expect(out).toMatchObject({ relation: 'Failure (unhandled)', error: 'Max limit of pending messages reached!' });
    expect(await jobs()).toHaveLength(1);
  });
});

// ─── Math function ───────────────────────────────────────────────────────────

describe('Math function', () => {
  it('ADD of two message-body keys → the result key in the body', async () => {
    const msg = instMsg('POST_TELEMETRY_REQUEST', { a: 2, b: 3.255 });
    await ruleEngine.processNow(msg, { chainId: MATH.chainId });
    const [out] = await waitForRows(MATH.chainId, { msgId: msg.id, direction: 'OUT' }, 1);
    expect(out.relation).toBe('Success (unconnected)');
    expect(out.data).toEqual({ a: 2, b: 3.255, sum: 5.26 });
  });
});

// ─── Generator and Message count: real lifecycle, real timers ───────────────

describe('Generator and Message count (their lifecycle)', () => {
  it('Generator: armed when its chain loads, it emits the script\'s message (no msgType → GENERATOR_NODE_SELF_MSG) from the rule node', async () => {
    const gen = await makeChain('generator', 'tb:action:generator', { periodInSeconds: 1, msgCount: 1, jsScript: 'return { msg: { hello: 1 } };' });
    try {
      await ruleEngine.syncLifecycles({ force: true });
      const out = await waitForRows(gen.chainId, { direction: 'OUT' }, 1, 4_000);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ msg_type: 'GENERATOR_NODE_SELF_MSG', originator_id: gen.nodeId, relation: 'Success (unconnected)', data: { hello: 1 } });
      await new Promise((r) => setTimeout(r, 1_600));
      expect(await rows(gen.chainId, { direction: 'OUT' }), 'msgCount 1: one message only').toHaveLength(1);
    } finally {
      await dropChain(gen);
    }
  });

  it('Message count: what reaches it is counted and ended; each interval the count leaves from the SYSTEM', async () => {
    const mc = await makeChain('message-count', 'tb:action:message-count', { interval: 1, telemetryPrefix: 'mc' });
    try {
      await ruleEngine.syncLifecycles({ force: true });
      const sent = [instMsg('POST_TELEMETRY_REQUEST', { n: 1 }), instMsg('POST_TELEMETRY_REQUEST', { n: 2 })];
      for (const m of sent) await ruleEngine.processNow(m, { chainId: mc.chainId });
      const key = `mc_${mc.nodeId}`;
      const until = Date.now() + 4_000;
      let ticks: DebugRow[] = [];
      while (Date.now() < until) {
        ticks = await rows(mc.chainId, { direction: 'OUT', originatorId: 'SYSTEM' });
        if (ticks.reduce((s, r) => s + Number(r.data?.[key] ?? 0), 0) >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(ticks.reduce((s, r) => s + Number(r.data?.[key] ?? 0), 0)).toBe(2);
      for (const t of ticks) expect(t).toMatchObject({ msg_type: 'POST_TELEMETRY_REQUEST', relation: 'Success (unconnected)' });
      for (const m of sent) expect(await rows(mc.chainId, { msgId: m.id, direction: 'OUT' })).toEqual([]);
    } finally {
      await dropChain(mc);
    }
  });
});

// ─── Device profile on ThingsBoard's own root chain (ruling DP-1) ──────────

/**
 * Ruling DP-1 on the REAL Device profile handler, in the running engine: ThingsBoard's v4.2
 * root chain (the import fixture, byte for byte from tag v4.2) with an "Alarm Created" and an
 * "Alarm Cleared" connection added from its Device profile node — neither ThingsBoard fixture
 * wires one — made root for this block. The evaluator's raise and clear (a real `evaluateAlarms`
 * pass on this block's own instrument, origin `system`) leave on their label ONLY; a rule node's
 * alarm (isNewAlarm, origin `rule_node:…`) and the acknowledge route's ALARM_ACK (origin `user`)
 * pass on Success. Owns its instrument, profile, chains and the `alarm-limits` row (restored FIRST).
 */
describe('Device profile routes as ThingsBoard\'s does (ruling DP-1) — ThingsBoard\'s v4.2 root chain + "Alarm Created" / "Alarm Cleared" branches', () => {
  type CfgRow = { configValue: unknown; configType: string; requiresReauth: boolean } | null;
  let limitsBefore: CfgRow | undefined;
  let dpChain = '';
  let profileNode = '';
  let switchNode = '';
  let onCreated = '';
  let onCleared = '';
  let dpInst: { id: string; code: string } | undefined;
  let ruleCreate: Built;
  let evaluatorAlarm = '';
  const dpAlarms = new Set<string>();

  /** A reading the limit pass judges: the latest table and last-seen, as instrument-limit-alarms.e2e writes them. */
  async function pushReading(value: number) {
    const instrumentId = dpInst!.id;
    await prisma.instrumentTelemetryLatest.upsert({
      where: { instrumentId_key: { instrumentId, key: 'temperature' } },
      create: { instrumentId, key: 'temperature', value, valueType: 'number', ts: new Date() },
      update: { value, valueType: 'number', ts: new Date() },
    });
    await prisma.instrument.update({ where: { id: instrumentId }, data: { lastSeenAt: new Date() } });
  }

  const ofNode = (list: DebugRow[], nodeId: string, direction: 'IN' | 'OUT') => list.filter((r) => r.node_id === nodeId && r.direction === direction);

  /** Rows of ONE node matching `where`, waiting until there are `atLeast` (or the time is up). */
  async function waitForNode(where: Where, nodeId: string, direction: 'IN' | 'OUT', atLeast = 1, ms = 3_000): Promise<DebugRow[]> {
    const until = Date.now() + ms;
    for (;;) {
      const found = ofNode(await rows(dpChain, where), nodeId, direction);
      if (found.length >= atLeast || Date.now() > until) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const activeRuleOf = (instrumentId: string, type: string) => prisma.alarm.findMany({
    where: { instrumentId, source: 'RULE', state: 'ACTIVE', ruleSnapshot: { path: ['alarmType'], equals: type } },
  });

  beforeAll(async () => {
    // The ONE administered value the limit pass reads (memory: a test that reads config pins it).
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
    limitsBefore = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
    const enabled = { ...((row?.configValue ?? {}) as Record<string, unknown>), enabled: true };
    await prisma.systemConfig.upsert({
      where: { configKey: 'alarm-limits' }, update: { configValue: enabled as never },
      create: { configKey: 'alarm-limits', configValue: enabled as never, configType: 'system', requiresReauth: false },
    });

    const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: sa,
      payload: { profileId: await fixtureProfileId('fixture:rule-engine-dp1'), name: `T5 DP ${STAMP}`, code: `T5-DP-${STAMP}` } });
    expect(res.statusCode, res.body).toBe(201);
    dpInst = res.json();
    await prisma.instrumentAttribute.createMany({ data: [
      { instrumentId: dpInst!.id, key: 'High Temperature Limit', value: '25' },
      { instrumentId: dpInst!.id, key: 'Low Temperature Limit', value: '18' },
    ] });

    const fixture = readFileSync(new URL('../modules/rule-engine/__tests__/fixtures/thingsboard-root-chain-4.2.json', import.meta.url), 'utf8');
    const imported = fromThingsboardExport(JSON.parse(fixture));
    const profile = imported.document.nodes.find((n) => n.type === 'tb:action:device-profile');
    const sw = imported.document.nodes.find((n) => n.type === 'tb:filter:message-type-switch');
    expect(profile, 'the v4.2 root chain enters through a Device profile node').toBeDefined();
    expect(sw).toBeDefined();
    expect(imported.document.firstNodeId).toBe(profile!.id);
    // Neither ThingsBoard fixture wires an alarm label: Device profile → switch on Success only.
    expect(imported.document.connections.filter((c) => c.from === profile!.id).map((c) => c.relation)).toEqual(['Success']);
    profileNode = profile!.id;
    switchNode = sw!.id;
    onCreated = randomUUID();
    onCleared = randomUUID();
    const log = (id: string, name: string) => ({ id, type: 'tb:action:log', name, debugMode: 'all' as const, config: newRuleNodeConfig('tb:action:log'), x: 0, y: 0 });
    const doc = parseRuleChainDocument({
      ...imported.document,
      nodes: [
        ...imported.document.nodes.map((n) => (n.id === profileNode || n.id === switchNode ? { ...n, debugMode: 'all' } : n)),
        log(onCreated, 'On Alarm Created'), log(onCleared, 'On Alarm Cleared'),
      ],
      connections: [
        ...imported.document.connections,
        { from: profileNode, to: onCreated, relation: 'Alarm Created' },
        { from: profileNode, to: onCleared, relation: 'Alarm Cleared' },
      ],
    });
    dpChain = randomUUID();
    await prisma.ruleChain.create({ data: { id: dpChain, name: `${PREFIX}DP-1 ThingsBoard 4.2 ${STAMP}`, firstNodeId: doc.firstNodeId, document: doc as never } });
    // A rule node's alarm reaches the root only while ITS chain says "Re-enter on rule-node writes".
    ruleCreate = await makeChain('dp-1 rule alarm', 'tb:action:create-alarm', { alarmType: `DP rule ${STAMP}`, severity: 'MINOR' }, true);
    await prisma.$transaction([
      prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE id = ${ROOT.chainId}::uuid`,
      prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${dpChain}::uuid`,
    ]);
    invalidateChainCache();
    expect((await getChain(dpChain))?.nodesById.get(profileNode)?.type).toBe('tb:action:device-profile');
  });

  afterAll(async () => {
    try {
      if (limitsBefore) await prisma.systemConfig.update({ where: { configKey: 'alarm-limits' }, data: limitsBefore as never });
      else if (limitsBefore === null) await prisma.systemConfig.deleteMany({ where: { configKey: 'alarm-limits' } });
    } catch (e) { console.error('restore alarm-limits', e); }
    try {
      await prisma.$transaction([
        prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE id = ${dpChain}::uuid`,
        prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${ROOT.chainId}::uuid`,
      ]);
      invalidateChainCache();
    } catch (e) { console.error('root back', e); }
    if (!dpInst) return;
    try {
      for (const a of await prisma.alarm.findMany({ where: { instrumentId: dpInst.id }, select: { id: true } })) dpAlarms.add(a.id);
    } catch (e) { console.error('dp alarm list', e); }
    for (const alarmId of dpAlarms) {
      try {
        await prisma.$executeRaw`DELETE FROM graphile_worker._private_jobs j USING graphile_worker._private_tasks t
          WHERE j.task_id = t.id AND t.identifier IN ('notification', 'alarm_webhook') AND j.payload::text LIKE ${`%${alarmId}%`}`;
      } catch (e) { console.error('dp job cleanup', e); }
    }
    try { await prisma.alarm.deleteMany({ where: { instrumentId: dpInst.id } }); } catch (e) { console.error('dp alarm cleanup', e); }
    try { await app.inject({ method: 'DELETE', url: `/api/instruments/${dpInst.id}`, headers: sa }); } catch (e) { console.error(e); }
  });

  it('the EVALUATOR\'s raise (a real limit pass) leaves the Device profile on "Alarm Created" ONLY — into that branch, never on Success', async () => {
    await pushReading(26.4);
    await evaluateAlarms();
    const [alarm] = await prisma.alarm.findMany({ where: { instrumentId: dpInst!.id, source: 'INSTRUMENT_LIMIT', state: 'ACTIVE' } });
    expect(alarm, 'the limit pass raised the HIGH alarm').toBeDefined();
    evaluatorAlarm = alarm.id;
    dpAlarms.add(alarm.id);
    expect(await waitForNode({ alarmId: alarm.id }, onCreated, 'IN'), 'the alarm reached the "Alarm Created" branch').toHaveLength(1);
    await ruleEngine.drain();
    const all = await rows(dpChain, { alarmId: alarm.id });
    const out = ofNode(all, profileNode, 'OUT');
    expect(out.map((r) => r.relation)).toEqual(['Alarm Created']);
    expect(out[0]).toMatchObject({ msg_type: 'ALARM', originator_id: dpInst!.id });
    expect(out[0].metadata).toMatchObject({ isNewAlarm: 'true', rule_engine_origin: 'system', alarmId: alarm.id });
    // On its label ONLY: the switch never saw it.
    expect(ofNode(all, switchNode, 'IN')).toEqual([]);
  });

  it('the EVALUATOR\'s clear leaves on "Alarm Cleared" ONLY, as type ALARM (ThingsBoard\'s AlarmState sends all four as ALARM)', async () => {
    await pushReading(22.0);
    await evaluateAlarms();
    expect((await prisma.alarm.findUniqueOrThrow({ where: { id: evaluatorAlarm } })).state).toBe('CLEARED');
    const reached = await waitForNode({ alarmId: evaluatorAlarm }, onCleared, 'IN');
    expect(reached, 'the clear reached the "Alarm Cleared" branch').toHaveLength(1);
    expect(reached[0].msg_type).toBe('ALARM');
    expect(reached[0].metadata).toMatchObject({ isClearedAlarm: 'true', alarmId: evaluatorAlarm });
    expect(reached[0].data).toMatchObject({ id: evaluatorAlarm, cleared: true });
    await ruleEngine.drain();
    const all = await rows(dpChain, { alarmId: evaluatorAlarm });
    expect(ofNode(all, profileNode, 'IN').map((r) => r.msg_type)).toEqual(['ALARM', 'ALARM_CLEAR']);
    expect(ofNode(all, profileNode, 'OUT').map((r) => [r.relation, r.msg_type])).toEqual([['Alarm Created', 'ALARM'], ['Alarm Cleared', 'ALARM']]);
    expect(ofNode(all, switchNode, 'IN')).toEqual([]);
  });

  it('a RULE NODE\'s alarm (isNewAlarm, origin rule_node) and the acknowledge route\'s ALARM_ACK pass on Success — never on an alarm label', async () => {
    const msg = newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: dpInst!.id, code: dpInst!.code }, { t: 1 }, { rule_engine_origin: 'rest_api' });
    await ruleEngine.processNow(msg, { chainId: ruleCreate.chainId });
    const [ruleAlarm] = await activeRuleOf(dpInst!.id, `DP rule ${STAMP}`);
    expect(ruleAlarm, 'the Create alarm node opened its alarm').toBeDefined();
    dpAlarms.add(ruleAlarm.id);
    expect(await waitForNode({ alarmId: ruleAlarm.id }, switchNode, 'IN'), 'the rule node\'s ALARM went on to the switch').toHaveLength(1);
    await ruleEngine.drain();
    const out = ofNode(await rows(dpChain, { alarmId: ruleAlarm.id }), profileNode, 'OUT');
    expect(out.map((r) => r.relation)).toEqual(['Success']);
    expect(out[0].metadata).toMatchObject({ isNewAlarm: 'true', rule_engine_origin: ruleNodeOrigin(ruleCreate.chainId, ruleCreate.nodeId) });

    const ack = await app.inject({
      method: 'POST', url: `/api/alarms/${evaluatorAlarm}/acknowledge`,
      headers: { ...sa, 'x-reauth-password': PW }, payload: { reason: 'DP-1 e2e: the excursion was reviewed' },
    });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(await waitForNode({ alarmId: evaluatorAlarm, msgType: 'ALARM_ACK' }, switchNode, 'IN'), 'the ALARM_ACK went on to the switch').toHaveLength(1);
    await ruleEngine.drain();
    const ackOut = ofNode(await rows(dpChain, { alarmId: evaluatorAlarm, msgType: 'ALARM_ACK' }), profileNode, 'OUT');
    expect(ackOut.map((r) => r.relation)).toEqual(['Success']);
    expect(ackOut[0].metadata.rule_engine_origin).toBe('user');
    // Neither reached an alarm branch.
    expect(ofNode(await rows(dpChain, { alarmId: ruleAlarm.id }), onCreated, 'IN')).toEqual([]);
    expect(ofNode(await rows(dpChain, { msgType: 'ALARM_ACK' }), onCreated, 'IN')).toEqual([]);
  });
});
