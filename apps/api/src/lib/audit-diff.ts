/**
 * Sensitive audit keys — never persist these in before/after snapshots.
 * Kept in sync with the frontend copy in apps/web/src/routes/audit/audit-helpers.ts.
 */
export const SENSITIVE_KEY_RE = /password|secret|token|apikey|api[_-]?key|private[_-]?key|credential/i;

/** Deep-clone, dropping any key matching SENSITIVE_KEY_RE. Primitives pass through. */
export function sanitizeAuditValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeAuditValue(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    out[k] = v && typeof v === 'object' ? sanitizeAuditValue(v) : v;
  }
  return out as T;
}
