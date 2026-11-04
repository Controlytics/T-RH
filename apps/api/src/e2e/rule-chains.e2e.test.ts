/**
 * `/api/rule-chains` and `/api/rule-engine/v1` — rule chains, Task 2 of the
 * rule-chains plan (spec docs/superpowers/specs/2026-11-03-rule-chains-design.md
 * §5, §8, §9, §10, §12). This file never STARTS the engine: `/stats` answers
 * zeros and the inject route accepts nothing; the running engine is
 * src/e2e/rule-engine.e2e.test.ts (Task 3).
 *
 * Pins, over HTTP:
 *   - the migration seeded EXACTLY `defaultRootChainDocument()` (fixed ids) as
 *     the one root chain, with its projection;
 *   - the document is the source of truth: a write is strictly parsed (400
 *     naming the node; mutation: drop the parse → the unknown-type case fails),
 *     the projection is rebuilt with the document's ids, and the whole document
 *     is audited before / after in the same transaction;
 *   - `expectedUpdatedAt` → 409 STALE, nothing written; an unchanged save
 *     writes and audits nothing;
 *   - exactly one root: `POST /:id/root` moves it in one transaction (mutation:
 *     drop the unset → the one-root case fails); the root cannot be deleted;
 *   - reads need RULE_CHAIN_READ, writes RULE_CHAIN_MANAGE (checked before the
 *     body), re-auth UPDATE_RULE_CHAIN and a reason;
 *   - ThingsBoard import / export round-trips, and the export MASKS credentials;
 *   - the two config defs serve their defaults and their readers follow a save.
 *
 * Owns its super admin, roles, users and chains. In afterAll, FIRST and each
 * guarded on its own: the `action-reauth`, `rule-engine` and
 * `rule-engine-attributes` rows are restored, and the seeded chain is made the
 * root again (Task 3's e2e reads it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import {
  defaultRootChainDocument, emptyRuleChainDocument, newRuleNodeConfig, toThingsboardExport, fromThingsboardExport,
  ruleChainsEqual, RULE_NODE_TYPES, DEFAULT_ROOT_CHAIN_NAME,
  type RuleChainDocument, type RuleChainNode,
} from '@digilog/shared';

const SEEDED = 'b1a7e000-0000-4000-8000-000000000000';
const S = Date.now().toString(36).toUpperCase();
const s = S.toLowerCase();
const READER = `RC_READ_${S}`;
const MGR = `RC_MGR_${S}`;
const NOPERM = `RC_NONE_${S}`;
const ROLES = [READER, MGR, NOPERM];
const PW = 'RuleCh@in2026';
const NAME = { sa: `rc_sa_${s}`, rd: `rc_rd_${s}`, mg: `rc_mg_${s}`, no: `rc_no_${s}` };
const REASON = 'Rule chain e2e';

let app: FastifyInstance;
type H = Record<string, string>;
let sa: H, rd: H, mg: H, no: H;
const userIds: string[] = [];
const chains: string[] = [];
type Saved = { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;
let reauthBefore: Saved;
let engineBefore: Saved;
let attrsBefore: Saved;

interface Detail {
  id: string; name: string; root: boolean; debugMode: boolean; reEnterOnRuleNodeWrites: boolean;
  document: RuleChainDocument; updatedAt: string; updatedBy: string | null;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

async function makeUser(username: string, role: string) {
  const u = await prisma.user.create({
    data: {
      username, fullName: `Full ${username}`, role, status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
    },
  });
  userIds.push(u.id);
}

function node(type: string, name: string, x = 100, y = 100, config?: Record<string, unknown>): RuleChainNode {
  return { id: randomUUID(), type, name, debugMode: 'off', config: config ?? newRuleNodeConfig(type), x, y };
}

/** Script filter → (True) → Log. */
function twoNodeDoc(): RuleChainDocument {
  const filter = node('tb:filter:script', 'Hot?', 200, 150);
  const log = node('tb:action:log', 'Log hot', 500, 150);
  return { version: 1, firstNodeId: filter.id, nodes: [filter, log], connections: [{ from: filter.id, to: log.id, relation: 'True' }] };
}

async function storeConfig(key: string, value: unknown, configType: string) {
  await prisma.systemConfig.upsert({
    where: { configKey: key },
    update: { configValue: value as never },
    create: { configKey: key, configValue: value as never, configType, requiresReauth: false },
  });
}
async function saveConfig(key: string): Promise<Saved> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: key } });
  return row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
}
async function restoreConfig(key: string, before: Saved) {
  if (before === undefined) return;
  if (before) await prisma.systemConfig.update({ where: { configKey: key }, data: before as never });
  else await prisma.systemConfig.deleteMany({ where: { configKey: key } });
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const get = (url: string, headers: H = sa) => app.inject({ method: 'GET', url, headers });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, body: Record<string, unknown> | undefined, headers: H = sa) =>
  app.inject({ method, url, headers, ...(body !== undefined ? { payload: body as never } : {}) });

async function create(name: string, document?: RuleChainDocument): Promise<Detail> {
  const res = await send('POST', '/api/rule-chains', { name, reason: REASON, ...(document ? { document } : {}) });
  expect(res.statusCode, res.body).toBe(201);
  const row = res.json() as Detail;
  chains.push(row.id);
  return row;
}

const auditFor = (chainId: string, action?: string) => prisma.auditTrail.findMany({
  where: { targetId: chainId, ...(action ? { action } : {}) },
  orderBy: { chainPosition: 'asc' },
  select: { action: true, beforeValue: true, afterValue: true, reason: true, userId: true, targetType: true },
}) as Promise<{ action: string; beforeValue: any; afterValue: any; reason: string | null; userId: string | null; targetType: string | null }[]>;

const rootIds = async () => (await prisma.ruleChain.findMany({ where: { root: true }, select: { id: true } })).map((r) => r.id);

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = await buildApp();
  reauthBefore = await saveConfig('action-reauth');
  engineBefore = await saveConfig('rule-engine');
  attrsBefore = await saveConfig('rule-engine-attributes');
  await prisma.role.create({ data: { name: READER, displayName: READER, hierarchyLevel: 2, permissions: ['RULE_CHAIN_READ'] } });
  // MANAGE alone: READ comes by implication (`_READ ← _MANAGE`).
  await prisma.role.create({ data: { name: MGR, displayName: MGR, hierarchyLevel: 3, permissions: ['RULE_CHAIN_MANAGE'] } });
  await prisma.role.create({ data: { name: NOPERM, displayName: NOPERM, hierarchyLevel: 2, permissions: ['DASHBOARD_VIEW'] } });
  invalidateRolePermsCache();
  await makeUser(NAME.sa, 'SUPER_ADMIN');
  await makeUser(NAME.rd, READER);
  await makeUser(NAME.mg, MGR);
  await makeUser(NAME.no, NOPERM);
  sa = { authorization: `Bearer ${await loginAs(app, NAME.sa, PW)}` };
  rd = { authorization: `Bearer ${await loginAs(app, NAME.rd, PW)}` };
  mg = { authorization: `Bearer ${await loginAs(app, NAME.mg, PW)}` };
  no = { authorization: `Bearer ${await loginAs(app, NAME.no, PW)}` };
});

afterAll(async () => {
  try { await restoreConfig('action-reauth', reauthBefore); } catch (e) { console.error('restore action-reauth', e); } finally { invalidateReauthCache(); }
  try { await restoreConfig('rule-engine', engineBefore); } catch (e) { console.error('restore rule-engine', e); }
  try { await restoreConfig('rule-engine-attributes', attrsBefore); } catch (e) { console.error('restore rule-engine-attributes', e); }
  try {
    // The seeded chain is the root again, whatever a failing case left behind.
    await prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE root AND id <> ${SEEDED}::uuid`;
    await prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${SEEDED}::uuid`;
  } catch (e) { console.error('restore root', e); }
  // By id, AND by this run's suffix: a case that fails (or a mutation run) may have created a chain it never recorded.
  try { await prisma.ruleChain.deleteMany({ where: { OR: [{ id: { in: chains } }, { name: { contains: S } }], root: false } }); } catch (e) { console.error('cleanup chains', e); }
  try {
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (e) { console.error('cleanup users', e); }
  try {
    await prisma.role.deleteMany({ where: { name: { in: ROLES } } });
    invalidateRolePermsCache();
  } catch (e) { console.error('cleanup roles', e); }
  try {
    const svc = await import('../modules/rule-engine/service.js');
    svc.invalidateChainCache();
  } catch { /* the service may not exist on a red run */ }
  await app.close();
});

// ─── cases ───────────────────────────────────────────────────────────────────

describe('the shipped root chain', () => {
  it('the migration seeded defaultRootChainDocument() as the one root, with its projection', async () => {
    const list = await get('/api/rule-chains');
    expect(list.statusCode, list.body).toBe(200);
    const rows = (list.json() as { data: any[] }).data;
    const seeded = rows.find((r) => r.id === SEEDED);
    expect(seeded).toMatchObject({ id: SEEDED, name: DEFAULT_ROOT_CHAIN_NAME, root: true, debugMode: false, nodeCount: 4, updatedBy: null });
    expect(Date.parse(seeded.updatedAt)).not.toBeNaN();
    expect(rows.filter((r) => r.root)).toHaveLength(1);
    expect(rows[0].id).toBe(SEEDED); // the root lists first

    const one = await get(`/api/rule-chains/${SEEDED}`);
    expect(one.statusCode, one.body).toBe(200);
    const detail = one.json() as Detail;
    // Fixed ids are the point: toEqual, never ruleChainsEqual (which ignores ids).
    expect(detail.document).toEqual(defaultRootChainDocument());
    expect(detail).toMatchObject({ id: SEEDED, root: true, reEnterOnRuleNodeWrites: false, updatedBy: null });

    const stored = await prisma.ruleChain.findUniqueOrThrow({ where: { id: SEEDED } });
    expect(stored.document).toEqual(defaultRootChainDocument());
    expect(stored.firstNodeId).toBe(defaultRootChainDocument().firstNodeId);

    const doc = defaultRootChainDocument();
    const nodes = await prisma.ruleNode.findMany({ where: { chainId: SEEDED }, orderBy: { index: 'asc' } });
    expect(nodes.map((n) => [n.id, n.type, n.name, n.x, n.y, n.index, n.debugMode])).toEqual(
      doc.nodes.map((n, i) => [n.id, n.type, n.name, n.x, n.y, i, n.debugMode]),
    );
    expect(nodes.map((n) => n.config)).toEqual(doc.nodes.map((n) => n.config));
    const conns = await prisma.ruleNodeConnection.findMany({ where: { chainId: SEEDED } });
    expect(conns.map((c) => `${c.fromNodeId}>${c.toNodeId}:${c.relation}`).sort()).toEqual(
      doc.connections.map((c) => `${c.from}>${c.to}:${c.relation}`).sort(),
    );
  });

  it('the service loads the root chain, indexed for the engine', async () => {
    const svc = await import('../modules/rule-engine/service.js');
    expect(svc.SEEDED_ROOT_CHAIN_ID).toBe(SEEDED);
    svc.invalidateChainCache();
    const root = await svc.getRootChain();
    expect(root?.id).toBe(SEEDED);
    expect(root?.nodesById.size).toBe(4);
    const sw = defaultRootChainDocument().nodes[0].id;
    expect(root?.outgoing.get(sw)?.get('Post telemetry')).toEqual([defaultRootChainDocument().nodes[1].id]);
    expect(await svc.getChain(randomUUID())).toBeNull();
  });
});

describe('create, save, delete', () => {
  it('POST / with a two-node document: 201, the row, the projection, one audit row with the whole document', async () => {
    const document = twoNodeDoc();
    const res = await send('POST', '/api/rule-chains', { name: `  Hot path ${S}  `, document, reason: REASON });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json() as Detail;
    chains.push(row.id);
    expect(row).toMatchObject({ name: `Hot path ${S}`, root: false, debugMode: false, reEnterOnRuleNodeWrites: false, updatedBy: NAME.sa });
    expect(row.document).toEqual(document);

    const nodes = await prisma.ruleNode.findMany({ where: { chainId: row.id }, orderBy: { index: 'asc' } });
    expect(nodes.map((n) => n.id)).toEqual(document.nodes.map((n) => n.id));
    expect(await prisma.ruleNodeConnection.count({ where: { chainId: row.id } })).toBe(1);
    const stored = await prisma.ruleChain.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ createdBy: NAME.sa, updatedBy: NAME.sa, firstNodeId: document.firstNodeId });

    const audit = await auditFor(row.id);
    expect(audit.map((a) => a.action)).toEqual(['RULE_CHAIN_CREATED']);
    expect(audit[0].afterValue.document).toEqual(document);
    expect(audit[0].afterValue.name).toBe(`Hot path ${S}`);
    expect(audit[0]).toMatchObject({ reason: REASON, userId: NAME.sa, targetType: 'rule_chain' });
  });

  it('POST / without a document starts empty; a name in use is 409 NAME_IN_USE', async () => {
    const row = await create(`Empty ${S}`);
    expect(row.document).toEqual(emptyRuleChainDocument());
    const list = (await get('/api/rule-chains')).json() as { data: any[] };
    expect(list.data.find((r) => r.id === row.id)?.nodeCount).toBe(0);

    const dup = await send('POST', '/api/rule-chains', { name: `Empty ${S}`, reason: REASON });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error).toBe('NAME_IN_USE');
  });

  it('a write without a reason is 400 REASON_REQUIRED and writes nothing', async () => {
    const before = await prisma.ruleChain.count();
    for (const reason of [undefined, '', '   ']) {
      const res = await send('POST', '/api/rule-chains', { name: `No reason ${S}`, ...(reason !== undefined ? { reason } : {}) });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe('REASON_REQUIRED');
    }
    expect(await prisma.ruleChain.count()).toBe(before);
  });

  it('PUT with a stale expectedUpdatedAt is 409 STALE and writes nothing', async () => {
    const row = await create(`Stale ${S}`, twoNodeDoc());
    // ONE millisecond off: the version check is exact, never a tolerance.
    const stale = new Date(Date.parse(row.updatedAt) - 1).toISOString();
    const res = await send('PUT', `/api/rule-chains/${row.id}`, { document: twoNodeDoc(), expectedUpdatedAt: stale, reason: REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('STALE');
    const stored = await prisma.ruleChain.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.document).toEqual(row.document);
    expect((await auditFor(row.id)).map((a) => a.action)).toEqual(['RULE_CHAIN_CREATED']);
  });

  it('PUT with an unknown node type is 400 naming the node, and writes nothing', async () => {
    const row = await create(`Unknown ${S}`, twoNodeDoc());
    const document = structuredClone(row.document);
    document.nodes[1] = { ...document.nodes[1], name: 'Mystery', type: 'tb:action:does-not-exist' };
    const res = await send('PUT', `/api/rule-chains/${row.id}`, { document, expectedUpdatedAt: row.updatedAt, reason: REASON });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    expect(res.json().message).toContain('Mystery');
    expect(res.json().message).toContain('tb:action:does-not-exist');
    const stored = await prisma.ruleChain.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.document).toEqual(row.document);
    expect(await prisma.ruleNode.count({ where: { chainId: row.id, type: 'tb:action:does-not-exist' } })).toBe(0);
  });

  it('a shape error inside a node names the node from the submitted document (Node "<name>", else Node #N)', async () => {
    const row = await create(`Shape ${S}`, twoNodeDoc());
    const bad = structuredClone(row.document) as any;
    bad.nodes[1].x = 'left';
    const res = await send('PUT', `/api/rule-chains/${row.id}`, { document: bad, expectedUpdatedAt: row.updatedAt, reason: REASON });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    expect(res.json().message).toContain('Node "Log hot": x — ');
    expect(res.json().message).not.toContain('nodes.1');

    const unnamed = structuredClone(row.document) as any;
    unnamed.nodes[1].name = '   ';
    unnamed.nodes[1].y = 'up';
    const res2 = await send('PUT', `/api/rule-chains/${row.id}`, { document: unnamed, expectedUpdatedAt: row.updatedAt, reason: REASON });
    expect(res2.statusCode, res2.body).toBe(400);
    expect(res2.json().message).toContain('Node #2: y — ');
    expect((await prisma.ruleChain.findUniqueOrThrow({ where: { id: row.id } })).document).toEqual(row.document);
  });

  it('PUT saves the whole document: the projection is rebuilt with the new ids, before / after audited; an unchanged save writes nothing', async () => {
    const row = await create(`Save ${S}`, twoNodeDoc());
    const next = twoNodeDoc(); // all new ids
    next.nodes[0].name = 'Renamed filter';
    const res = await send('PUT', `/api/rule-chains/${row.id}`, {
      name: `Save ${S} v2`, document: next, debugMode: true, reEnterOnRuleNodeWrites: true, expectedUpdatedAt: row.updatedAt, reason: 'Second cut',
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json() as Detail;
    expect(saved).toMatchObject({ name: `Save ${S} v2`, debugMode: true, reEnterOnRuleNodeWrites: true });
    expect(saved.document).toEqual(next);
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(row.updatedAt));
    const ids = (await prisma.ruleNode.findMany({ where: { chainId: row.id }, orderBy: { index: 'asc' } })).map((n) => n.id);
    expect(ids).toEqual(next.nodes.map((n) => n.id));
    const audit = await auditFor(row.id, 'RULE_CHAIN_UPDATED');
    expect(audit).toHaveLength(1);
    expect(audit[0].beforeValue.document).toEqual(row.document);
    expect(audit[0].afterValue.document).toEqual(next);
    expect(audit[0].afterValue).toMatchObject({ name: `Save ${S} v2`, debugMode: true, reEnterOnRuleNodeWrites: true });
    expect(audit[0].reason).toBe('Second cut');

    // The same save again: 200, nothing written, nothing audited.
    const again = await send('PUT', `/api/rule-chains/${row.id}`, { document: next, expectedUpdatedAt: saved.updatedAt, reason: 'No-op' });
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as Detail).updatedAt).toBe(saved.updatedAt);
    expect(await auditFor(row.id, 'RULE_CHAIN_UPDATED')).toHaveLength(1);
  });

  it('two chains may carry the same node ids (the key is chain + node)', async () => {
    const copy = await create(`Copy of root ${S}`, defaultRootChainDocument());
    expect(copy.document).toEqual(defaultRootChainDocument());
    expect(await prisma.ruleNode.count({ where: { id: defaultRootChainDocument().nodes[0].id } })).toBe(2);
  });

  it('the root chain cannot be deleted: 409 ROOT_CHAIN', async () => {
    const res = await send('DELETE', `/api/rule-chains/${SEEDED}`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('ROOT_CHAIN');
    expect(await prisma.ruleChain.count({ where: { id: SEEDED } })).toBe(1);
  });

  it('a chain a Rule chain node calls cannot be deleted: 409 CHAIN_IN_USE', async () => {
    const target = await create(`Callee ${S}`, twoNodeDoc());
    const call = node('tb:flow:rule-chain', 'Call callee', 100, 100, { ruleChainId: target.id, forwardMsgToDefaultRuleChain: false });
    const caller = await create(`Caller ${S}`, { version: 1, firstNodeId: call.id, nodes: [call], connections: [] });
    const res = await send('DELETE', `/api/rule-chains/${target.id}`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('CHAIN_IN_USE');
    expect(res.json().message).toContain(caller.name);
  });

  it('DELETE removes the chain, its projection and its debug events; one audit row with the document', async () => {
    const row = await create(`Delete me ${S}`, twoNodeDoc());
    await prisma.ruleNodeDebugEvent.create({
      data: { chainId: row.id, nodeId: row.document.nodes[0].id, direction: 'IN', msgId: randomUUID(), msgType: 'POST_TELEMETRY_REQUEST', originatorType: 'INSTRUMENT', originatorId: 'x', data: {}, metadata: {} },
    });
    const noReason = await send('DELETE', `/api/rule-chains/${row.id}`, {});
    expect(noReason.statusCode).toBe(400);
    const res = await send('DELETE', `/api/rule-chains/${row.id}`, { reason: 'Obsolete' });
    expect(res.statusCode, res.body).toBe(204);
    expect(await prisma.ruleChain.count({ where: { id: row.id } })).toBe(0);
    expect(await prisma.ruleNode.count({ where: { chainId: row.id } })).toBe(0);
    expect(await prisma.ruleNodeDebugEvent.count({ where: { chainId: row.id } })).toBe(0);
    const audit = await auditFor(row.id, 'RULE_CHAIN_DELETED');
    expect(audit).toHaveLength(1);
    expect(audit[0].beforeValue).toMatchObject({ name: `Delete me ${S}`, document: row.document });
    expect(audit[0].reason).toBe('Obsolete');
    const gone = await get(`/api/rule-chains/${row.id}`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('RULE_CHAIN_NOT_FOUND');
  });
});

describe('exactly one root', () => {
  it('POST /:id/root moves the root in one step; the old one is no longer root; updatedAt is untouched', async () => {
    const row = await create(`Next root ${S}`, twoNodeDoc());
    const seededBefore = await prisma.ruleChain.findUniqueOrThrow({ where: { id: SEEDED } });
    const svc = await import('../modules/rule-engine/service.js');
    try {
      const res = await send('POST', `/api/rule-chains/${row.id}/root`, { reason: 'Switch root' });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as Detail)).toMatchObject({ id: row.id, root: true });
      expect(await rootIds()).toEqual([row.id]);
      const seededAfter = await prisma.ruleChain.findUniqueOrThrow({ where: { id: SEEDED } });
      expect(seededAfter.root).toBe(false);
      expect(seededAfter.updatedAt.getTime()).toBe(seededBefore.updatedAt.getTime());
      expect((await prisma.ruleChain.findUniqueOrThrow({ where: { id: row.id } })).updatedAt.toISOString()).toBe(row.updatedAt);

      const audit = await auditFor(row.id, 'RULE_CHAIN_ROOT_CHANGED');
      expect(audit).toHaveLength(1);
      expect(audit[0].afterValue).toMatchObject({ name: `Next root ${S}`, root: true });
      expect(audit[0].beforeValue).toMatchObject({ name: `Next root ${S}`, root: false, previousRoot: { id: SEEDED, name: DEFAULT_ROOT_CHAIN_NAME } });

      // The service follows at once (the root cache is invalidated by the write).
      expect((await svc.getRootChain())?.id).toBe(row.id);

      // The new root is protected; making it root again changes nothing.
      expect((await send('DELETE', `/api/rule-chains/${row.id}`, { reason: REASON })).statusCode).toBe(409);
      const again = await send('POST', `/api/rule-chains/${row.id}/root`, { reason: 'again' });
      expect(again.statusCode).toBe(200);
      expect(await auditFor(row.id, 'RULE_CHAIN_ROOT_CHANGED')).toHaveLength(1);

      // And back: the seeded chain is the root again.
      const back = await send('POST', `/api/rule-chains/${SEEDED}/root`, { reason: 'Switch back' });
      expect(back.statusCode, back.body).toBe(200);
      expect(await rootIds()).toEqual([SEEDED]);
      expect((await svc.getRootChain())?.id).toBe(SEEDED);
    } finally {
      // A failure above must not leave another chain root for the cases below.
      await prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE root AND id <> ${SEEDED}::uuid`;
      await prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${SEEDED}::uuid`;
      svc.invalidateChainCache();
    }
  });
});

describe('ThingsBoard import / export', () => {
  it('an export imports back as the same chain: 201 { id, warnings: [] }', async () => {
    const row = await create(`Export me ${S}`, twoNodeDoc());
    const exp = await get(`/api/rule-chains/${row.id}/export`);
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.headers['content-disposition']).toMatch(/^attachment; filename=".+\.json"$/);
    const json = exp.json();
    expect(json.ruleChain).toMatchObject({ name: `Export me ${S}`, root: false });
    expect(ruleChainsEqual(fromThingsboardExport(json).document, row.document)).toBe(true);

    // The name is in use (the chain just exported): 409 unless a name is given.
    const clash = await send('POST', '/api/rule-chains/import', { json, reason: REASON });
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json().error).toBe('NAME_IN_USE');

    const res = await send('POST', '/api/rule-chains/import', { json: JSON.stringify(json), name: `Imported ${S}`, reason: 'From TB' });
    expect(res.statusCode, res.body).toBe(201);
    const { id, warnings } = res.json() as { id: string; warnings: string[] };
    chains.push(id);
    expect(warnings).toEqual([]);
    const imported = (await get(`/api/rule-chains/${id}`)).json() as Detail;
    expect(imported).toMatchObject({ name: `Imported ${S}`, root: false });
    expect(ruleChainsEqual(imported.document, row.document)).toBe(true);
    const audit = await auditFor(id);
    expect(audit.map((a) => a.action)).toEqual(['RULE_CHAIN_IMPORTED']);
    expect(audit[0].afterValue).toMatchObject({ name: `Imported ${S}`, warnings: [] });
    expect(audit[0].afterValue.document).toEqual(imported.document);
  });

  it('an export of the ROOT chain imports as a non-root chain', async () => {
    const json = toThingsboardExport(`TB root ${S}`, true, defaultRootChainDocument());
    const res = await send('POST', '/api/rule-chains/import', { json, reason: REASON });
    expect(res.statusCode, res.body).toBe(201);
    chains.push(res.json().id);
    expect(res.json().warnings).toEqual([]);
    expect(await rootIds()).toEqual([SEEDED]);
  });

  it('a file that is not a ThingsBoard export is 400 IMPORT_INVALID', async () => {
    const res = await send('POST', '/api/rule-chains/import', { json: 'not json at all', reason: REASON });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('IMPORT_INVALID');
  });

  it('the export MASKS credentials (ruling S-5); a masked export still imports as the same node types', async () => {
    const rest = node('tb:external:rest-api-call', 'Call MES', 100, 100, {
      ...newRuleNodeConfig('tb:external:rest-api-call'),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekret-bearer' },
      credentials: { type: 'basic', username: 'mesuser', password: 'sekret-pass' },
    });
    const slack = node('tb:external:send-to-slack', 'Tell Slack', 300, 100, { ...newRuleNodeConfig('tb:external:send-to-slack'), botToken: 'xoxb-sekret-token' });
    const mqtt = node('tb:external:mqtt', 'Broker', 500, 100, {
      ...newRuleNodeConfig('tb:external:mqtt'), host: 'broker.local',
      credentials: { type: 'cert.PEM', caCert: 'CA-PEM', cert: 'CERT-PEM', privateKey: 'sekret-key', password: 'sekret-keypass' },
    });
    const row = await create(`Secrets ${S}`, { version: 1, firstNodeId: rest.id, nodes: [rest, slack, mqtt], connections: [] });

    const exp = await get(`/api/rule-chains/${row.id}/export`);
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.body).not.toMatch(/sekret/);
    const json = exp.json();
    const cfg = (i: number) => json.metadata.nodes[i].configuration;
    expect(cfg(0).credentials).toEqual({ type: 'basic', username: 'mesuser', password: '***' });
    expect(cfg(0).headers).toEqual({ 'Content-Type': 'application/json', Authorization: '***' });
    expect(cfg(1).botToken).toBe('***');
    expect(cfg(2).credentials).toEqual({ type: 'cert.PEM', caCert: 'CA-PEM', cert: 'CERT-PEM', privateKey: '***', password: '***' });
    // The stored chain is untouched by the mask.
    expect(((await prisma.ruleChain.findUniqueOrThrow({ where: { id: row.id } })).document as any).nodes[1].config.botToken).toBe('xoxb-sekret-token');

    const back = fromThingsboardExport(json);
    expect(back.warnings).toEqual([]);
    expect(back.document.nodes.map((n) => n.type)).toEqual(['tb:external:rest-api-call', 'tb:external:send-to-slack', 'tb:external:mqtt']);
    expect(back.document.nodes[1].config.botToken).toBe('***');
  });
});

describe('gates', () => {
  it('reads need RULE_CHAIN_READ; MANAGE implies it', async () => {
    expect((await get('/api/rule-chains', no)).statusCode).toBe(403);
    expect((await get(`/api/rule-chains/${SEEDED}`, no)).statusCode).toBe(403);
    expect((await get('/api/rule-chains/node-types', no)).statusCode).toBe(403);
    expect((await get('/api/rule-chains', rd)).statusCode).toBe(200);
    expect((await get(`/api/rule-chains/${SEEDED}`, rd)).statusCode).toBe(200);
    expect((await get(`/api/rule-chains/${SEEDED}/export`, rd)).statusCode).toBe(200);
    expect((await get('/api/rule-chains', mg)).statusCode).toBe(200);
  });

  it('a READ-only user is refused every write with 403, before the body is validated', async () => {
    const row = await create(`Gate ${S}`, twoNodeDoc());
    const cases: [string, string, Record<string, unknown>][] = [
      // Bodies the schema REFUSES still answer 403: the permission is checked before the body is.
      ['POST', '/api/rule-chains', { name: `RO ${S}`, document: 'not an object', reason: REASON }],
      ['PUT', `/api/rule-chains/${row.id}`, { reason: REASON }], // no document, no expectedUpdatedAt
      ['POST', '/api/rule-chains/import', { reason: REASON }], // no json
      ['POST', '/api/rule-chains', { name: `RO ${S}`, reason: REASON }],
      ['PUT', `/api/rule-chains/${row.id}`, { document: row.document, expectedUpdatedAt: row.updatedAt, reason: REASON }],
      ['DELETE', `/api/rule-chains/${row.id}`, { reason: REASON }],
      ['POST', `/api/rule-chains/${row.id}/root`, { reason: REASON }],
      ['POST', '/api/rule-chains/import', { json: toThingsboardExport('x', false, twoNodeDoc()), reason: REASON }],
      ['DELETE', `/api/rule-chains/${row.id}/debug`, { reason: REASON }],
      ['POST', '/api/rule-chains/test-script', { scriptType: 'filter', script: 'return true;', msg: {}, metadata: {}, msgType: 'POST_TELEMETRY_REQUEST' }],
      ['POST', '/api/rule-engine/v1/messages', { data: {} }],
    ];
    for (const [method, url, body] of cases) {
      const res = await send(method as 'POST', url, body, rd);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
    }
    expect(await prisma.ruleChain.count({ where: { name: `RO ${S}` } })).toBe(0);
  });

  it('a MANAGE holder writes; with re-auth ON for UPDATE_RULE_CHAIN EVERY write is 401 without the password, then succeeds with it', async () => {
    const ok = await send('POST', '/api/rule-chains', { name: `By manager ${S}`, reason: REASON }, mg);
    expect(ok.statusCode, ok.body).toBe(201);
    chains.push(ok.json().id);
    expect(ok.json().updatedBy).toBe(NAME.mg);

    // Fixtures written before re-auth is switched on (the super admin's role is not in the policy anyway).
    const edit = await create(`Reauth edit ${S}`, twoNodeDoc());
    const doomed = await create(`Reauth delete ${S}`, twoNodeDoc());
    await prisma.ruleNodeDebugEvent.create({
      data: { chainId: edit.id, nodeId: edit.document.nodes[0].id, direction: 'IN', msgId: randomUUID(), msgType: 'POST_TELEMETRY_REQUEST', originatorType: 'INSTRUMENT', originatorId: 'x', data: {}, metadata: {} },
    });
    const renamed = structuredClone(edit.document);
    renamed.nodes[0].name = 'Renamed under re-auth';

    const cases: { what: string; method: 'POST' | 'PUT' | 'DELETE'; url: string; body: Record<string, unknown>; status: number; untouched: () => Promise<void> }[] = [
      {
        what: 'create', method: 'POST', url: '/api/rule-chains', body: { name: `Reauth create ${S}`, reason: REASON }, status: 201,
        untouched: async () => expect(await prisma.ruleChain.count({ where: { name: `Reauth create ${S}` } })).toBe(0),
      },
      {
        what: 'save', method: 'PUT', url: `/api/rule-chains/${edit.id}`, body: { document: renamed, expectedUpdatedAt: edit.updatedAt, reason: REASON }, status: 200,
        untouched: async () => expect((await prisma.ruleChain.findUniqueOrThrow({ where: { id: edit.id } })).document).toEqual(edit.document),
      },
      {
        what: 'clear debug', method: 'DELETE', url: `/api/rule-chains/${edit.id}/debug`, body: { reason: REASON }, status: 204,
        untouched: async () => expect(await prisma.ruleNodeDebugEvent.count({ where: { chainId: edit.id } })).toBe(1),
      },
      {
        what: 'import', method: 'POST', url: '/api/rule-chains/import', body: { json: toThingsboardExport('x', false, twoNodeDoc()), name: `Reauth import ${S}`, reason: REASON }, status: 201,
        untouched: async () => expect(await prisma.ruleChain.count({ where: { name: `Reauth import ${S}` } })).toBe(0),
      },
      {
        what: 'make root', method: 'POST', url: `/api/rule-chains/${edit.id}/root`, body: { reason: REASON }, status: 200,
        untouched: async () => expect(await rootIds()).toEqual([SEEDED]),
      },
      {
        what: 'delete', method: 'DELETE', url: `/api/rule-chains/${doomed.id}`, body: { reason: REASON }, status: 204,
        untouched: async () => expect(await prisma.ruleChain.count({ where: { id: doomed.id } })).toBe(1),
      },
    ];

    const current = (reauthBefore?.configValue as Record<string, unknown> | undefined) ?? {};
    await storeConfig('action-reauth', { ...current, UPDATE_RULE_CHAIN: [MGR] }, reauthBefore?.configType ?? 'security');
    invalidateReauthCache();
    try {
      for (const c of cases) {
        const refused = await send(c.method, c.url, { ...c.body }, mg);
        expect(refused.statusCode, `${c.what} without the password: ${refused.body}`).toBe(401);
        expect(refused.json().error, c.what).toBe('REAUTH_REQUIRED');
        await c.untouched();
        const done = await send(c.method, c.url, { ...c.body, _currentPassword: PW }, mg);
        expect(done.statusCode, `${c.what} with the password: ${done.body}`).toBe(c.status);
        if (c.status === 201) chains.push(done.json().id);
      }
      expect(await rootIds()).toEqual([edit.id]);
      expect(await prisma.ruleChain.count({ where: { id: doomed.id } })).toBe(0);
    } finally {
      await restoreConfig('action-reauth', reauthBefore);
      invalidateReauthCache();
      // The root moved to `edit` above: back to the seeded chain for every later case.
      await prisma.$executeRaw`UPDATE rule_chains SET root = false WHERE root AND id <> ${SEEDED}::uuid`;
      await prisma.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${SEEDED}::uuid`;
      (await import('../modules/rule-engine/service.js')).invalidateChainCache();
    }
  });
});

describe('catalogue, stats, stubs', () => {
  it('GET /node-types: the 86 node types with their status, without the zod schema', async () => {
    const res = await get('/api/rule-chains/node-types', rd);
    expect(res.statusCode, res.body).toBe(200);
    const data = (res.json() as { data: any[] }).data;
    expect(data).toHaveLength(86);
    expect(data).toHaveLength(RULE_NODE_TYPES.length);
    const by = (st: string) => data.filter((d) => d.status === st).length;
    // 46 / 10 / 30 until 2026-11-04: Device profile (deprecated) became a built pass-through.
    expect([by('built'), by('later'), by('none')]).toEqual([47, 10, 29]);
    for (const d of data) expect(d).not.toHaveProperty('configSchema');
    const sw = data.find((d) => d.id === 'tb:filter:message-type-switch');
    expect(sw).toMatchObject({ tbClass: 'org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode', group: 'filter', label: expect.any(String), status: 'built' });
    expect(Array.isArray(sw.relations)).toBe(true);
    expect(sw.relations).toContain('Post telemetry');
    const script = data.find((d) => d.id === 'tb:filter:script');
    expect(script.fields.length).toBeGreaterThan(0);
    expect(script.fields[0]).toHaveProperty('key');
    expect(script.defaultConfig).toHaveProperty('jsScript');
    expect(data.find((d) => d.id === 'tb:filter:switch').relations).toBe('dynamic');
  });

  it('with the engine NOT started (this file never starts it): /stats answers zeros, the inject route accepts nothing; test-script runs regardless', async () => {
    const stats = await get('/api/rule-chains/stats', rd);
    expect(stats.statusCode, stats.body).toBe(200);
    expect(stats.json()).toEqual({ enabled: true, queueDepth: 0, dropped: 0, processedLastMinute: 0, chains: [] });

    // Task 3 wired it to the engine's script VM (src/e2e/rule-engine.e2e.test.ts covers it with the engine running).
    const script = await send('POST', '/api/rule-chains/test-script', { scriptType: 'filter', script: 'return true;', msg: {}, metadata: {}, msgType: 'POST_TELEMETRY_REQUEST' });
    expect(script.statusCode, script.body).toBe(200);
    expect(script.json()).toEqual({ result: true });

    const inject = await send('POST', '/api/rule-engine/v1/messages', { type: 'REST_API_REQUEST', data: { a: 1 }, metadata: { k: 'v' } });
    expect(inject.statusCode, inject.body).toBe(202);
    expect(inject.json()).toEqual({ accepted: false, reason: 'ENGINE_NOT_STARTED' });
    expect((await send('POST', '/api/rule-engine/v1/messages', { data: {} }, mg)).statusCode).toBe(202);
  });
});

describe('debug events', () => {
  it('GET /:id/debug lists a chain\'s events newest first, by node, before a time; DELETE clears them, audited', async () => {
    const row = await create(`Debug ${S}`, twoNodeDoc());
    const [a, b] = row.document.nodes.map((n) => n.id);
    const base = Date.now() - 10_000;
    for (let i = 0; i < 3; i++) {
      await prisma.ruleNodeDebugEvent.create({
        data: {
          chainId: row.id, nodeId: i < 2 ? a : b, ts: new Date(base + i * 1000), direction: i === 1 ? 'OUT' : 'IN', relation: i === 1 ? 'True' : null,
          msgId: `m-${i}`, msgType: 'POST_TELEMETRY_REQUEST', originatorType: 'INSTRUMENT', originatorId: 'inst-1',
          data: { ts: base, values: { temperature: 20 + i } }, metadata: { instrumentCode: 'C-1', ts: String(base) }, error: i === 2 ? 'boom' : null,
        },
      });
    }
    const all = await get(`/api/rule-chains/${row.id}/debug`, rd);
    expect(all.statusCode, all.body).toBe(200);
    const events = (all.json() as { data: any[] }).data;
    expect(events.map((e) => e.msgId)).toEqual(['m-2', 'm-1', 'm-0']);
    expect(typeof events[0].id).toBe('string');
    // Every field survives the response filter, inner keys included.
    expect(events[1]).toMatchObject({
      chainId: row.id, nodeId: a, direction: 'OUT', relation: 'True', msgType: 'POST_TELEMETRY_REQUEST',
      originatorType: 'INSTRUMENT', originatorId: 'inst-1', data: { values: { temperature: 21 } }, metadata: { instrumentCode: 'C-1' }, error: null,
    });
    expect(events[0].error).toBe('boom');
    expect(Date.parse(events[0].ts)).toBe(base + 2000);

    const byNode = (await get(`/api/rule-chains/${row.id}/debug?nodeId=${a}`, rd)).json() as { data: any[] };
    expect(byNode.data.map((e) => e.msgId)).toEqual(['m-1', 'm-0']);
    const before = (await get(`/api/rule-chains/${row.id}/debug?before=${encodeURIComponent(new Date(base + 1500).toISOString())}&limit=1`, rd)).json() as { data: any[] };
    expect(before.data.map((e) => e.msgId)).toEqual(['m-1']);

    expect((await send('DELETE', `/api/rule-chains/${row.id}/debug`, {})).statusCode).toBe(400);
    const cleared = await send('DELETE', `/api/rule-chains/${row.id}/debug`, { reason: 'Clear debug' });
    expect(cleared.statusCode, cleared.body).toBe(204);
    expect(await prisma.ruleNodeDebugEvent.count({ where: { chainId: row.id } })).toBe(0);
    const audit = await auditFor(row.id, 'RULE_CHAIN_DEBUG_CLEARED');
    expect(audit).toHaveLength(1);
    expect(audit[0].afterValue).toMatchObject({ name: `Debug ${S}`, deleted: 3 });
    expect(audit[0].reason).toBe('Clear debug');
  });
});

describe('Configuration → Rule Engine', () => {
  it('both defs serve their defaults through the dynamic config routes', async () => {
    // A fresh row from the def's own defaults (the registry seeds the same values).
    await prisma.systemConfig.deleteMany({ where: { configKey: { in: ['rule-engine', 'rule-engine-attributes'] } } });
    const { configRegistry } = await import('../lib/config-registry.js');
    await configRegistry.seedDefaults();
    const engine = await get('/api/config/dynamic/rule-engine');
    expect(engine.statusCode, engine.body).toBe(200);
    expect(engine.json()).toEqual({
      enabled: true, skipSaveNodesForIngestOrigin: true, scriptTimeoutMs: 2000, queueCapacity: 10000, concurrency: 8,
      debugRetentionHours: 24, debugMaxEventsPerNode: 1000, httpTimeoutMs: 10000, hopLimit: 200,
    });
    const attrs = await get('/api/config/dynamic/rule-engine-attributes');
    expect(attrs.statusCode, attrs.body).toBe(200);
    expect(attrs.json()).toEqual({ attributes: [] });
    // SUPER_ADMIN only.
    expect((await get('/api/config/dynamic/rule-engine', mg)).statusCode).toBe(403);
  });

  it('the readers follow a save at once; bad values are refused by field', async () => {
    const cfg = await import('../modules/rule-engine/config.js');
    const body = {
      enabled: false, skipSaveNodesForIngestOrigin: false, scriptTimeoutMs: 500, queueCapacity: 2000, concurrency: 2,
      debugRetentionHours: 6, debugMaxEventsPerNode: 50, httpTimeoutMs: 3000, hopLimit: 50,
    };
    expect((await cfg.getRuleEngineConfig()).enabled).toBe(true); // primes the 10 s cache
    const put = await send('PUT', '/api/config/dynamic/rule-engine', body);
    expect(put.statusCode, put.body).toBe(200);
    expect(await cfg.getRuleEngineConfig()).toEqual(body);
    expect((await get('/api/rule-chains/stats')).json().enabled).toBe(false);

    const tooLong = await send('PUT', '/api/config/dynamic/rule-engine', { ...body, scriptTimeoutMs: 999_999 });
    expect(tooLong.statusCode, tooLong.body).toBe(400);
    const partial = await send('PUT', '/api/config/dynamic/rule-engine', { enabled: true });
    expect(partial.statusCode, partial.body).toBe(400);

    expect(await cfg.getApplicationAttributes()).toEqual({});
    const attrs = await send('PUT', '/api/config/dynamic/rule-engine-attributes', { attributes: [{ key: 'site', value: 'Gagillapur' }, { key: 'line', value: 'L2' }] });
    expect(attrs.statusCode, attrs.body).toBe(200);
    expect(await cfg.getApplicationAttributes()).toEqual({ site: 'Gagillapur', line: 'L2' });
    const dup = await send('PUT', '/api/config/dynamic/rule-engine-attributes', { attributes: [{ key: 'site', value: 'a' }, { key: 'SITE', value: 'b' }] });
    expect(dup.statusCode, dup.body).toBe(400);
    const blank = await send('PUT', '/api/config/dynamic/rule-engine-attributes', { attributes: [{ key: '  ', value: 'a' }] });
    expect(blank.statusCode, blank.body).toBe(400);

    // Back to the shipped values for the rest of the suite and the next one.
    await restoreConfig('rule-engine', engineBefore);
    await restoreConfig('rule-engine-attributes', attrsBefore);
    cfg.invalidateRuleEngineConfigCache();
  });
});

describe('credentials (ruling T2-B)', () => {
  /** A REST node on basic credentials with an Authorization header, and a Slack node. */
  function secretDoc(): RuleChainDocument {
    const rest = node('tb:external:rest-api-call', 'Call MES', 100, 100, {
      ...newRuleNodeConfig('tb:external:rest-api-call'),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekret-bearer' },
      credentials: { type: 'basic', username: 'mesuser', password: 'sekret-pass' },
    });
    const slack = node('tb:external:send-to-slack', 'Tell Slack', 300, 100, { ...newRuleNodeConfig('tb:external:send-to-slack'), botToken: 'xoxb-sekret-token' });
    return { version: 1, firstNodeId: rest.id, nodes: [rest, slack], connections: [{ from: rest.id, to: slack.id, relation: 'Success' }] };
  }
  const cfgOf = (d: Detail | RuleChainDocument, i: number) => ('document' in d ? d.document : d).nodes[i].config as any;
  const storedDoc = async (id: string) => (await prisma.ruleChain.findUniqueOrThrow({ where: { id } })).document as unknown as RuleChainDocument;
  const auditText = async (id: string) => JSON.stringify(await auditFor(id));

  it('GET /:id masks credentials for a READ-only caller; a MANAGE holder reads the values', async () => {
    const row = await create(`Creds read ${S}`, secretDoc());
    const asReader = await get(`/api/rule-chains/${row.id}`, rd);
    expect(asReader.statusCode, asReader.body).toBe(200);
    expect(asReader.body).not.toMatch(/sekret/);
    const masked = asReader.json() as Detail;
    expect(cfgOf(masked, 0).credentials).toEqual({ type: 'basic', username: 'mesuser', password: '***' });
    expect(cfgOf(masked, 0).headers).toEqual({ 'Content-Type': 'application/json', Authorization: '***' });
    expect(cfgOf(masked, 1).botToken).toBe('***');

    for (const who of [mg, sa]) {
      const full = (await get(`/api/rule-chains/${row.id}`, who)).json() as Detail;
      expect(cfgOf(full, 0).credentials.password).toBe('sekret-pass');
      expect(cfgOf(full, 0).headers.Authorization).toBe('Bearer sekret-bearer');
      expect(cfgOf(full, 1).botToken).toBe('xoxb-sekret-token');
    }
  });

  it('a save that sends "***" KEEPS the stored secret; a new value replaces it; audit rows never hold one', async () => {
    const row = await create(`Creds save ${S}`, secretDoc());
    // The editor sends back the masked document it was shown, with a rename.
    const masked = (await get(`/api/rule-chains/${row.id}`, rd)).json() as Detail;
    const sent = structuredClone(masked.document);
    sent.nodes[1].name = 'Tell Slack v2';
    const res = await send('PUT', `/api/rule-chains/${row.id}`, { document: sent, expectedUpdatedAt: row.updatedAt, reason: 'Rename' }, mg);
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json() as Detail;
    expect(cfgOf(saved, 0).credentials.password).toBe('sekret-pass');
    expect(cfgOf(saved, 1)).toMatchObject({ botToken: 'xoxb-sekret-token' });
    const back = (await get(`/api/rule-chains/${row.id}`, mg)).json() as Detail;
    expect(cfgOf(back, 0).credentials.password).toBe('sekret-pass');
    expect(cfgOf(back, 0).headers.Authorization).toBe('Bearer sekret-bearer');
    expect(cfgOf(back, 1).botToken).toBe('xoxb-sekret-token');
    expect(back.document.nodes[1].name).toBe('Tell Slack v2');
    expect(cfgOf(await storedDoc(row.id), 0).credentials.password).toBe('sekret-pass');
    expect((await prisma.ruleNode.findFirstOrThrow({ where: { chainId: row.id, id: back.document.nodes[1].id } })).config).toMatchObject({ botToken: 'xoxb-sekret-token' });

    // Sending "***" for everything and changing nothing else is no change at all.
    const again = await send('PUT', `/api/rule-chains/${row.id}`, { document: sent, expectedUpdatedAt: saved.updatedAt, reason: 'No-op' }, mg);
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as Detail).updatedAt).toBe(saved.updatedAt);

    // A new password replaces the stored one; the audit row names it, never shows it.
    const next = structuredClone(back.document);
    (next.nodes[0].config as any).credentials.password = 'sekret-new';
    const changed = await send('PUT', `/api/rule-chains/${row.id}`, { document: next, expectedUpdatedAt: back.updatedAt, reason: 'Rotate' }, mg);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(cfgOf(await storedDoc(row.id), 0).credentials.password).toBe('sekret-new');
    const updates = await auditFor(row.id, 'RULE_CHAIN_UPDATED');
    expect(updates).toHaveLength(2);
    expect(updates[0].afterValue.secretsChanged).toBeUndefined();
    expect(updates[1].afterValue.secretsChanged).toEqual(['Node "Call MES": credentials.password']);
    expect(updates[1].afterValue.document.nodes[0].config.credentials).toEqual({ type: 'basic', username: 'mesuser', password: '***' });
    expect(await auditText(row.id)).not.toMatch(/sekret/);
  });

  it('a NEW node sent with "***" has nothing to keep: it stays "***"', async () => {
    const row = await create(`Creds new node ${S}`, twoNodeDoc());
    const doc = structuredClone(row.document);
    doc.nodes.push(node('tb:external:send-to-slack', 'New Slack', 600, 100, { ...newRuleNodeConfig('tb:external:send-to-slack'), botToken: '***' }));
    const res = await send('PUT', `/api/rule-chains/${row.id}`, { document: doc, expectedUpdatedAt: row.updatedAt, reason: 'Add Slack' }, mg);
    expect(res.statusCode, res.body).toBe(200);
    expect(cfgOf(await storedDoc(row.id), 2).botToken).toBe('***');
  });

  it('a node that keeps its id but changes TYPE inherits no secret from what it was', async () => {
    const row = await create(`Creds retype ${S}`, secretDoc());
    const doc = structuredClone(row.document);
    const rest = doc.nodes[0];
    doc.nodes[0] = {
      ...rest, type: 'tb:external:mqtt', name: 'Now MQTT',
      config: { ...newRuleNodeConfig('tb:external:mqtt'), host: 'broker.local', credentials: { type: 'basic', username: 'mesuser', password: '***' } },
    };
    const res = await send('PUT', `/api/rule-chains/${row.id}`, { document: doc, expectedUpdatedAt: row.updatedAt, reason: 'Retype' }, mg);
    expect(res.statusCode, res.body).toBe(200);
    expect(cfgOf(await storedDoc(row.id), 0).credentials.password).toBe('***');
  });

  it('export → import: the masked credentials stay "***" and the response names each node whose credential must be entered', async () => {
    const row = await create(`Creds export ${S}`, secretDoc());
    const exp = await get(`/api/rule-chains/${row.id}/export`, mg);
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.body).not.toMatch(/sekret/);
    const res = await send('POST', '/api/rule-chains/import', { json: exp.json(), name: `Creds imported ${S}`, reason: 'From file' }, mg);
    expect(res.statusCode, res.body).toBe(201);
    const { id, warnings } = res.json() as { id: string; warnings: string[] };
    chains.push(id);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Node "Call MES": credential must be entered \(.*credentials\.password.*\)/);
    expect(warnings[0]).toContain('headers.Authorization');
    expect(warnings[1]).toMatch(/^Node "Tell Slack": credential must be entered \(botToken\)/);
    const stored = await storedDoc(id);
    expect(cfgOf(stored, 0).credentials).toEqual({ type: 'basic', username: 'mesuser', password: '***' });
    expect(cfgOf(stored, 1).botToken).toBe('***');
    expect(stored.nodes.map((n) => n.type)).toEqual(['tb:external:rest-api-call', 'tb:external:send-to-slack']);
    const audit = await auditFor(id, 'RULE_CHAIN_IMPORTED');
    expect(audit[0].afterValue.warnings).toEqual(warnings);
    // The original's audit rows hold no secret either.
    expect(await auditText(row.id)).not.toMatch(/sekret/);
  });
});

describe('the audit userId guard (ruling T2-A)', () => {
  it('INSTRUMENT_ATTRIBUTE_SET / _REMOVED with no user still throw: a rule node writes them as SYSTEM', async () => {
    const { auditLog } = await import('../lib/audit.js');
    for (const action of ['INSTRUMENT_ATTRIBUTE_SET', 'INSTRUMENT_ATTRIBUTE_REMOVED']) {
      await expect(auditLog({ action, targetType: 'Instrument', targetId: randomUUID() }))
        .rejects.toThrow(`audit.userId required for action='${action}'`);
    }
  });
});
