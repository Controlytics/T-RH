/**
 * Rule chains — the store behind `/api/rule-chains` and the chain loader the
 * engine (Task 3) reads. Spec: docs/superpowers/specs/2026-11-03-rule-chains-design.md
 * §5, §8, §9.
 *
 * - **The chain DOCUMENT is the source of truth (ruling D-1).** `saveChain` is
 *   the ONE write path: it strictly parses the document (`parseRuleChainDocument`;
 *   a refusal is a 400 naming the node), writes the row, deletes and re-inserts
 *   the `rule_nodes` / `rule_node_connections` projection with the document's
 *   own node ids, and writes the audit row with the whole document before and
 *   after — all inside the caller's transaction.
 * - **Exactly one root.** `setRoot` unsets the old root BEFORE setting the new
 *   one (the partial unique index `rule_chains_one_root` is checked per row),
 *   under an advisory lock so two concurrent calls queue rather than collide.
 *   It writes with raw SQL so `updated_at` — the document's version, the
 *   editor's `expectedUpdatedAt` — does not move: making a chain root never
 *   makes an open editor stale.
 * - **Reads for the engine are cached**: `getChain(id)` for 60 s,
 *   `getRootChain()`'s root id for 5 s. Every write path calls
 *   `invalidateChainCache(...)` AFTER its transaction commits — invalidating
 *   inside it would let a read between the two re-cache the old row.
 */
import type { FastifyRequest } from 'fastify';
import { Prisma, type RuleChain } from '@prisma/client';
import { ZodError } from 'zod';
import {
  parseRuleChainDocument, readRuleChainDocument, emptyRuleChainDocument, RULE_CHAIN_NAME_MAX,
  type RuleChainDocument, type RuleChainNode,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog, clampSignatureMeaning } from '../../lib/audit.js';
import { stripHtml } from '../../lib/sanitize.js';
import { AppError } from '../../lib/errors.js';
import { mergeMaskedSecrets, maskDocumentSecrets, changedSecrets } from './secrets.js';

/** The shipped root chain's id — fixed by migration `20261103181000_rule_chains`. */
export const SEEDED_ROOT_CHAIN_ID = 'b1a7e000-0000-4000-8000-000000000000';
/** `audit_trail.target_type` of every row this module writes. */
export const RULE_CHAIN_TARGET_TYPE = 'rule_chain';
export const RULE_CHAIN_REASON_MAX = 1_000;
/** The node type whose `ruleChainId` calls another chain (the delete guard reads it). */
const RULE_CHAIN_NODE_TYPE = 'tb:flow:rule-chain';
/** Up to 300 nodes + 2000 connections and the audit insert must not hit Prisma's 5 s default. */
export const RULE_CHAIN_WRITE_TX = { timeout: 30_000 } as const;

type Db = Prisma.TransactionClient | typeof prisma;

// ─── errors ──────────────────────────────────────────────────────────────────

/**
 * A refusal with its HTTP status and wire code. An `AppError`, so a route may
 * simply let it propagate: the global error handler (`app.ts`, and the e2e
 * helper's copy) sends `{ error: code, message }` with the status.
 */
export class RuleChainError extends AppError {
  constructor(statusCode: number, code: string, message: string) {
    super(statusCode, code, message);
  }
}

const notFound = () => new RuleChainError(404, 'RULE_CHAIN_NOT_FOUND', 'Rule chain not found.');
const nameInUse = (name: string) => new RuleChainError(409, 'NAME_IN_USE', `A rule chain named "${name}" already exists.`);

/** A P2002 on `rule_chains.name` (two creates racing past the pre-check) as the same 409. */
export function nameConflictOf(err: unknown, name: string): RuleChainError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((f) => f === 'name' || f.includes('rule_chains_name')) ? nameInUse(name) : null;
}

// ─── input ───────────────────────────────────────────────────────────────────

/** Who, on every audit row. `userId` is the USERNAME, as on every audit row here. */
export interface RuleChainActor {
  userId: string;
  userRole: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
}

export const actorOf = (req: FastifyRequest): RuleChainActor => ({
  userId: req.user.username, userRole: req.user.role,
  ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null, sessionId: req.user.sessionId ?? null,
});

/** HTML stripped, trimmed, within the column; blank is a 400. */
export function cleanChainName(value: unknown): string {
  const t = typeof value === 'string' ? stripHtml(value).trim() : '';
  if (!t) throw new RuleChainError(400, 'VALIDATION_ERROR', 'A rule chain needs a name.');
  if (t.length > RULE_CHAIN_NAME_MAX) {
    throw new RuleChainError(400, 'VALIDATION_ERROR', `A rule chain name must be ${RULE_CHAIN_NAME_MAX} characters or fewer.`);
  }
  return t;
}

/** Every write carries the operator's reason (§11): HTML stripped, trimmed, not blank. */
export function cleanReason(value: unknown): string {
  const t = typeof value === 'string' ? stripHtml(value).trim() : '';
  if (!t) throw new RuleChainError(400, 'REASON_REQUIRED', 'A reason is required for every change to a rule chain.');
  return t.slice(0, RULE_CHAIN_REASON_MAX);
}

/** The strict parse's issues as one message. Node / connection issues already name what they are about. */
export function documentErrorMessage(err: ZodError, submitted?: unknown): string {
  const parts = err.issues.slice(0, 5).map((i) => {
    if (/^(Node|Connection) /.test(i.message) || i.path.length === 0) return i.message;
    // A shape issue inside a node (`nodes.N.x`, `nodes.N.name` …) names the
    // node as the SUBMITTED document has it, as the parse's own node issues do;
    // `Node #N` (1-based) when that node has no usable name.
    if (i.path[0] === 'nodes' && typeof i.path[1] === 'number') {
      const rest = i.path.slice(2).join('.');
      return `${submittedNodeLabel(submitted, i.path[1])}: ${rest ? `${rest} — ` : ''}${i.message}`;
    }
    return `${i.path.join('.')}: ${i.message}`;
  });
  const more = err.issues.length > 5 ? ` (and ${err.issues.length - 5} more)` : '';
  return `The rule chain could not be saved: ${parts.join('; ')}${more}.`;
}

/** `Node "<name>"` for the node at `index` of the submitted document, else `Node #<index + 1>`. */
function submittedNodeLabel(submitted: unknown, index: number): string {
  const nodes = submitted && typeof submitted === 'object' ? (submitted as { nodes?: unknown }).nodes : undefined;
  const node = Array.isArray(nodes) ? nodes[index] : undefined;
  const name = node && typeof node === 'object' ? (node as { name?: unknown }).name : undefined;
  const trimmed = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  return trimmed ? `Node "${trimmed}"` : `Node #${index + 1}`;
}

/** `parseRuleChainDocument`, its refusal as a 400 naming the node. */
export function parseDocumentOrThrow(value: unknown): RuleChainDocument {
  try {
    return parseRuleChainDocument(value);
  } catch (err) {
    if (err instanceof ZodError) throw new RuleChainError(400, 'VALIDATION_ERROR', documentErrorMessage(err, value));
    throw err;
  }
}

// ─── values ──────────────────────────────────────────────────────────────────

/** What an audit row records of a chain: everything a save can change, the whole document included. */
export interface RuleChainState {
  name: string;
  root: boolean;
  debugMode: boolean;
  reEnterOnRuleNodeWrites: boolean;
  document: RuleChainDocument;
}

export const stateOf = (row: Pick<RuleChain, 'name' | 'root' | 'debugMode' | 'reEnterOnRuleNodeWrites' | 'document'>): RuleChainState => ({
  name: row.name, root: row.root, debugMode: row.debugMode, reEnterOnRuleNodeWrites: row.reEnterOnRuleNodeWrites,
  document: readRuleChainDocument(row.document),
});

/**
 * A state as an AUDIT row records it: the whole document with every secret
 * leaf masked (`secrets.ts`; ruling T2-C). The audit trail is immutable and
 * read by AUDIT_READ holders, so a broker password or a bot token must never
 * enter it — the precedent is the dynamic config PUT, which redacts a def's
 * `secret` settings from CONFIG_CHANGED. What changed among the secrets is
 * named instead (`secretsChanged` on RULE_CHAIN_UPDATED).
 */
export const auditStateOf = (state: RuleChainState): RuleChainState => ({ ...state, document: maskDocumentSecrets(state.document) });

/** JSON with every object's keys sorted — the stored JSONB reorders keys, so plain JSON.stringify cannot compare. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const asJson = (v: unknown) => v as Prisma.InputJsonValue;
const meaning = (text: string) => clampSignatureMeaning(text) ?? '';

// ─── save ────────────────────────────────────────────────────────────────────

export interface SaveChainInput {
  /** Required to create; omitted on a save = keep. Cleaned here. */
  name?: unknown;
  /** Strictly parsed here. Omitted on a create = an empty chain; REQUIRED on a save. */
  document?: unknown;
  debugMode?: boolean;
  reEnterOnRuleNodeWrites?: boolean;
  /** REQUIRED on a save: the `updatedAt` the editor loaded. */
  expectedUpdatedAt?: Date;
  /** The operator's reason; cleaned here (400 REASON_REQUIRED when blank). */
  reason: unknown;
  /** A create from a ThingsBoard file: audited as RULE_CHAIN_IMPORTED with these warnings. */
  importWarnings?: readonly string[];
}

export type SaveChainOutcome =
  | { kind: 'created'; row: RuleChain }
  | { kind: 'saved'; row: RuleChain }
  | { kind: 'unchanged'; row: RuleChain };

/** Delete and re-insert the projection with the document's own ids, in document order. */
async function rebuildProjection(tx: Prisma.TransactionClient, chainId: string, doc: RuleChainDocument): Promise<void> {
  await tx.ruleNodeConnection.deleteMany({ where: { chainId } });
  await tx.ruleNode.deleteMany({ where: { chainId } });
  if (doc.nodes.length > 0) {
    await tx.ruleNode.createMany({
      data: doc.nodes.map((n, index) => ({
        chainId, id: n.id, type: n.type, name: n.name, config: asJson(n.config), debugMode: n.debugMode, x: n.x, y: n.y, index,
      })),
    });
  }
  if (doc.connections.length > 0) {
    await tx.ruleNodeConnection.createMany({
      data: doc.connections.map((c) => ({ chainId, fromNodeId: c.from, toNodeId: c.to, relation: c.relation })),
    });
  }
}

async function assertNameFree(tx: Prisma.TransactionClient, name: string, exceptId: string | null): Promise<void> {
  const other = await tx.ruleChain.findFirst({ where: { name, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (other) throw nameInUse(name);
}

/**
 * Create (`id` null) or save a chain — the row, its projection and its audit
 * row, all in `tx`. Throws `RuleChainError` for every refusal: 400
 * VALIDATION_ERROR (the strict parse, naming the node) / REASON_REQUIRED, 404
 * RULE_CHAIN_NOT_FOUND, 409 STALE (`expectedUpdatedAt` is not the stored
 * version — nothing is written) and 409 NAME_IN_USE.
 *
 * On a save, a credential sent back as "***" keeps the value stored for that
 * node id and type (`mergeMaskedSecrets`, before the strict parse; ruling
 * T2-B). Audit values record the document with its credentials masked and, on
 * an update, name the credentials that changed (`secretsChanged`; ruling T2-C).
 *
 * A save that changes nothing (name, both flags and the document compared as
 * canonical JSON) writes nothing and audits nothing, and is answered before the
 * version check — the dashboards precedent: an honest second click is not a
 * conflict. A new chain is never root; only `setRoot` makes one.
 * The caller invalidates the chain cache AFTER the transaction commits.
 */
export async function saveChain(
  tx: Prisma.TransactionClient,
  id: string | null,
  input: SaveChainInput,
  actor: RuleChainActor,
): Promise<SaveChainOutcome> {
  const reason = cleanReason(input.reason);

  if (id === null) {
    const name = cleanChainName(input.name);
    const document = input.document === undefined ? emptyRuleChainDocument() : parseDocumentOrThrow(input.document);
    await assertNameFree(tx, name, null);
    const row = await tx.ruleChain.create({
      data: {
        name, root: false, document: asJson(document), firstNodeId: document.firstNodeId,
        debugMode: input.debugMode ?? false, reEnterOnRuleNodeWrites: input.reEnterOnRuleNodeWrites ?? false,
        createdBy: actor.userId, updatedBy: actor.userId,
      },
    });
    await rebuildProjection(tx, row.id, document);
    const imported = input.importWarnings !== undefined;
    await auditLog({
      ...actor,
      action: imported ? 'RULE_CHAIN_IMPORTED' : 'RULE_CHAIN_CREATED',
      targetType: RULE_CHAIN_TARGET_TYPE, targetId: row.id,
      afterValue: imported
        ? { ...auditStateOf(stateOf(row)), warnings: [...input.importWarnings!], source: 'thingsboard' }
        : auditStateOf(stateOf(row)),
      reason,
      signatureMeaning: meaning(`Rule chain "${name}" ${imported ? 'imported' : 'created'}`),
    }, tx);
    return { kind: 'created', row };
  }

  if (input.document === undefined) throw new RuleChainError(400, 'VALIDATION_ERROR', 'A save carries the whole document.');
  if (!input.expectedUpdatedAt || Number.isNaN(input.expectedUpdatedAt.getTime())) {
    throw new RuleChainError(400, 'VALIDATION_ERROR', 'A save carries the expectedUpdatedAt the editor loaded.');
  }
  const nameIn = input.name === undefined ? undefined : cleanChainName(input.name);

  // Row lock: two saves of one chain queue here, and the second sees the first's version.
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM rule_chains WHERE id = ${id}::uuid FOR UPDATE`;
  if (locked.length === 0) throw notFound();
  const cur = await tx.ruleChain.findUniqueOrThrow({ where: { id } });

  const before = stateOf(cur);
  // A secret sent back as "***" (from a masked read or an export) KEEPS the
  // value stored for that node id and type — merged BEFORE the strict parse,
  // so "***" never overwrites a real credential (ruling T2-B). Nothing stored
  // for it = it stays "***", and the node refuses it at run time (Task 6).
  const document = parseDocumentOrThrow(mergeMaskedSecrets(input.document, before.document).document);
  const after: RuleChainState = {
    name: nameIn ?? cur.name,
    root: cur.root,
    debugMode: input.debugMode ?? cur.debugMode,
    reEnterOnRuleNodeWrites: input.reEnterOnRuleNodeWrites ?? cur.reEnterOnRuleNodeWrites,
    document,
  };
  if (canonicalJson(before) === canonicalJson(after)) return { kind: 'unchanged', row: cur };

  if (cur.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
    throw new RuleChainError(409, 'STALE', 'This rule chain was changed by someone else. Reload it and make your change again.');
  }
  if (after.name !== cur.name) await assertNameFree(tx, after.name, id);
  const documentChanged = canonicalJson(before.document) !== canonicalJson(document);

  // The new version is always past the loaded one, so two saves inside one
  // millisecond still leave the second editor stale.
  const row = await tx.ruleChain.update({
    where: { id },
    data: {
      name: after.name,
      debugMode: after.debugMode,
      reEnterOnRuleNodeWrites: after.reEnterOnRuleNodeWrites,
      ...(documentChanged ? { document: asJson(document), firstNodeId: document.firstNodeId } : {}),
      updatedBy: actor.userId,
      updatedAt: new Date(Math.max(Date.now(), input.expectedUpdatedAt.getTime() + 1)),
    },
  });
  if (documentChanged) await rebuildProjection(tx, id, document);
  const secretsChanged = changedSecrets(before.document, document);
  await auditLog({
    ...actor,
    action: 'RULE_CHAIN_UPDATED', targetType: RULE_CHAIN_TARGET_TYPE, targetId: id,
    beforeValue: auditStateOf(before),
    afterValue: { ...auditStateOf(after), ...(secretsChanged.length > 0 ? { secretsChanged } : {}) },
    reason,
    signatureMeaning: meaning(`Rule chain "${after.name}" updated`),
  }, tx);
  return { kind: 'saved', row };
}

// ─── root ────────────────────────────────────────────────────────────────────

export type SetRootOutcome = { kind: 'changed' | 'unchanged'; row: RuleChain; previousRootId: string | null };

/**
 * Make `id` the root chain, in ONE transaction: under an advisory lock, unset
 * the old root, THEN set the new one, then audit RULE_CHAIN_ROOT_CHANGED
 * naming both. Already root = no write, no audit. Raw SQL, so `updated_at`
 * stays the document's version. Invalidates the caches after the commit.
 */
export async function setRoot(id: string, actor: RuleChainActor, reasonIn: unknown): Promise<SetRootOutcome> {
  const reason = cleanReason(reasonIn);
  const outcome = await prisma.$transaction(async (tx): Promise<SetRootOutcome> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rule_chains:root'))`;
    const target = await tx.ruleChain.findUnique({ where: { id } });
    if (!target) throw notFound();
    const previous = await tx.ruleChain.findFirst({ where: { root: true }, select: { id: true, name: true } });
    if (target.root) return { kind: 'unchanged', row: target, previousRootId: previous?.id ?? null };

    await tx.$executeRaw`UPDATE rule_chains SET root = false WHERE root AND id <> ${id}::uuid`;
    await tx.$executeRaw`UPDATE rule_chains SET root = true WHERE id = ${id}::uuid`;
    const row = await tx.ruleChain.findUniqueOrThrow({ where: { id } });
    await auditLog({
      ...actor,
      action: 'RULE_CHAIN_ROOT_CHANGED', targetType: RULE_CHAIN_TARGET_TYPE, targetId: id,
      beforeValue: { name: target.name, root: false, previousRoot: previous ? { id: previous.id, name: previous.name } : null },
      afterValue: { name: row.name, root: true },
      reason,
      signatureMeaning: meaning(`Rule chain "${row.name}" made the root chain`),
    }, tx);
    return { kind: 'changed', row, previousRootId: previous?.id ?? null };
  }, RULE_CHAIN_WRITE_TX);
  if (outcome.kind === 'changed') invalidateChainCache(id, outcome.previousRootId);
  return outcome;
}

// ─── delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a chain with its projection and its debug events (both cascade), and
 * audit RULE_CHAIN_DELETED with the whole document. Refused: the root chain
 * (409 ROOT_CHAIN — ThingsBoard's rule), and a chain another chain's Rule
 * chain node calls (409 CHAIN_IN_USE, naming the caller — ThingsBoard refuses
 * it too). Invalidates the cache after the commit.
 */
export async function deleteChain(id: string, actor: RuleChainActor, reasonIn: unknown): Promise<void> {
  const reason = cleanReason(reasonIn);
  await prisma.$transaction(async (tx) => {
    // The root lock: a chain cannot be made root while it is being deleted.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rule_chains:root'))`;
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM rule_chains WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    const cur = await tx.ruleChain.findUniqueOrThrow({ where: { id } });
    if (cur.root) throw new RuleChainError(409, 'ROOT_CHAIN', 'The root rule chain cannot be deleted. Make another chain the root first.');
    const caller = await tx.ruleNode.findFirst({
      where: { type: RULE_CHAIN_NODE_TYPE, chainId: { not: id }, config: { path: ['ruleChainId'], equals: id } },
      select: { name: true, chain: { select: { name: true } } },
    });
    if (caller) {
      throw new RuleChainError(409, 'CHAIN_IN_USE',
        `Rule chain "${cur.name}" is called by the node "${caller.name}" in rule chain "${caller.chain.name}". Remove that node first.`);
    }
    await tx.ruleChain.delete({ where: { id } });
    await auditLog({
      ...actor,
      action: 'RULE_CHAIN_DELETED', targetType: RULE_CHAIN_TARGET_TYPE, targetId: id,
      beforeValue: auditStateOf(stateOf(cur)), reason,
      signatureMeaning: meaning(`Rule chain "${cur.name}" deleted`),
    }, tx);
  }, RULE_CHAIN_WRITE_TX);
  invalidateChainCache(id);
}

// ─── debug events ────────────────────────────────────────────────────────────

/** One debug event on the wire: the bigserial id as a string. */
export interface RuleDebugEventView {
  id: string;
  chainId: string;
  nodeId: string;
  ts: string;
  direction: string;
  relation: string | null;
  msgId: string;
  msgType: string;
  originatorType: string;
  originatorId: string;
  data: unknown;
  metadata: unknown;
  error: string | null;
}

export const RULE_DEBUG_LIST_MAX = 1_000;

/** A chain's debug events, newest first; `nodeId` narrows to one node, `before` to events strictly older. */
export async function listDebug(
  chainId: string,
  opts: { nodeId?: string; limit?: number; before?: Date } = {},
  db: Db = prisma,
): Promise<RuleDebugEventView[]> {
  const take = Math.min(RULE_DEBUG_LIST_MAX, Math.max(1, Math.floor(opts.limit ?? 100)));
  const rows = await db.ruleNodeDebugEvent.findMany({
    where: { chainId, ...(opts.nodeId ? { nodeId: opts.nodeId } : {}), ...(opts.before ? { ts: { lt: opts.before } } : {}) },
    orderBy: [{ ts: 'desc' }, { id: 'desc' }],
    take,
  });
  return rows.map((r) => ({
    id: r.id.toString(), chainId: r.chainId, nodeId: r.nodeId, ts: r.ts.toISOString(), direction: r.direction,
    relation: r.relation, msgId: r.msgId, msgType: r.msgType, originatorType: r.originatorType, originatorId: r.originatorId,
    data: r.data, metadata: r.metadata, error: r.error,
  }));
}

/**
 * Delete a chain's debug events (one node's when `nodeId` is given) and audit
 * RULE_CHAIN_DEBUG_CLEARED with the count, in `tx`. Returns the count.
 */
export async function clearDebug(
  tx: Prisma.TransactionClient,
  chain: { id: string; name: string },
  nodeId: string | undefined,
  actor: RuleChainActor,
  reasonIn: unknown,
): Promise<number> {
  const reason = cleanReason(reasonIn);
  const { count } = await tx.ruleNodeDebugEvent.deleteMany({ where: { chainId: chain.id, ...(nodeId ? { nodeId } : {}) } });
  await auditLog({
    ...actor,
    action: 'RULE_CHAIN_DEBUG_CLEARED', targetType: RULE_CHAIN_TARGET_TYPE, targetId: chain.id,
    afterValue: { name: chain.name, deleted: count, ...(nodeId ? { nodeId } : {}) },
    reason,
    signatureMeaning: meaning(`Debug events of rule chain "${chain.name}" cleared`),
  }, tx);
  return count;
}

// ─── the engine's reads (cached) ─────────────────────────────────────────────

/** A chain as the engine reads it: the document (read forgivingly) and two indexes over it. */
export interface LoadedRuleChain {
  id: string;
  name: string;
  root: boolean;
  debugMode: boolean;
  reEnterOnRuleNodeWrites: boolean;
  firstNodeId: string | null;
  document: RuleChainDocument;
  /** Node id → node. */
  nodesById: ReadonlyMap<string, RuleChainNode>;
  /** From-node id → relation label → to-node ids, in document order. */
  outgoing: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  updatedAt: Date;
}

const CHAIN_TTL_MS = 60_000;
const ROOT_ID_TTL_MS = 5_000;
const chainCache = new Map<string, { value: LoadedRuleChain | null; at: number }>();
let rootIdCache: { id: string | null; at: number } | null = null;

export function loadChainFromRow(row: RuleChain): LoadedRuleChain {
  const document = readRuleChainDocument(row.document);
  const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Map<string, string[]>>();
  for (const c of document.connections) {
    const byRelation = outgoing.get(c.from) ?? new Map<string, string[]>();
    const to = byRelation.get(c.relation) ?? [];
    to.push(c.to);
    byRelation.set(c.relation, to);
    outgoing.set(c.from, byRelation);
  }
  return {
    id: row.id, name: row.name, root: row.root, debugMode: row.debugMode,
    reEnterOnRuleNodeWrites: row.reEnterOnRuleNodeWrites, firstNodeId: document.firstNodeId,
    document, nodesById, outgoing, updatedAt: row.updatedAt,
  };
}

/** One chain, cached 60 s (a missing id too, as null). Never throws for a malformed stored document. */
export async function getChain(id: string): Promise<LoadedRuleChain | null> {
  const now = Date.now();
  const hit = chainCache.get(id);
  if (hit && now - hit.at < CHAIN_TTL_MS) return hit.value;
  const row = await prisma.ruleChain.findUnique({ where: { id } });
  const value = row ? loadChainFromRow(row) : null;
  chainCache.set(id, { value, at: now });
  return value;
}

/** The root chain: its id cached 5 s, the chain through `getChain`. Null only when no chain is root. */
export async function getRootChain(): Promise<LoadedRuleChain | null> {
  const now = Date.now();
  if (!rootIdCache || now - rootIdCache.at >= ROOT_ID_TTL_MS) {
    const row = await prisma.ruleChain.findFirst({ where: { root: true }, select: { id: true } });
    rootIdCache = { id: row?.id ?? null, at: now };
  }
  return rootIdCache.id ? getChain(rootIdCache.id) : null;
}

/**
 * Drop cached chains — the ids given, or every chain when called with none —
 * and always the cached root id (any of them may have been or become the root).
 */
export function invalidateChainCache(...ids: (string | null | undefined)[]): void {
  const given = ids.filter((i): i is string => typeof i === 'string');
  if (given.length === 0) chainCache.clear();
  for (const id of given) chainCache.delete(id);
  rootIdCache = null;
}
