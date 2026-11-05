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
import { maskDocumentSecrets, maskSecrets } from './secrets.js';
import { auditLog } from '../../lib/audit.js';
import { ruleEngine } from './engine.js';
import { RuleScriptError, type RuleScriptKind } from './script-vm.js';
import { GENERATOR_PREV_PREFIX } from './nodes/action/generator.js';
import { newMessage, toMetadata, RULE_ENGINE_ORIGIN_KEY, REST_API_ORIGIN, type RuleOriginator } from './message.js';

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
 * - Credentials (secrets.ts, ONE rule): EVERY response masks them as "***",
 *   for EVERY caller, RULE_CHAIN_MANAGE included — `GET /:id`, the chain a
 *   create / save / make-root returns, and the export (spec S-5: masked in the
 *   editor too; ruling T2-D). A save or an import that sends "***" KEEPS the
 *   value stored for that node id and type, so the editor never needs the real
 *   value; an import reports each node whose credential must be entered again;
 *   audit rows record them masked.
 * - `/stats`, `/test-script` and `POST /api/rule-engine/v1/messages` call the
 *   engine (engine.ts, Task 3): its live numbers, its script VM, its queue.
 */
export const UPDATE_RULE_CHAIN_ACTION = 'UPDATE_RULE_CHAIN';
const READ = 'RULE_CHAIN_READ';
const MANAGE = 'RULE_CHAIN_MANAGE';
const ENGINE_NOT_STARTED = 'ENGINE_NOT_STARTED';

/** The catalogue as the palette reads it — every node type, without its zod schema. Built once. */
const NODE_TYPE_DESCRIPTORS = RULE_NODE_TYPES.map(toRuleNodeTypeDescriptor);

type DetailRow = Pick<RuleChain, 'id' | 'name' | 'root' | 'debugMode' | 'reEnterOnRuleNodeWrites' | 'document' | 'updatedAt' | 'updatedBy'>;

/**
 * One chain on the wire. The stored document is read FORGIVINGLY: one bad node
 * never blanks a chain. Every credential leaf reads as "***" (secrets.ts) for
 * EVERY caller (ruling T2-D): no response carries a stored secret, and a save
 * that sends "***" back keeps the stored value.
 */
export function presentDetail(row: DetailRow) {
  const document = readRuleChainDocument(row.document);
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    debugMode: row.debugMode,
    reEnterOnRuleNodeWrites: row.reEnterOnRuleNodeWrites,
    document: maskDocumentSecrets(document),
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

  // ─── STATS ─────────────────────────────────────────────
  app.get('/stats', {
    ...canRead,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Rule engine statistics',
      description: 'Whether the engine is switched on (Configuration → Rule Engine), the queue depth, messages dropped since the server started (the queue was full), messages processed in the last minute, and per chain, and the engine\'s counters since the server started (`step_limit`, `hop_limit`, `timeouts`, `steps_abandoned` …). Zeros while the engine is not running.',
      response: statsResponse,
    },
  }, async () => {
    const s = ruleEngine.stats();
    return {
      // The stored switch, not the engine's 1 s snapshot: a save shows at once.
      enabled: (await getRuleEngineConfig()).enabled,
      queueDepth: s.queueDepth,
      dropped: s.dropped,
      processedLastMinute: s.processedLastMinute,
      chains: s.chains,
      counters: s.counters,
    };
  });

  // ─── TEST SCRIPT ───────────────────────────────────────
  app.post('/test-script', {
    ...canManage,
    schema: {
      tags: ['Rule Chains'],
      summary: 'Run a node script against a sample message',
      description: 'The editor\'s Test script button: the script runs in the engine\'s script VM, with the configured time budget, against `msg` / `metadata` / `msgType` (defaults `{}`, `{}`, POST_TELEMETRY_REQUEST; a `generator` script sees them as ThingsBoard\'s `prevMsg` / `prevMetadata` / `prevMsgType`, as the Generator node runs it, msgType defaulting to empty). 200 `{ result }` — a filter\'s boolean, a switch\'s relation list, a transform\'s message list, else the return value. 400 `{ error: SCRIPT_SYNTAX | SCRIPT_TIMEOUT | SCRIPT_ERROR | SCRIPT_RESULT, message }`. Runs whether or not the engine is switched on.',
      body: testScriptBody,
    },
  }, async (req, reply) => {
    const body = req.body as { scriptType: RuleScriptKind; script: string; msg?: unknown; metadata?: Record<string, unknown>; msgType?: string };
    // A GENERATOR script runs as the Generator node runs it (nodes/action/generator.ts): ThingsBoard's
    // `prevMsg` / `prevMetadata` / `prevMsgType` declared from msg / metadata / msgType, which
    // default to {}, {} and '' (no previous output yet). Every other kind sees msg / metadata / msgType.
    const generator = body.scriptType === 'generator';
    try {
      const result = await ruleEngine.runScript(body.scriptType, generator ? `${GENERATOR_PREV_PREFIX}${body.script}` : body.script,
        body.msg ?? {}, toMetadata(body.metadata ?? {}), body.msgType?.trim() || (generator ? '' : 'POST_TELEMETRY_REQUEST'));
      return { result: result === undefined ? null : result };
    } catch (err) {
      if (err instanceof RuleScriptError) return reply.code(400).send({ error: err.code, message: err.message });
      throw err;
    }
  });

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
      description: 'The stored document read forgivingly: a node that no longer passes its type reads as Unsupported, a dangling connection is dropped. Credentials (passwords, tokens, private keys, an Authorization header) read as "***" for every caller; a save that sends "***" back keeps the stored value.',
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
      description: 'The WHOLE document, plus the `expectedUpdatedAt` the editor loaded: a chain changed since is 409 STALE and nothing is written. The projection is rebuilt with the document\'s node ids. A save that changes nothing (name, flags and document equal to the stored chain, a credential sent as "***" counting as its stored value) writes and audits nothing and answers 200 with the stored chain — decided BEFORE the version check, so even a stale `expectedUpdatedAt` is a 200 then, never a 409. Re-auth action UPDATE_RULE_CHAIN; `reason` required.',
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
 * into the root chain (spec §5). RULE_CHAIN_MANAGE. Fire and forget: 202 with
 * the message id as soon as the queue admits it.
 */
/** `audit_trail.signature_meaning` is VARCHAR(255) and the insert is raw SQL: a longer one is a 500. */
const clampInjectMeaning = (s: string) => (s.length <= 255 ? s : `${s.slice(0, 254)}…`);

export async function ruleEngineIngressRoutes(app: FastifyInstance) {
  app.post('/messages', {
    preValidation: [app.requirePermission(MANAGE)],
    schema: {
      tags: ['Rule Chains'],
      summary: 'Inject a message into the root rule chain',
      description: 'Body `{ type?, originatorCode?, data, metadata? }` — a message (type REST_API_REQUEST unless given) from the instrument with that code (ignoring case; 404 ORIGINATOR_NOT_FOUND) or, with no code, from SYSTEM. `metadata.requestId` is the message id; `metadata.rule_engine_origin` is `rest_api`. 202 `{ accepted: true, msgId }`, or `{ accepted: false, reason: ENGINE_NOT_STARTED | ENGINE_DISABLED | QUEUE_REFUSED }` (the audit row still names the message id). Every call that names a valid originator writes ONE `RULE_ENGINE_MESSAGE_INJECTED` audit row first (credential-like keys masked); no re-auth, no reason.',
      body: injectBody,
      response: injectResponse,
    },
  }, async (req, reply) => {
    const body = req.body as { type?: string; originatorCode?: string; data: unknown; metadata?: Record<string, string> };
    let originator: RuleOriginator = { type: 'SYSTEM', id: 'SYSTEM' };
    const code = body.originatorCode?.trim();
    if (code) {
      const instrument = await ruleEngine.services.instruments.byCode(code);
      if (!instrument) return reply.code(404).send({ error: 'ORIGINATOR_NOT_FOUND', message: `No instrument has the code "${code}".` });
      originator = { type: 'INSTRUMENT', id: instrument.id, code: instrument.code };
    }
    const msg = newMessage(body.type?.trim() || 'REST_API_REQUEST', originator, body.data ?? null, { ...(body.metadata ?? {}) });
    msg.metadata.requestId = msg.id;
    msg.metadata[RULE_ENGINE_ORIGIN_KEY] = REST_API_ORIGIN;
    // A POST_TELEMETRY_REQUEST is ThingsBoard's FLAT shape (ruling M-1): `data` is
    // the values, the instant is `metadata.ts` (epoch ms) — now when not given.
    // NOTE (recorded for the feature note): through the shipped chain's Save
    // Timeseries this STORES a reading with whatever `ts` the caller sends; the
    // audit row below is the record of who did it.
    if (msg.type === 'POST_TELEMETRY_REQUEST' && !msg.metadata.ts) msg.metadata.ts = String(Date.now());
    // ONE audit row per call, BEFORE the message can act (it may raise alarms, write
    // attributes, send email): who injected what, credential-like keys masked
    // (secrets.ts, the export's rule). A machine endpoint: no re-auth, no reason.
    const actor = actorOf(req);
    const masked = maskSecrets({ metadata: msg.metadata, data: msg.data });
    const from = originator.code ?? originator.id;
    await auditLog({
      action: 'RULE_ENGINE_MESSAGE_INJECTED', targetType: 'rule_engine_message', targetId: msg.id,
      afterValue: { name: `${msg.type} from ${from}`, msgId: msg.id, type: msg.type, originator, metadata: masked.metadata, data: masked.data },
      signatureMeaning: clampInjectMeaning(`Message ${msg.type} from ${from} injected into the root rule chain`),
      userId: actor.userId, userRole: actor.userRole, ipAddress: actor.ipAddress, userAgent: actor.userAgent, sessionId: actor.sessionId,
    });
    if (!ruleEngine.started) return reply.code(202).send({ accepted: false, reason: ENGINE_NOT_STARTED });
    if (ruleEngine.enqueue(msg)) return reply.code(202).send({ accepted: true, msgId: msg.id });
    return reply.code(202).send({ accepted: false, reason: ruleEngine.config().enabled ? 'QUEUE_REFUSED' : 'ENGINE_DISABLED' });
  });
}
