import { randomBytes } from 'node:crypto';
import type { RuleOriginatorType } from '@digilog/shared';

/**
 * A rule-engine MESSAGE (rule chains, 2026-11-03; spec §4): ThingsBoard's
 * TbMsg — `{ id, type, originator, metadata, data }`. `data` is what a node
 * script sees as `msg`; `metadata` values are always strings, as in
 * ThingsBoard.
 *
 * `_stack` and `_hops` are ENGINE-INTERNAL: the Rule chain node's call stack
 * (popped by an Output node) and the hop counter the hop limit reads. They are
 * never shown to a script and never written to a debug row.
 */
export interface RuleOriginator {
  type: RuleOriginatorType;
  id: string;
  /** The instrument CODE when the originator is an instrument and it is known. */
  code?: string;
}

export interface RuleStackFrame {
  chainId: string;
  nodeId: string;
}

export interface RuleMessage {
  id: string;
  type: string;
  originator: RuleOriginator;
  metadata: Record<string, string>;
  data: unknown;
  _stack?: RuleStackFrame[];
  _hops?: number;
}

/** The metadata key every message carries: where it came from (spec §5's loop guard). */
export const RULE_ENGINE_ORIGIN_KEY = 'rule_engine_origin';
/** A device report: telemetry or attributes ingest already STORED (Save nodes may skip it — ruling S-3). */
export const INGEST_ORIGIN = 'ingest';
/** The alarm evaluator, the inactivity pass — the system itself. */
export const SYSTEM_ORIGIN = 'system';
/** A person's write through a route (acknowledge, instrument create / update / delete). */
export const USER_ORIGIN = 'user';
/** `POST /api/rule-engine/v1/messages`. */
export const REST_API_ORIGIN = 'rest_api';

const RULE_NODE_ORIGIN_PREFIX = 'rule_node:';

/**
 * The origin a write made BY a rule node carries: `rule_node:<chainId>:<nodeId>`.
 * The chain id is the chain that MADE the write — its "Re-enter on rule-node
 * writes" switch decides whether the write's own event re-enters the engine.
 */
export function ruleNodeOrigin(chainId: string, nodeId: string): string {
  return `${RULE_NODE_ORIGIN_PREFIX}${chainId}:${nodeId}`;
}

/**
 * A node's identity across chains: `<chainId>:<nodeId>` (two chains may carry
 * the same node ids). `ctx.nodeKey` — key per-node state (an MQTT client, a
 * deduplication window, a counter) by THIS, never by the node id alone.
 */
export function ruleNodeKey(chainId: string, nodeId: string): string {
  return `${chainId}:${nodeId}`;
}

export function isRuleNodeOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && origin.startsWith(RULE_NODE_ORIGIN_PREFIX);
}

/** `{ chainId, nodeId }` of a rule-node origin, else null. */
export function parseRuleNodeOrigin(origin: string | null | undefined): RuleStackFrame | null {
  if (!isRuleNodeOrigin(origin)) return null;
  const rest = (origin as string).slice(RULE_NODE_ORIGIN_PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { chainId: rest.slice(0, i), nodeId: rest.slice(i + 1) };
}

/**
 * A time-ordered message id (UUID v7 layout: 48-bit Unix milliseconds, then
 * random bits), so debug rows sorted by id read in arrival order.
 */
export function newMessageId(now = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * One metadata VALUE as ThingsBoard holds it — a string. null / undefined →
 * undefined (the key is dropped); objects are serialised.
 */
export function metadataValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return String(v.getTime());
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** A metadata MAP: every value a string, null / undefined values dropped. */
export function toMetadata(input: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    const s = metadataValue(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

export function newMessage(
  type: string,
  originator: RuleOriginator,
  data: unknown,
  metadata: Record<string, unknown> = {},
): RuleMessage {
  return { id: newMessageId(), type, originator: { ...originator }, metadata: toMetadata(metadata), data };
}

/**
 * A plain-JSON deep copy of `data`. Dates become ISO strings, functions and
 * undefined vanish, a cycle or a BigInt throws — `data` is a JSON document, so
 * anything that is not JSON has no business in it.
 */
export function cloneData<T>(data: T): T {
  if (data === undefined) return data;
  return JSON.parse(JSON.stringify(data)) as T;
}

/**
 * A copy a node may change without touching the original: data deep-copied,
 * metadata copied, the call stack copied (a fan-out branch pops its OWN stack).
 * `patch` replaces whole fields.
 */
export function copyMessage(msg: RuleMessage, patch: Partial<Omit<RuleMessage, '_stack' | '_hops'>> = {}): RuleMessage {
  return {
    id: patch.id ?? msg.id,
    type: patch.type ?? msg.type,
    originator: { ...(patch.originator ?? msg.originator) },
    metadata: { ...(patch.metadata ?? msg.metadata) },
    data: 'data' in patch ? cloneData(patch.data) : cloneData(msg.data),
    ...(msg._stack ? { _stack: msg._stack.map((f) => ({ ...f })) } : {}),
    ...(msg._hops !== undefined ? { _hops: msg._hops } : {}),
  };
}

/** The first `frames` "at …" lines of a stack. */
export function stackHead(stack: string | undefined, frames = 3): string {
  if (!stack) return '';
  return stack.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, frames).join('\n');
}

/** What an error SAYS: its message, a thrown string itself, else its text. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  const m = (err as { message?: unknown } | null)?.message;
  if (typeof m === 'string') return m;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * The message a `Failure` carries (spec §6): `metadata.error` = the error's
 * message, `metadata.errorStack` = its first three stack frames (absent when
 * there is no stack). The data is untouched.
 */
export function failureMessage(msg: RuleMessage, err: unknown): RuleMessage {
  const out = copyMessage(msg);
  out.metadata.error = errorText(err);
  // A script's own stack (script-vm.ts) says where in the SCRIPT it failed; the host stack would not.
  const scriptStack = (err as { scriptStack?: unknown } | null)?.scriptStack;
  const frames = stackHead(typeof scriptStack === 'string' && scriptStack ? scriptStack : err instanceof Error ? err.stack : undefined);
  if (frames) out.metadata.errorStack = frames;
  else delete out.metadata.errorStack;
  return out;
}

/**
 * The message as JSON for a durable job, its call stack AND hop count kept
 * (ruled 2026-11-04): a cycle through Delay / Checkpoint must still reach the
 * hop limit, and an Output after a Checkpoint must still find its caller.
 */
export function serialisableMessage(msg: RuleMessage): RuleMessage {
  return {
    id: msg.id, type: msg.type, originator: { ...msg.originator }, metadata: { ...msg.metadata },
    data: cloneData(msg.data),
    ...(msg._stack && msg._stack.length > 0 ? { _stack: msg._stack.map((f) => ({ ...f })) } : {}),
    ...(msg._hops !== undefined ? { _hops: msg._hops } : {}),
  };
}

/** graphile's attempts for a `rule_engine_message` job — what `services.durable.enqueue` passes. */
export const DURABLE_JOB_MAX_ATTEMPTS = 5;

/**
 * The PAYLOAD of a `rule_engine_message` job (the shape `ruleEngineMessageJobSchema`
 * in @digilog/queue parses): the message with its stack and hop count, its re-entry
 * depth when above 0 (ruling RE-1), the node it resumes AFTER, and the relation when
 * it is not `Success`. The engine's batched hand-back on stop (M6) builds its jobs
 * here; `services.durable.enqueue` builds the same shape inline today (a unit test
 * pins that the two agree — durable-handback.test.ts).
 */
export function durableJobPayload(
  msg: RuleMessage, chainId: string, nodeId: string, opts: { reentryDepth: number; relation?: string },
): Record<string, unknown> {
  return {
    message: { ...serialisableMessage(msg), ...(opts.reentryDepth > 0 ? { _reentryDepth: opts.reentryDepth } : {}) },
    chainId,
    resumeAfterNodeId: nodeId,
    ...(opts.relation && opts.relation !== 'Success' ? { relation: opts.relation } : {}),
  };
}
