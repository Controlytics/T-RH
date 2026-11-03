import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Prisma, RuleChain } from '@prisma/client';
import { RULE_NODE_TYPES, toRuleNodeTypeDescriptor, readRuleChainDocument } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { getRuleEngineConfig } from './config.js';
import {
  idParams, listResponse, detailResponse, createdResponse, noContentResponse, importResponse, exportResponse,
  nodeTypesResponse, debugQuery, debugResponse, statsResponse, createBody, updateBody, reasonBody, clearDebugBody,
  importBody, testScriptBody, injectBody, injectResponse,
} from './schemas.js';
import {
  saveChain, setRoot, deleteChain, listDebug, clearDebug, actorOf, cleanReason, invalidateChainCache, nameConflictOf,
  RULE_CHAIN_WRITE_TX,
} from './service.js';
import { exportChain, exportFileName, importChain } from './import-export.js';

/**
 * `/api/rule-chains` — rule chains (Task 2 of the rule-chains plan; spec
 * docs/superpowers/specs/2026-11-03-rule-chains-design.md §9, §12).
 *
 * - **Reads** need RULE_CHAIN_READ; RULE_CHAIN_MANAGE implies it (the
 *   `_READ ← _MANAGE` rule `requirePermission` applies).
 * - **Every write, in this order:** RULE_CHAIN_MANAGE by PERMISSION (403, in
 *   `preValidation`, so a refused caller is a 403 whatever body it sent — the
 *   spec grants MANAGE to roles, so this is not SUPER_ADMIN-by-role) → the
 *   chain exists (404) → `enforceReauth('UPDATE_RULE_CHAIN')` (ships OFF) →
 *   the reason (400 REASON_REQUIRED) and the document (400 naming the node) →
 *   ONE transaction holding the write and its audit row with the whole
 *   document before / after. The chain cache is invalidated after the commit.
 * - The DOCUMENT is the source of truth; the node / connection rows are its
 *   projection, rebuilt by `saveChain` (service.ts).
 * - Exactly one root: `POST /:id/root` moves it (`setRoot`); the root cannot
 *   be deleted (409 ROOT_CHAIN), nor can a chain another chain calls (409
 *   CHAIN_IN_USE).
 * - The export masks credentials (ruling S-5, import-export.ts). `GET /:id`
 *   does NOT: the editor (Task 7) shows a stored secret masked itself.
 * - `/stats`, `/test-script` and `POST /api/rule-engine/v1/messages` answer
 *   stubs until the engine exists (Task 3 wires them).
 */
export const UPDATE_RULE_CHAIN_ACTION = 'UPDATE_RULE_CHAIN';
const READ = 'RULE_CHAIN_READ';
const MANAGE = 'RULE_CHAIN_MANAGE';
const ENGINE_NOT_STARTED = 'ENGINE_NOT_STARTED';

/** The catalogue as the palette reads it — every node type, without its zod schema. Built once. */
const NODE_TYPE_DESCRIPTORS = RULE_NODE_TYPES.map(toRuleNodeTypeDescriptor);

type DetailRow = Pick<RuleChain, 'id' | 'name' | 'root' | 'debugMode' | 'reEnterOnRuleNodeWrites' | 'document' | 'updatedAt' | 'updatedBy'>;

/** One chain on the wire. The stored document is read FORGIVINGLY: one bad node never blanks a chain. */
export function presentDetail(row: DetailRow) {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    debugMode: row.debugMode,
    reEnterOnRuleNodeWrites: row.reEnterOnRuleNodeWrites,
    document: readRuleChainDocument(row.document),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/** Root first, then by name ignoring case (`accent`: A = a, a ≠ á), then by id. */
function byRootThenName(a: { root: boolean; name: string; id: string }, b: { root: boolean; name: string; id: string }): number {
  if (a.root !== b.root) return a.root ? -1 : 1;
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'accent' }) || a.id.localeCompare(b.id);
}

/** A write transaction; a P2002 on the chain name (two creates racing past the pre-check) answers 409 NAME_IN_USE. */
async function writeTx<T>(name: unknown, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn, RULE_CHAIN_WRITE_TX);
  } catch (err) {
    const conflict = nameConflictOf(err, typeof name === 'string' ? name.trim() : '');
    if (conflict) throw conflict;
    throw err;
  }
}

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'RULE_CHAIN_NOT_FOUND', message: 'Rule chain not found.' });

const exists = async (id: string) =>
  (await prisma.ruleChain.findUnique({ where: { id }, select: { id: true } })) !== null;

export default async function ruleChainRoutes(app: FastifyInstance) {
  const canRead = { preValidation: [app.requirePermission(READ)] };
  const canManage = { preValidation: [app.requirePermission(MANAGE)] };

  // ─── LIST ──────────────────────────────────────────────
  app.get('/', {
    ...canRead,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Every rule chain',
      description: 'The root chain first, then by name ignoring case. `nodeCount` is the number of nodes in the chain\'s document.',
      response: listResponse,
    },
  }, async () => {
    const rows = await prisma.ruleChain.findMany({
      select: { id: true, name: true, root: true, debugMode: true, updatedAt: true, updatedBy: true, _count: { select: { nodes: true } } },
    });
    rows.sort(byRootThenName);
    return {
      data: rows.map((r) => ({
        id: r.id, name: r.name, root: r.root, debugMode: r.debugMode, nodeCount: r._count.nodes,
        updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy,
      })),
    };
  });

  // ─── NODE TYPES ────────────────────────────────────────
  app.get('/node-types', {
    ...canRead,
    schema: {
      tags: ['Rule Chains'],
      summary: 'The rule node catalogue',
      description: 'Every ThingsBoard node type (86): group, label, description, status (built / later / none), relations, configuration fields and defaults. The configuration schema stays on the server.',
      response: nodeTypesResponse,
    },
  }, async () => ({ data: NODE_TYPE_DESCRIPTORS }));

  // ─── STATS (Task 3 fills) ──────────────────────────────
  app.get('/stats', {
    ...canRead,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Rule engine statistics',
      description: 'Whether the engine is switched on (Configuration → Rule Engine), the queue depth, messages dropped, messages processed in the last minute, per chain. Zeros until the engine runs.',
      response: statsResponse,
    },
  }, async () => ({
    enabled: (await getRuleEngineConfig()).enabled,
    queueDepth: 0,
    dropped: 0,
    processedLastMinute: 0,
    chains: [] as { id: string; processedLastMinute: number }[],
  }));

  // ─── TEST SCRIPT (Task 3 wires) ────────────────────────
  app.post('/test-script', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Run a node script against a sample message',
      description: 'The editor\'s Test script button. 503 ENGINE_NOT_STARTED until the rule engine exists.',
      body: testScriptBody,
    },
  }, async (_req, reply) =>
    reply.code(503).send({ error: ENGINE_NOT_STARTED, message: 'The rule engine is not running yet, so a script cannot be tested.' }));

  // ─── IMPORT ────────────────────────────────────────────
  app.post('/import', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Import a ThingsBoard rule chain export',
      description: 'The export as an object or its JSON text. Never made root. An unknown node class imports as an Unsupported node with a warning. `name` overrides the export\'s name; a name in use is 409 NAME_IN_USE. Re-auth action UPDATE_RULE_CHAIN; `reason` required.',
      body: importBody,
      response: importResponse,
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(UPDATE_RULE_CHAIN_ACTION, req, reply);
    if (!ok) return;
    const body = req.body as { json: unknown; name?: string; reason?: string };
    cleanReason(body.reason);
    const imported = importChain(body.json);
    const name = body.name ?? imported.name;
    const outcome = await writeTx(name, (tx) =>
      saveChain(tx, null, { name, document: imported.document, reason: body.reason, importWarnings: imported.warnings }, actorOf(req)));
    invalidateChainCache(outcome.row.id);
    return reply.code(201).send({ id: outcome.row.id, warnings: imported.warnings });
  });

  // ─── ONE ───────────────────────────────────────────────
  app.get('/:id', {
    ...canRead,
    schema: {
      tags: ['Rule Chains'],
      summary: 'One rule chain with its document',
      description: 'The stored document read forgivingly: a node that no longer passes its type reads as Unsupported, a dangling connection is dropped.',
      params: idParams,
      response: detailResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.ruleChain.findUnique({ where: { id } });
    if (!row) return notFound(reply);
    return presentDetail(row);
  });

  // ─── EXPORT ────────────────────────────────────────────
  app.get('/:id/export', {
    ...canRead,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Export a rule chain as ThingsBoard JSON',
      description: 'A file (Content-Disposition: attachment). Every credential in a node\'s configuration is masked as "***" (ruling S-5).',
      params: idParams,
      response: exportResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.ruleChain.findUnique({ where: { id } });
    if (!row) return notFound(reply);
    const body = exportChain({ name: row.name, root: row.root, debugMode: row.debugMode, document: readRuleChainDocument(row.document) });
    return reply
      .header('content-disposition', `attachment; filename="${exportFileName(row.name)}"`)
      .type('application/json; charset=utf-8')
      .send(body);
  });

  // ─── DEBUG EVENTS ──────────────────────────────────────
  app.get('/:id/debug', {
    ...canRead,
    schema: {
      tags: ['Rule Chains'],
      summary: 'A chain\'s debug events, newest first',
      description: '`nodeId` narrows to one node; `before` (an instant) to older events — the next page; `limit` 1..1000, default 100.',
      params: idParams,
      querystring: debugQuery,
      response: debugResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await exists(id))) return notFound(reply);
    const q = req.query as { nodeId?: string; limit?: number; before?: string };
    return { data: await listDebug(id, { nodeId: q.nodeId, limit: q.limit, before: q.before ? new Date(q.before) : undefined }) };
  });

  app.delete('/:id/debug', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Clear a chain\'s debug events',
      description: 'Every event of the chain, or of one node (`nodeId`). Audited RULE_CHAIN_DEBUG_CLEARED with the count. Re-auth action UPDATE_RULE_CHAIN; `reason` required.',
      params: idParams,
      body: clearDebugBody,
      response: noContentResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await exists(id))) return notFound(reply);
    const { ok } = await enforceReauth(UPDATE_RULE_CHAIN_ACTION, req, reply);
    if (!ok) return;
    const body = (req.body ?? {}) as { nodeId?: string; reason?: string };
    cleanReason(body.reason);
    const cleared = await writeTx(undefined, async (tx) => {
      // Deleted since the 404 check: say so, never a 204 with no audit row.
      const chain = await tx.ruleChain.findUnique({ where: { id }, select: { id: true, name: true } });
      if (!chain) return false;
      await clearDebug(tx, chain, body.nodeId, actorOf(req), body.reason);
      return true;
    });
    if (!cleared) return notFound(reply);
    return reply.code(204).send();
  });

  // ─── CREATE ────────────────────────────────────────────
  app.post('/', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Create a rule chain',
      description: 'Without a `document`: an empty chain. Never root. The document is strictly parsed — a refusal is 400 naming the node. Re-auth action UPDATE_RULE_CHAIN; `reason` required.',
      body: createBody,
      response: createdResponse,
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(UPDATE_RULE_CHAIN_ACTION, req, reply);
    if (!ok) return;
    const body = req.body as { name?: string; document?: unknown; debugMode?: boolean; reEnterOnRuleNodeWrites?: boolean; reason?: string };
    const outcome = await writeTx(body.name, (tx) => saveChain(tx, null, {
      name: body.name, document: body.document, debugMode: body.debugMode,
      reEnterOnRuleNodeWrites: body.reEnterOnRuleNodeWrites, reason: body.reason,
    }, actorOf(req)));
    invalidateChainCache(outcome.row.id);
    return reply.code(201).send(presentDetail(outcome.row));
  });

  // ─── SAVE ──────────────────────────────────────────────
  app.put('/:id', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Save a rule chain',
      description: 'The WHOLE document, plus the `expectedUpdatedAt` the editor loaded: a chain changed since is 409 STALE and nothing is written. The projection is rebuilt with the document\'s node ids. A save that changes nothing writes and audits nothing. Re-auth action UPDATE_RULE_CHAIN; `reason` required.',
      params: idParams,
      body: updateBody,
      response: detailResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await exists(id))) return notFound(reply);
    const { ok } = await enforceReauth(UPDATE_RULE_CHAIN_ACTION, req, reply);
    if (!ok) return;
    const body = req.body as {
      name?: string; document: unknown; debugMode?: boolean; reEnterOnRuleNodeWrites?: boolean; expectedUpdatedAt: string; reason?: string;
    };
    const outcome = await writeTx(body.name, (tx) => saveChain(tx, id, {
      name: body.name, document: body.document, debugMode: body.debugMode,
      reEnterOnRuleNodeWrites: body.reEnterOnRuleNodeWrites, expectedUpdatedAt: new Date(body.expectedUpdatedAt), reason: body.reason,
    }, actorOf(req)));
    if (outcome.kind !== 'unchanged') invalidateChainCache(id);
    return presentDetail(outcome.row);
  });

  // ─── DELETE ────────────────────────────────────────────
  app.delete('/:id', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Delete a rule chain',
      description: 'With its nodes, connections and debug events. The root chain is 409 ROOT_CHAIN; a chain another chain\'s Rule chain node calls is 409 CHAIN_IN_USE. Re-auth action UPDATE_RULE_CHAIN; `reason` required.',
      params: idParams,
      body: reasonBody,
      response: noContentResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await exists(id))) return notFound(reply);
    const { ok } = await enforceReauth(UPDATE_RULE_CHAIN_ACTION, req, reply);
    if (!ok) return;
    await deleteChain(id, actorOf(req), (req.body as { reason?: string } | undefined)?.reason);
    return reply.code(204).send();
  });

  // ─── MAKE ROOT ─────────────────────────────────────────
  app.post('/:id/root', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Make a rule chain the root chain',
      description: 'One transaction unsets the old root and sets this one; the chains\' `updatedAt` does not move. Already root = nothing written. Re-auth action UPDATE_RULE_CHAIN; `reason` required.',
      params: idParams,
      body: reasonBody,
      response: detailResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await exists(id))) return notFound(reply);
    const { ok } = await enforceReauth(UPDATE_RULE_CHAIN_ACTION, req, reply);
    if (!ok) return;
    const outcome = await setRoot(id, actorOf(req), (req.body as { reason?: string } | undefined)?.reason);
    return presentDetail(outcome.row);
  });
}

/**
 * `/api/rule-engine/v1` — ThingsBoard's "REST API request": a message injected
 * into the root chain (spec §5). RULE_CHAIN_MANAGE. Task 3 wires it to the
 * engine; until then it accepts nothing and says why.
 */
export async function ruleEngineIngressRoutes(app: FastifyInstance) {
  app.post('/messages', {
    preValidation: [app.requirePermission(MANAGE)],
    schema: {
      tags: ['Rule Chains'],
      summary: 'Inject a message into the root rule chain',
      description: 'Body `{ type?, originatorCode?, data, metadata? }` — a REST_API_REQUEST from an instrument (by code) or the system. 202 `{ accepted: false, reason: "ENGINE_NOT_STARTED" }` until the rule engine runs.',
      body: injectBody,
      response: injectResponse,
    },
  }, async (_req, reply) => reply.code(202).send({ accepted: false, reason: ENGINE_NOT_STARTED }));
}
