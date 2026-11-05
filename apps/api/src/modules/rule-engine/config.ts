import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

/**
 * Configuration → Rule Engine and Configuration → Application Attributes
 * (rule chains, 2026-11-03; spec §10). The ONE reader of each row — the
 * engine, its workers and the routes all read through here, never the row.
 *
 * Lives beside the module, not beside a route, so a graphile worker importing
 * it does not drag the HTTP layer into the job runner (the alarm-loader rule).
 * Both readers cache for 10 s; the defs' `afterUpdate` hooks invalidate the
 * cache, so a save through the config page applies at once.
 */
export const RULE_ENGINE_CONFIG_KEY = 'rule-engine';
export const RULE_ENGINE_ATTRIBUTES_CONFIG_KEY = 'rule-engine-attributes';

export interface RuleEngineConfig {
  /** OFF stops processing and empties the queue (Task 3). Default ON: the shipped root chain is a no-op. */
  enabled: boolean;
  /** Save time series / Save attributes skip a message ingest already stored (ruling S-3). */
  skipSaveNodesForIngestOrigin: boolean;
  scriptTimeoutMs: number;
  /**
   * The Main queue's size AND (2026-11-05, fw-api open item 3) each originator's durable
   * queue's: `services.durable.enqueue` refuses — the Delay / Checkpoint node's Failure,
   * nothing queued — when `rule-engine:<originatorId>` already holds this many waiting jobs,
   * so a fan-out cycle through Delay / Checkpoint (whose step count restarts at every durable
   * resume) stops there.
   */
  queueCapacity: number;
  concurrency: number;
  debugRetentionHours: number;
  debugMaxEventsPerNode: number;
  httpTimeoutMs: number;
  hopLimit: number;
  /**
   * The longest ONE message (with every copy it makes) may take through the chains (C1,
   * 2026-11-05; was a hard-coded 30 s). A node still running then is abandoned and the
   * message ends `MESSAGE_TIMEOUT`.
   */
  messageBudgetMs: number;
}

/**
 * Every number setting: its shipped default and its bounds — the def declares the same.
 *
 * `scriptTimeoutMs` is at most 5 000 ms (ruling RE-3, 2026-11-05): a node script
 * runs synchronously on the API's one event loop (ingest, HTTP, the MQTT bridge),
 * so ONE call can hold it for up to that long. A script that keeps timing out is
 * switched off after three consecutive time-outs (script-vm.ts); one that runs just
 * UNDER the timeout never is, and holds the loop that long on every message (review
 * A I1, accepted: ThingsBoard's TBEL runs in-process too). Between nodes a flow
 * yields to the loop after ~10 ms of work (C1, engine.ts), so several script nodes
 * no longer add up to one block. The old 30 000 allowed 30 s per call. A row stored
 * before the cap reads as the cap (logged).
 *
 * `messageBudgetMs` (C1) bounds one message's wall time; `hopLimit` one lineage's
 * length; hopLimit × 10 node runs over all of a message's copies ends a flow that
 * fans out in a cycle (STEP_LIMIT, engine.ts).
 */
export const RULE_ENGINE_NUMBER_SETTINGS = {
  scriptTimeoutMs: { default: 2_000, min: 100, max: 5_000 },
  queueCapacity: { default: 10_000, min: 100, max: 1_000_000 },
  concurrency: { default: 8, min: 1, max: 64 },
  debugRetentionHours: { default: 24, min: 1, max: 720 },
  debugMaxEventsPerNode: { default: 1_000, min: 10, max: 100_000 },
  httpTimeoutMs: { default: 10_000, min: 1_000, max: 120_000 },
  hopLimit: { default: 200, min: 10, max: 10_000 },
  // At least the HTTP timeout's maximum (a REST node may wait 120 s); 5 minutes at most.
  messageBudgetMs: { default: 30_000, min: 1_000, max: 300_000 },
} as const satisfies Record<string, { default: number; min: number; max: number }>;

type NumberKey = keyof typeof RULE_ENGINE_NUMBER_SETTINGS;

export const RULE_ENGINE_CONFIG_DEFAULTS: Readonly<RuleEngineConfig> = Object.freeze({
  enabled: true,
  skipSaveNodesForIngestOrigin: true,
  ...(Object.fromEntries(
    Object.entries(RULE_ENGINE_NUMBER_SETTINGS).map(([k, v]) => [k, v.default]),
  ) as Record<NumberKey, number>),
});

/** A key of Configuration → Application Attributes: what the Tenant attributes node fetches by. */
export const APPLICATION_ATTRIBUTE_KEY_MAX = 128;
export const APPLICATION_ATTRIBUTE_VALUE_MAX = 4_000;
export const APPLICATION_ATTRIBUTES_MAX = 500;

const CACHE_TTL_MS = 10_000;
let engineCache: { value: RuleEngineConfig; at: number } | null = null;
let attributesCache: { value: Record<string, string>; at: number } | null = null;

/** `<key>:<stored value>` already logged as clamped — once per stored value, not every read. */
const clampLogged = new Set<string>();

function noteClamped(key: NumberKey, stored: number, used: number): void {
  const k = `${key}:${stored}`;
  if (clampLogged.has(k)) return;
  if (clampLogged.size >= 100) clampLogged.clear();
  clampLogged.add(k);
  const { min, max } = RULE_ENGINE_NUMBER_SETTINGS[key];
  logger.warn({ setting: key, stored, used, min, max },
    `[rule-engine] Configuration → Rule Engine: ${key} is stored as ${stored}, outside ${min}..${max} — ${used} is used. Save the page to store a value in range.`);
}

/**
 * The stored row, setting by setting: a key that is absent, of the wrong type
 * or not a finite number reads as its shipped default; a number outside its
 * bounds is clamped to them, with a warning logged once per stored value (only
 * a hand-edited row, or one saved before a bound was tightened — RE-3 — can hold
 * one; the config PUT refuses it). The dynamic PUT replaces the whole row, so
 * nothing here may assume a key is present.
 */
export function coerceRuleEngineConfig(raw: unknown): RuleEngineConfig {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const bool = (key: 'enabled' | 'skipSaveNodesForIngestOrigin') =>
    (typeof v[key] === 'boolean' ? v[key] as boolean : RULE_ENGINE_CONFIG_DEFAULTS[key]);
  const num = (key: NumberKey) => {
    const spec = RULE_ENGINE_NUMBER_SETTINGS[key];
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) return spec.default;
    const whole = Math.floor(n);
    const used = Math.min(spec.max, Math.max(spec.min, whole));
    if (used !== whole) noteClamped(key, n, used);
    return used;
  };
  return {
    enabled: bool('enabled'),
    skipSaveNodesForIngestOrigin: bool('skipSaveNodesForIngestOrigin'),
    scriptTimeoutMs: num('scriptTimeoutMs'),
    queueCapacity: num('queueCapacity'),
    concurrency: num('concurrency'),
    debugRetentionHours: num('debugRetentionHours'),
    debugMaxEventsPerNode: num('debugMaxEventsPerNode'),
    httpTimeoutMs: num('httpTimeoutMs'),
    hopLimit: num('hopLimit'),
    messageBudgetMs: num('messageBudgetMs'),
  };
}

/** Configuration → Rule Engine, cached 10 s. Never throws for a bad row: every setting has a default. */
export async function getRuleEngineConfig(): Promise<RuleEngineConfig> {
  const now = Date.now();
  if (engineCache && now - engineCache.at < CACHE_TTL_MS) return engineCache.value;
  const row = await prisma.systemConfig.findUnique({ where: { configKey: RULE_ENGINE_CONFIG_KEY }, select: { configValue: true } });
  const value = coerceRuleEngineConfig(row?.configValue);
  engineCache = { value, at: now };
  return value;
}

/**
 * The stored list as a key → value map, for the Tenant attributes node.
 * Entries that are not `{ key, value }` strings, or whose key is blank once
 * trimmed, are skipped; the FIRST of two keys that differ only by case wins
 * (the config PUT refuses such a pair, so only a hand-edited row has one).
 */
export function coerceApplicationAttributes(raw: unknown): Record<string, string> {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).attributes
    : undefined;
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { key, value } = item as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const k = key.trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out[k] = value;
  }
  return out;
}

/** Configuration → Application Attributes as a map, cached 10 s. */
export async function getApplicationAttributes(): Promise<Record<string, string>> {
  const now = Date.now();
  if (attributesCache && now - attributesCache.at < CACHE_TTL_MS) return { ...attributesCache.value };
  const row = await prisma.systemConfig.findUnique({ where: { configKey: RULE_ENGINE_ATTRIBUTES_CONFIG_KEY }, select: { configValue: true } });
  const value = coerceApplicationAttributes(row?.configValue);
  attributesCache = { value, at: now };
  return { ...value };
}

/** Drops both caches. Called by the defs' `afterUpdate` hooks; tests call it after writing a row directly. */
export function invalidateRuleEngineConfigCache(): void {
  engineCache = null;
  attributesCache = null;
}
