/**
 * Audit-payload secret masking.
 *
 * Audit rows are immutable and hash-chained (21 CFR §11.10(e)) — a secret that
 * reaches `audit_trail` cannot be scrubbed without breaking the chain, and it
 * propagates into every backup and export. AUDIT_READ is held by far more roles
 * than CONFIG_UPDATE, so an unmasked config body is a real privilege boundary
 * crossing, not a theoretical one.
 *
 * **Allowlist, not denylist.** A denylist of known secret names silently leaks
 * the next secret field someone adds to a config shape. An allowlist fails
 * closed: an unrecognised key is redacted until a human deliberately declares
 * it safe. Given the write is permanent, "redact something harmless" is the
 * cheap error and "leak a token forever" is the expensive one.
 *
 * Key names are matched at EVERY depth, which is what makes a nested bag of
 * caller-defined keys (e.g. `httpGatewayHeaders`, whose *values* routinely
 * carry bearer tokens) safe by omission rather than by special case.
 */

export const REDACTED = '[redacted]';

function walk(value: unknown, safe: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, safe));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = safe.has(key) ? walk(v, safe) : REDACTED;
  }
  return out;
}

/**
 * Return a copy of `value` in which every key NOT named in `safeKeys` has its
 * value replaced by {@link REDACTED}. The key itself survives, so the audit row
 * still records that the field was present in the submitted body — only the
 * content is withheld.
 *
 * Each call site declares its own allowlist because "safe" is a property of the
 * config shape, not of the key name in the abstract.
 */
export function maskSecrets(value: unknown, safeKeys: readonly string[] | ReadonlySet<string>): unknown {
  const safe = safeKeys instanceof Set ? safeKeys : new Set(safeKeys);
  return walk(value, safe);
}
