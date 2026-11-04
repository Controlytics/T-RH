/**
 * THE RULE ENGINE end to end (Task 3 of the rule-chains plan; spec
 * docs/superpowers/specs/2026-11-03-rule-chains-design.md §5, §6) — on the
 * TEST database, through the real ingest routes, the real engine singleton,
 * the real debug writer and the real services.
 *
 * Pins:
 *   - a telemetry post enters the ROOT chain — the shipped document
 *     (`defaultRootChainDocument()`, the seeded chain's node ids) with debug
 *     ON on its switch and Save Timeseries: within 2 s the Message Type Switch
 *     has an IN row POST_TELEMETRY_REQUEST carrying `data.values.temp` and
 *     `metadata.instrumentCode`;
 *   - THE LOOP GUARD: Save Timeseries' write of a NEW reading does NOT come
 *     back as a second POST_TELEMETRY_REQUEST — until the chain's "Re-enter on
 *     rule-node writes" is ON, when it comes back exactly ONCE and the loop
 *     ENDS (the services emit only what changed); an ingest reading written
 *     back unchanged emits nothing either way;
 *   - the rule write is the ingest write path: no offset pass, an identical
 *     reading is an upsert no-op (no TELEMETRY_READING_REWRITTEN row);
 *   - a device attribute report enters as POST_ATTRIBUTES_REQUEST, an
 *     instrument create as ENTITY_CREATED;
 *   - the inject route → REST_API_REQUEST; test-script → `{ result: true }`;
 *     `/stats` → real numbers;
 *   - Configuration → Rule Engine `enabled = false` → nothing is processed;
 *   - the durable task re-injects AFTER the given node (a debug row at the
 *     next node), and `services.durable.enqueue` writes a graphile job on
 *     `rule-engine:<originatorId>` with its runAt;
 *   - the debug writer skips a chain that no longer exists; the hourly sweep
 *     applies the age and the per-node cap.
 *
 * The shipped chain's four node types get STAND-INS under the REAL type ids,
 * registered AFTER `ruleEngine.start()` (which registers every group's real
 * handlers) and restored after the engine stops. The Save Timeseries stand-in
 * writes whatever reaches it through `services.telemetry.write`, as the real
 * node does.
 *
 * The run's root chain is its OWN copy of the shipped document, made root for
 * the run (raw SQL, as `setRoot` does) — the seeded chain is never edited, so
 * a run that dies half way cannot leave the seeded document dirty (an earlier
 * version edited it in place, and an out-of-memory run did exactly that).
 * beforeAll removes a crashed run's copy and puts the seeded root back first;
 * afterAll does the same. Owns its super admin, instrument and config rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ROOT_CHAIN_NODE_IDS, defaultRootChainDocument, messageTypeSwitchLabel, type RuleChainDocument } from '@digilog/shared';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { setFixtureMeasurements } from '../test-support/fixture-measurements.js';
import { ensurePartitions } from '../workers/telemetry-partition.worker.js';
import { ruleEngine } from '../modules/rule-engine/engine.js';
import { registerNode } from '../modules/rule-engine/registry.js';
import { invalidateChainCache } from '../modules/rule-engine/service.js';
import { invalidateRuleEngineConfigCache } from '../modules/rule-engine/config.js';
import { insertDebugRows, toDebugRow, trimDebugNode } from '../modules/rule-engine/debug.js';
import { newMessage, ruleNodeOrigin, type RuleMessage } from '../modules/rule-engine/message.js';
import { runRuleEngineMessage } from '../workers/rule-engine-message.worker.js';
import { runRuleEngineDebugSweep } from '../workers/rule-engine-debug-sweep.worker.js';
import { invalidateOffsetConfigCache } from '../modules/instruments/load-offsets.js';

const SEEDED = 'b1a7e000-0000-4000-8000-000000000000';
const SWITCH = DEFAULT_ROOT_CHAIN_NODE_IDS.messageTypeSwitch;
const SAVE_TS = DEFAULT_ROOT_CHAIN_NODE_IDS.saveTimeseries;
const STAMP = Date.now().toString(36);
const SA = `re_sa_${STAMP}`;
const PW = 'RuleEngine@2026';
/** This run's root chain: a copy of the shipped document (same node ids — two chains may share them). */
const ROOT = randomUUID();
const ROOT_NAME_PREFIX = 'RE e2e root ';

let app: FastifyInstance;
let sa: Record<string, string>;
let userId: string;
let inst: { id: string; code: string; token: string };
let engineCfgBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;
const startedAt = new Date();
const restores: (() => void)[] = [];
const createdInstruments: string[] = [];
const createdAlarms: string[] = [];
const otherChains: string[] = [];

// ─── helpers ─────────────────────────────────────────────────────────────────

async function setEngineConfig(patch: Record<string, unknown>) {
  const base = { enabled: true, skipSaveNodesForIngestOrigin: false, scriptTimeoutMs: 2000, queueCapacity: 10000, concurrency: 8,
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

/** The shipped document with debug ON on the switch and Save Timeseries. */
function rootDocument(): RuleChainDocument {
  const doc = defaultRootChainDocument();
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === SWITCH || n.id === SAVE_TS ? { ...n, debugMode: 'all' } : n)) };
}

/** This run's root chain's "Re-enter on rule-node writes". */
async function setReEnter(on: boolean) {
  await prisma.$executeRaw`UPDATE rule_chains SET re_enter_on_rule_node_writes = ${on} WHERE id = ${ROOT}::uuid`;
  invalidateChainCache();
}

/** The seeded chain is the root again, and no run's copy is left (a crashed run's included). */
async function restoreSeededRoot() {
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE root AND id <> ${SEEDED}::uuid`,
    prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${SEEDED}::uuid`,
    prisma.$executeRaw`DELETE FROM rule_chains WHERE name LIKE ${`${ROOT_NAME_PREFIX}%`}`,
  ]);
  invalidateChainCache();
}

type DebugRow = { node_id: string; direction: string; relation: string | null; msg_id: string; msg_type: string; originator_id: string; data: any; metadata: any; ts: Date };

const rows = (where: { nodeId?: string; msgType?: string; originatorId?: string; msgId?: string; direction?: 'IN' | 'OUT' } = {}) => prisma.$queryRaw<DebugRow[]>`
  SELECT node_id::text, direction, relation, msg_id, msg_type, originator_id, data, metadata, ts
  FROM rule_node_debug_events
  WHERE chain_id = ${ROOT}::uuid AND ts >= ${startedAt}
    AND (${where.nodeId ?? null}::text IS NULL OR node_id = ${where.nodeId ?? null}::uuid)
    AND (${where.msgType ?? null}::text IS NULL OR msg_type = ${where.msgType ?? null})
    AND (${where.originatorId ?? null}::text IS NULL OR originator_id = ${where.originatorId ?? null})
    AND (${where.msgId ?? null}::text IS NULL OR msg_id = ${where.msgId ?? null})
    AND (${where.direction ?? null}::text IS NULL OR direction = ${where.direction ?? null})
  ORDER BY id`;

async function waitForRows(where: Parameters<typeof rows>[0], atLeast: number, ms = 2_000): Promise<DebugRow[]> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await rows(where);
    if (found.length >= atLeast || Date.now() > until) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Let the engine finish everything queued and write its debug rows. */
async function settle() {
  await ruleEngine.drain();
  await new Promise((r) => setTimeout(r, 50));
  await ruleEngine.drain();
}

const ingest = (body: unknown) => app.inject({ method: 'POST', url: '/api/ingest/v1/telemetry', headers: { authorization: `Bearer ${inst.token}` }, payload: body as never });

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = await buildApp();
  await ensurePartitions(1);
  // A crashed run's copy (and its root flag) goes first.
  await restoreSeededRoot();
  expect(await prisma.ruleChain.count({ where: { id: SEEDED, root: true } }), 'the seeded root chain must exist').toBe(1);
  const cfgRow = await prisma.systemConfig.findUnique({ where: { configKey: 'rule-engine' } });
  engineCfgBefore = cfgRow ? { configValue: cfgRow.configValue, configType: cfgRow.configType, requiresReauth: cfgRow.requiresReauth } : null;
  // The fixture instrument carries no offset attribute, so ingest stores the reading as sent.
  invalidateOffsetConfigCache();

  const u = await prisma.user.create({
    data: { username: SA, fullName: SA, role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false },
  });
  userId = u.id;
  sa = { authorization: `Bearer ${await loginAs(app, SA, PW)}` };

  // This run's root: the shipped document with debug ON, made root as setRoot does (old root unset first).
  await prisma.ruleChain.create({
    data: { id: ROOT, name: `${ROOT_NAME_PREFIX}${STAMP}`, firstNodeId: SWITCH, document: rootDocument() as never },
  });
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE id = ${SEEDED}::uuid`,
    prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${ROOT}::uuid`,
  ]);
  invalidateChainCache();
  await setEngineConfig({});
  await ruleEngine.start();

  // The stand-ins (see the header), under the real type ids — AFTER start(), which
  // registers every group's handlers; afterAll stops the engine, then each restore
  // puts back the handler that was registered when the stand-in replaced it.
  // Save Timeseries writes whatever reaches it (the skip applies to ingest-origin
  // messages only, and is OFF here): the services emit only what CHANGED, so a
  // re-entered message's write of the same values ends the loop.
  restores.push(registerNode('tb:filter:message-type-switch', (ctx, msg) => ctx.tellNext(msg, messageTypeSwitchLabel(msg.type))));
  restores.push(registerNode('tb:action:save-timeseries', async (ctx, msg) => {
    if (ctx.services.config().skipSaveNodesForIngestOrigin && msg.metadata.rule_engine_origin === 'ingest') return;
    const ts = new Date(Number(msg.metadata.ts) || Date.now());
    await ctx.services.telemetry.write(msg.originator.id,
      Object.entries(msg.data as Record<string, unknown>).map(([key, value]) => ({ key, value, ts })), ctx.origin);
    ctx.tellNext(msg, 'Success');
  }));
  restores.push(registerNode('tb:action:save-attributes', () => undefined));
  restores.push(registerNode('tb:action:log', () => undefined));

  const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: sa,
    payload: { profileId: await fixtureProfileId('fixture:rule-engine'), name: `RE ${STAMP}`, code: `RE-${STAMP}` } });
  expect(res.statusCode, res.body).toBe(201);
  inst = res.json();
  createdInstruments.push(inst.id);
});

afterAll(async () => {
  try { await ruleEngine.stop(); } catch (e) { console.error('engine stop', e); }
  while (restores.length) restores.pop()!();
  // The seeded root back, this run's copy deleted (its debug rows cascade with it).
  try { await restoreSeededRoot(); } catch (e) { console.error('restore seeded root', e); }
  try {
    if (engineCfgBefore) await prisma.systemConfig.update({ where: { configKey: 'rule-engine' }, data: engineCfgBefore as never });
    else if (engineCfgBefore === null) await prisma.systemConfig.deleteMany({ where: { configKey: 'rule-engine' } });
  } catch (e) { console.error('restore rule-engine config', e); }
  invalidateRuleEngineConfigCache();
  try { await prisma.ruleChain.deleteMany({ where: { id: { in: otherChains } } }); } catch (e) { console.error('chain cleanup', e); }
  try {
    await prisma.$executeRaw`DELETE FROM graphile_worker._private_jobs j USING graphile_worker._private_job_queues q
      WHERE j.job_queue_id = q.id AND q.queue_name = ${`rule-engine:${inst?.id ?? 'none'}`}`;
  } catch (e) { console.error('job cleanup', e); }
  // The notification / webhook jobs those alarms enqueued (no job runner in the e2e app).
  for (const alarmId of createdAlarms) {
    try {
      await prisma.$executeRaw`DELETE FROM graphile_worker._private_jobs j USING graphile_worker._private_tasks t
        WHERE j.task_id = t.id AND t.identifier IN ('notification', 'alarm_webhook') AND j.payload::text LIKE ${`%${alarmId}%`}`;
    } catch (e) { console.error('job cleanup', e); }
  }
  // Alarms restrict an instrument's delete: this run's RULE alarms go first.
  try { await prisma.alarm.deleteMany({ where: { OR: [{ id: { in: createdAlarms } }, { instrumentId: { in: createdInstruments }, source: 'RULE' }] } }); } catch (e) { console.error('alarm cleanup', e); }
  try { await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: createdInstruments } } }); } catch (e) { console.error(e); }
  for (const id of createdInstruments) {
    try { await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: sa }); } catch (e) { console.error(e); }
  }
  try {
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  } catch (e) { console.error('user cleanup', e); }
  await app.close();
});

// ─── cases ───────────────────────────────────────────────────────────────────

describe('telemetry enters the root chain', () => {
  it('an IN row on the switch within 2 s: POST_TELEMETRY_REQUEST, data.values.temp, metadata.instrumentCode — ONCE (written back unchanged, it emits nothing)', async () => {
    const ts = Date.now() - 5_000;
    const posted = Date.now();
    expect((await ingest({ ts, temp: 21.5, hum: 40 })).statusCode).toBe(200);
    const found = await waitForRows({ nodeId: SWITCH, msgType: 'POST_TELEMETRY_REQUEST', originatorId: inst.id, direction: 'IN' }, 1);
    expect(Date.now() - posted).toBeLessThan(2_000);
    expect(found).toHaveLength(1);
    const [inRow] = found;
    // ThingsBoard's FLAT shape (ruling M-1): the values are the data, the instant is metadata.ts.
    expect(inRow.data).toEqual({ temp: 21.5, hum: 40 });
    expect(inRow.metadata.ts).toBe(String(ts));
    expect(inRow.metadata.instrumentCode).toBe(inst.code);
    expect(inRow.metadata.instrumentName).toBe(`RE ${STAMP}`);
    expect(inRow.metadata.transport).toBe('http');
    expect(inRow.metadata.rule_engine_origin).toBe('ingest');

    // Save Timeseries WROTE (skip OFF) — and its write did not come back.
    await waitForRows({ nodeId: SAVE_TS, originatorId: inst.id, direction: 'OUT' }, 1);
    await settle();
    await new Promise((r) => setTimeout(r, 600));
    expect(await rows({ nodeId: SWITCH, msgType: 'POST_TELEMETRY_REQUEST', originatorId: inst.id, direction: 'IN' })).toHaveLength(1);
    const saveOut = await rows({ nodeId: SAVE_TS, originatorId: inst.id, direction: 'OUT' });
    expect(saveOut.map((r) => r.relation)).toEqual(['Success (unconnected)']);
  });

  it('the rule write is the ingest write path: the same reading again is a no-op (no rewrite audit)', async () => {
    const rewritten = await prisma.auditTrail.count({ where: { action: 'TELEMETRY_READING_REWRITTEN', targetId: inst.id } });
    expect(rewritten).toBe(0);
    const stored = await prisma.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM instrument_telemetry_history WHERE instrument_id = ${inst.id} AND key = 'temp'`;
    expect(stored.map((s) => s.value)).toEqual([21.5]);
  });

  it('a rule write gets NO sensor-offset pass: an offset-corrected reading written back is still a no-op', async () => {
    const profileId = await fixtureProfileId('fixture:rule-engine-offsets');
    await setFixtureMeasurements(profileId, (ms) => ms.map((m) => (m.code === 'TEMPERATURE' ? { ...m, deviceKeys: ['t'], offsetKeys: ['Temp Off set'] } : m)));
    const offsetsBefore = await prisma.systemConfig.findUnique({ where: { configKey: 'sensor-offsets' } });
    await prisma.systemConfig.upsert({
      where: { configKey: 'sensor-offsets' }, update: { configValue: { enabled: true } as never },
      create: { configKey: 'sensor-offsets', configValue: { enabled: true } as never, configType: 'system', requiresReauth: false },
    });
    invalidateOffsetConfigCache();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: sa, payload: { profileId, name: `REO ${STAMP}`, code: `REO-${STAMP}` } });
      expect(res.statusCode, res.body).toBe(201);
      const o = res.json() as { id: string; token: string };
      createdInstruments.push(o.id);
      const attr = await app.inject({ method: 'POST', url: `/api/instruments/${o.id}/attributes`, headers: sa, payload: { key: 'Temp Off set', value: '+2', reason: 'calibration' } });
      expect(attr.statusCode, attr.body).toBe(201);
      const ts = Date.now() - 6_000;
      const sent = await app.inject({ method: 'POST', url: '/api/ingest/v1/telemetry', headers: { authorization: `Bearer ${o.token}` }, payload: { ts, t: 23.4 } });
      expect(sent.statusCode, sent.body).toBe(200);
      // Save Timeseries wrote the CORRECTED reading back (its OUT row is the proof it ran).
      expect(await waitForRows({ nodeId: SAVE_TS, originatorId: o.id, direction: 'OUT' }, 1)).toHaveLength(1);
      await settle();
      const stored = await prisma.$queryRaw<{ value: unknown; raw_value: unknown }[]>`
        SELECT value, raw_value FROM instrument_telemetry_history WHERE instrument_id = ${o.id} AND key = 't'`;
      expect(stored).toEqual([{ value: 25.4, raw_value: 23.4 }]);
      expect(await prisma.auditTrail.count({ where: { action: 'TELEMETRY_READING_REWRITTEN', targetId: o.id } })).toBe(0);
    } finally {
      if (offsetsBefore) await prisma.systemConfig.update({ where: { configKey: 'sensor-offsets' }, data: { configValue: offsetsBefore.configValue as never } });
      else await prisma.systemConfig.deleteMany({ where: { configKey: 'sensor-offsets' } });
      invalidateOffsetConfigCache();
    }
  });

  /** The switch's POST_TELEMETRY_REQUEST IN rows for one instant, after the engine has gone quiet. */
  async function settledInsAt(ts: number, atLeast: number): Promise<DebugRow[]> {
    const where = { nodeId: SWITCH, msgType: 'POST_TELEMETRY_REQUEST', originatorId: inst.id, direction: 'IN' as const };
    const until = Date.now() + 2_000;
    const at = (r: DebugRow) => r.metadata?.ts === String(ts);
    while ((await rows(where)).filter(at).length < atLeast && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    await settle();
    await new Promise((r) => setTimeout(r, 600));
    await settle();
    return (await rows(where)).filter(at);
  }

  /** A NEW reading entered through the inject route (origin rest_api), so Save Timeseries' write is a real change. */
  async function injectReading(ts: number, temp: number) {
    const res = await app.inject({ method: 'POST', url: '/api/rule-engine/v1/messages', headers: sa,
      payload: { type: 'POST_TELEMETRY_REQUEST', originatorCode: inst.code, data: { temp }, metadata: { ts: String(ts) } } });
    expect(res.json(), res.body).toMatchObject({ accepted: true });
  }

  it('THE LOOP GUARD: re-entry OFF, a rule write of a NEW reading does not come back', async () => {
    const ts = Date.now() - 3_500;
    await injectReading(ts, 31.5);
    const found = await settledInsAt(ts, 1);
    expect(found.map((r) => r.metadata.rule_engine_origin)).toEqual(['rest_api']);
    // ...although Save Timeseries did store it.
    const stored = await prisma.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM instrument_telemetry_history WHERE instrument_id = ${inst.id} AND key = 'temp' AND ts = ${new Date(ts)}`;
    expect(stored).toEqual([{ value: 31.5 }]);
  });

  it('re-entry ON: a NEW reading comes back exactly once, and the loop ENDS (the same value written again emits nothing)', async () => {
    await setReEnter(true);
    try {
      const ts = Date.now() - 3_000;
      await injectReading(ts, 32.5);
      const found = await settledInsAt(ts, 2);
      expect(found.map((r) => r.metadata.rule_engine_origin)).toEqual(['rest_api', ruleNodeOrigin(ROOT, SAVE_TS)]);
      // An ingest reading is already stored when Save Timeseries writes it: nothing comes back at all.
      const ingestTs = Date.now() - 2_500;
      expect((await ingest({ ts: ingestTs, temp: 22 })).statusCode).toBe(200);
      expect((await settledInsAt(ingestTs, 1)).map((r) => r.metadata.rule_engine_origin)).toEqual(['ingest']);
    } finally {
      await setReEnter(false);
      await settle();
    }
  });
});

describe('other sources', () => {
  it('a device attribute report → POST_ATTRIBUTES_REQUEST with the changed keys, scope CLIENT_SCOPE', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ingest/v1/attributes', headers: { authorization: `Bearer ${inst.token}` }, payload: { fw: `1.${STAMP}` } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const [row] = await waitForRows({ nodeId: SWITCH, msgType: 'POST_ATTRIBUTES_REQUEST', originatorId: inst.id }, 1);
    expect(row.data).toEqual({ fw: `1.${STAMP}` });
    expect(row.metadata.scope).toBe('CLIENT_SCOPE');
  });

  it('creating an instrument → ENTITY_CREATED, with no token in it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: sa,
      payload: { profileId: await fixtureProfileId('fixture:rule-engine'), name: `RE2 ${STAMP}`, code: `RE2-${STAMP}` } });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json() as { id: string; token: string };
    createdInstruments.push(created.id);
    const [row] = await waitForRows({ nodeId: SWITCH, msgType: 'ENTITY_CREATED', originatorId: created.id }, 1);
    expect(row.data).toMatchObject({ id: created.id, code: `RE2-${STAMP}` });
    expect(JSON.stringify(row.data)).not.toContain(created.token);
    expect(row.data.credentials).toBeUndefined();
  });

  it('the inject route → REST_API_REQUEST from the instrument named by code; an unknown code is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rule-engine/v1/messages', headers: sa,
      payload: { originatorCode: inst.code.toLowerCase(), data: { hello: 'world', password: 'p4ss' }, metadata: { source: 'e2e', apiToken: 'tok-123' } } });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { accepted: boolean; msgId: string };
    expect(body.accepted).toBe(true);
    const [row] = await waitForRows({ nodeId: SWITCH, msgId: body.msgId }, 1);
    expect(row.msg_type).toBe('REST_API_REQUEST');
    expect(row.originator_id).toBe(inst.id);
    expect(row.data).toEqual({ hello: 'world', password: 'p4ss' });
    expect(row.metadata).toMatchObject({ source: 'e2e', requestId: body.msgId, rule_engine_origin: 'rest_api', instrumentCode: inst.code });

    // ONE audit row per call, by the caller, the message with credential-like keys masked.
    const audits = await prisma.auditTrail.findMany({ where: { action: 'RULE_ENGINE_MESSAGE_INJECTED', targetId: body.msgId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: SA, userRole: 'SUPER_ADMIN', targetType: 'rule_engine_message', reason: null });
    expect(audits[0].afterValue).toMatchObject({
      name: `REST_API_REQUEST from ${inst.code}`, msgId: body.msgId, type: 'REST_API_REQUEST',
      originator: { type: 'INSTRUMENT', id: inst.id, code: inst.code },
      data: { hello: 'world', password: '***' },
      metadata: { source: 'e2e', apiToken: '***', requestId: body.msgId, rule_engine_origin: 'rest_api' },
    });

    const unknown = await app.inject({ method: 'POST', url: '/api/rule-engine/v1/messages', headers: sa,
      payload: { originatorCode: `NOPE-${STAMP}`, data: {} } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('ORIGINATOR_NOT_FOUND');
    // A refused call injected nothing and is not audited.
    expect(await prisma.auditTrail.count({ where: { action: 'RULE_ENGINE_MESSAGE_INJECTED', afterValue: { path: ['originator', 'code'], equals: `NOPE-${STAMP}` } } })).toBe(0);
  });

  it('a SYSTEM message when no code is given', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rule-engine/v1/messages', headers: sa, payload: { data: { n: 1 } } });
    expect(res.statusCode).toBe(202);
    const [row] = await waitForRows({ nodeId: SWITCH, msgId: res.json().msgId }, 1);
    expect(row.metadata).toMatchObject({ rule_engine_origin: 'rest_api' });
    expect(row.originator_id).toBe('SYSTEM');
  });
});

describe('routes', () => {
  it('test-script runs a filter: { result: true }; a script error is a 400 naming it', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/rule-chains/test-script', headers: sa,
      payload: { scriptType: 'filter', script: 'return msg.temperature > 10;', msg: { temperature: 12 }, metadata: {}, msgType: 'POST_TELEMETRY_REQUEST' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ result: true });
    const bad = await app.inject({ method: 'POST', url: '/api/rule-chains/test-script', headers: sa,
      payload: { scriptType: 'filter', script: 'while (true) {}', msg: {} } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('SCRIPT_TIMEOUT');
  });

  it('/stats: switched on, real counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rule-chains/stats', headers: sa });
    expect(res.statusCode).toBe(200);
    const s = res.json() as { enabled: boolean; queueDepth: number; dropped: number; processedLastMinute: number; chains: { id: string; processedLastMinute: number }[] };
    expect(s.enabled).toBe(true);
    expect(s.processedLastMinute).toBeGreaterThan(0);
    expect(s.chains.find((c) => c.id === ROOT)?.processedLastMinute).toBeGreaterThan(0);
    expect(s.dropped).toBe(0);
  });
});

describe('Configuration → Rule Engine', () => {
  it('enabled = false: nothing is processed', async () => {
    await setEngineConfig({ enabled: false });
    try {
      const ts = Date.now() - 3_000;
      expect((await ingest({ ts, temp: 30 })).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 1_000));
      await settle();
      const found = (await rows({ nodeId: SWITCH, msgType: 'POST_TELEMETRY_REQUEST', originatorId: inst.id })).filter((r) => r.metadata?.ts === String(ts));
      expect(found).toEqual([]);
      const before = new Date();
      const res = await app.inject({ method: 'POST', url: '/api/rule-engine/v1/messages', headers: sa, payload: { data: {} } });
      expect(res.json()).toEqual({ accepted: false, reason: 'ENGINE_DISABLED' });
      // Audited all the same: the call was made.
      expect(await prisma.auditTrail.count({ where: { action: 'RULE_ENGINE_MESSAGE_INJECTED', userId: SA, timestamp: { gte: before } } })).toBe(1);
    } finally {
      await setEngineConfig({});
    }
  });
});

describe('the durable path', () => {
  it('the task re-injects AFTER the given node: a debug row at the next node', async () => {
    const msg = newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: inst.id }, { temp: 23 }, { ts: Date.now() - 2_000, from: 'durable' });
    const outcome = await runRuleEngineMessage({ message: msg, chainId: ROOT, resumeAfterNodeId: SWITCH, relation: 'Post telemetry' });
    expect(outcome).toBe('admitted');
    const found = await waitForRows({ msgId: msg.id }, 2);
    expect(found.map((r) => [r.node_id, r.direction, r.relation])).toEqual([
      [SWITCH, 'OUT', 'Post telemetry'],
      [SAVE_TS, 'IN', 'Post telemetry'],
      // The stand-in writes only ingest-origin messages: this one ends there.
    ]);
  });

  it('a malformed job is dropped, not retried forever', async () => {
    expect(await runRuleEngineMessage({ message: { id: 'x' }, chainId: 'nope' })).toBe('dropped_invalid');
  });

  it('services.durable.enqueue writes a rule_engine_message job on rule-engine:<originatorId> with its runAt', async () => {
    const msg = { ...newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: inst.id }, {}, { ts: 1 }), _hops: 7 };
    const runAt = new Date(Date.now() + 3_600_000);
    await ruleEngine.services.durable.enqueue(msg, ROOT, SAVE_TS, runAt);
    const jobs = await prisma.$queryRaw<{ task_identifier: string; run_at: Date; payload: any }[]>`
      SELECT t.identifier AS task_identifier, j.run_at, j.payload
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
      WHERE q.queue_name = ${`rule-engine:${inst.id}`}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_identifier).toBe('rule_engine_message');
    expect(Math.abs(new Date(jobs[0].run_at).getTime() - runAt.getTime())).toBeLessThan(1_000);
    expect(jobs[0].payload).toMatchObject({ chainId: ROOT, resumeAfterNodeId: SAVE_TS, message: { id: msg.id, type: 'POST_TELEMETRY_REQUEST' } });
    // The hop count travels with it (a cycle through Delay still reaches the hop limit).
    expect(jobs[0].payload.message._hops).toBe(7);
  });
});

describe('debug rows', () => {
  it('a batch with a row for a chain that no longer exists writes the others', async () => {
    const mk = (chainId: string) => toDebugRow({
      chainId, nodeId: randomUUID(), direction: 'IN', relation: null,
      msg: newMessage('X', { type: 'SYSTEM', id: 'SYSTEM' }, { e2e: STAMP }) as RuleMessage,
    });
    const n = await insertDebugRows([mk(ROOT), mk(randomUUID()), mk(ROOT)]);
    expect(n).toBe(2);
  });

  it('the hourly sweep removes rows past the retention and trims each node to its cap', async () => {
    const chain = await prisma.ruleChain.create({ data: { name: `RE sweep ${STAMP}`, document: { version: 1, firstNodeId: null, nodes: [], connections: [] } } });
    otherChains.push(chain.id);
    const node = randomUUID();
    const old = new Date(Date.now() - 3 * 3_600_000);
    const mk = (ts: Date, i: number) => toDebugRow({ chainId: chain.id, nodeId: node, direction: 'IN', relation: null, ts,
      msg: newMessage('X', { type: 'SYSTEM', id: 'SYSTEM' }, { i }) as RuleMessage });
    await insertDebugRows([...Array.from({ length: 3 }, (_, i) => mk(old, i)), ...Array.from({ length: 12 }, (_, i) => mk(new Date(Date.now() - i * 1000), 100 + i))]);
    await setEngineConfig({ debugRetentionHours: 2, debugMaxEventsPerNode: 10 });
    try {
      await runRuleEngineDebugSweep();
      const left = await prisma.ruleNodeDebugEvent.findMany({ where: { chainId: chain.id }, orderBy: { ts: 'desc' }, select: { data: true } });
      expect(left.map((r) => (r.data as { i: number }).i)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
      // The writer's per-node trim (one statement): the newest N of THAT node stay.
      expect(await trimDebugNode(chain.id, node, 4)).toBe(6);
      const kept = await prisma.ruleNodeDebugEvent.findMany({ where: { chainId: chain.id }, orderBy: { ts: 'desc' }, select: { data: true } });
      expect(kept.map((r) => (r.data as { i: number }).i)).toEqual([100, 101, 102, 103]);
    } finally {
      await setEngineConfig({});
    }
  });
});

describe('services (what Tasks 4-6 call)', () => {
  const origin = () => ruleNodeOrigin(ROOT, SAVE_TS);

  it('attributes.save writes and audits only what CHANGED, as SYSTEM, naming the chain and node; delete likewise', async () => {
    const svc = ruleEngine.services;
    expect((await svc.attributes.save(inst.id, { Mode: 'auto', Site: 'QC' }, origin(), false)).sort()).toEqual(['Mode', 'Site']);
    expect(await svc.attributes.save(inst.id, { Mode: 'auto', Site: 'QC2' }, origin(), false)).toEqual(['Site']);
    expect(await svc.attributes.get(inst.id, ['Mode', 'Site'])).toEqual({ Mode: 'auto', Site: 'QC2' });
    const set = await prisma.auditTrail.findMany({ where: { action: 'INSTRUMENT_ATTRIBUTE_SET', targetId: inst.id }, orderBy: { chainPosition: 'asc' } });
    expect(set).toHaveLength(3);
    for (const row of set) {
      expect(row.userId).toBe('SYSTEM');
      expect(row.userRole).toBe('SYSTEM');
      expect(row.reason).toBe(`Written by rule chain "${ROOT_NAME_PREFIX}${STAMP}" node "Save Timeseries"`);
    }
    expect(await svc.attributes.delete(inst.id, ['Mode', 'Nope'], origin())).toEqual(['Mode']);
    expect(await svc.attributes.delete(inst.id, ['Mode'], origin())).toEqual([]);
    const removed = await prisma.auditTrail.findMany({ where: { action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetId: inst.id } });
    expect(removed.map((r) => [r.userId, (r.beforeValue as { value: string }).value])).toEqual([['SYSTEM', 'auto']]);
  });

  it('attributes.save refuses a sensor-offset key', async () => {
    const profileId = await fixtureProfileId('fixture:rule-engine-offsets');
    await setFixtureMeasurements(profileId, (ms) => ms.map((m) => (m.code === 'TEMPERATURE' ? { ...m, deviceKeys: ['t'], offsetKeys: ['Temp Off set'] } : m)));
    await expect(ruleEngine.services.attributes.save(inst.id, { 'Temp Off set': '+9' }, origin(), false)).rejects.toThrow(/^OFFSET_KEY_REFUSED/);
    expect(await ruleEngine.services.attributes.get(inst.id, ['Temp Off set'])).toEqual({});
  });

  it('alarms: create = a RULE / CUSTOM alarm; the same type again UPDATES it; clear claims it once', async () => {
    const svc = ruleEngine.services;
    const first = await svc.alarms.createOrUpdate({ instrumentId: inst.id, alarmType: `Door ${STAMP}`, severity: 'MAJOR', details: { n: 1 }, nodeId: SAVE_TS, chainId: ROOT });
    createdAlarms.push(first.alarm.id);
    expect(first.created).toBe(true);
    expect(first.alarm).toMatchObject({ source: 'RULE', metric: 'CUSTOM', severity: 'MAJOR', state: 'ACTIVE', triggeredValue: null });
    expect(first.alarm.ruleSnapshot).toEqual({ alarmType: `Door ${STAMP}`, nodeId: SAVE_TS, chainId: ROOT, details: { n: 1 } });
    const second = await svc.alarms.createOrUpdate({ instrumentId: inst.id, alarmType: `Door ${STAMP}`, severity: 'WARNING', details: { n: 2 }, nodeId: SAVE_TS, chainId: ROOT });
    expect(second.created).toBe(false);
    expect(second.alarm.id).toBe(first.alarm.id);
    expect(second.alarm.severity).toBe('MINOR'); // ThingsBoard's WARNING has no counterpart here
    expect((second.alarm.ruleSnapshot as { details: unknown }).details).toEqual({ n: 2 });
    expect(await prisma.alarm.count({ where: { instrumentId: inst.id, source: 'RULE', state: 'ACTIVE' } })).toBe(1);
    const cleared = await svc.alarms.clear(inst.id, `Door ${STAMP}`, { why: 'closed' }, origin());
    expect(cleared?.id).toBe(first.alarm.id);
    expect(cleared?.state).toBe('CLEARED');
    expect(await svc.alarms.clear(inst.id, `Door ${STAMP}`, undefined, origin())).toBeNull();
    // A new excursion of the same type is a NEW alarm once the old one is cleared.
    const third = await svc.alarms.createOrUpdate({ instrumentId: inst.id, alarmType: `Door ${STAMP}`, severity: 'CRITICAL', details: {}, nodeId: SAVE_TS, chainId: ROOT });
    createdAlarms.push(third.alarm.id);
    expect(third.created).toBe(true);
    expect(third.alarm.id).not.toBe(first.alarm.id);
  });

  it('telemetry.write with skipLatest writes history only', async () => {
    const ts = new Date(Date.now() - 2_000);
    await ruleEngine.services.telemetry.write(inst.id, [{ key: `sl_${STAMP}`, value: 5, ts }], origin(), { skipLatest: true });
    const history = await prisma.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM instrument_telemetry_history WHERE instrument_id = ${inst.id} AND key = ${`sl_${STAMP}`}`;
    expect(history).toEqual([{ value: 5 }]);
    expect(await ruleEngine.services.telemetry.latest(inst.id, [`sl_${STAMP}`])).toEqual({});
    // Without it, latest follows.
    await ruleEngine.services.telemetry.write(inst.id, [{ key: `sl_${STAMP}`, value: 6, ts: new Date(ts.getTime() + 1) }], origin());
    expect(Object.keys(await ruleEngine.services.telemetry.latest(inst.id, [`sl_${STAMP}`]))).toEqual([`sl_${STAMP}`]);
  });

  it('telemetry.latest / history, instruments.byCode / fields, appDetails', async () => {
    const svc = ruleEngine.services;
    const latest = await svc.telemetry.latest(inst.id, ['temp']);
    expect(Object.keys(latest)).toEqual(['temp']);
    const now = new Date();
    const from = new Date(now.getTime() - 3_600_000);
    const rowsNone = await svc.telemetry.history(inst.id, ['temp'], from, now, 'NONE', 'ASC', 10);
    expect(rowsNone.temp.length).toBeGreaterThan(0);
    expect(rowsNone.temp.every((r, i, a) => i === 0 || a[i - 1].ts <= r.ts)).toBe(true);
    const count = await svc.telemetry.history(inst.id, ['temp'], from, now, 'COUNT', 'ASC', 10);
    expect(count.temp).toEqual([{ ts: now.getTime(), value: rowsNone.temp.length }]);
    expect((await svc.instruments.byCode(inst.code.toLowerCase()))?.id).toBe(inst.id);
    expect(await svc.instruments.gatewayOf(inst.id)).toBeNull();
    expect(await svc.instruments.fields(inst.id)).toMatchObject({ id: inst.id, code: inst.code, name: `RE ${STAMP}`, isGateway: 'false' });
    expect(Object.keys(await svc.appDetails()).sort()).toEqual(['APP_NAME', 'SERVER_NAME', 'SERVER_VERSION', 'TITLE']);
  });
});
