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

// ─── Response masking: a secret sent to a browser ─────────────────────────────
//
// Separate from the audit masking above. A config screen must SHOW that a secret
// is set without showing it, and its Save must send the screen back without
// wiping the secret. The convention, already used by notification-settings for
// the SMTP password and the SMS tokens: the server replaces the value with
// SECRET_MASK on the way out, and a SECRET_MASK coming back means "keep what is
// stored". (Audit 2026-10-12 #6 extended it to webhook header values and to the
// SMS gateway's headers and URL query values.)

/** Eight bullets. Not a valid HTTP header byte, so it can never be stored by accident. */
export const SECRET_MASK = '••••••••';

/** A copy of a header map with every VALUE masked; the names are kept. */
export function maskHeaderValues(headers: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name] = value ? SECRET_MASK : value;
  return out;
}

/**
 * Put the stored value back wherever a submitted header value is the mask. A mask
 * for a name with no stored value cannot be resolved — the operator renamed a
 * header without retyping its value — and is refused rather than stored as eight
 * bullets. A header absent from `submitted` is removed (that is how a screen
 * deletes one).
 */
export function restoreMaskedHeaders(
  submitted: Record<string, string>,
  stored: Record<string, string> | null | undefined,
): { headers: Record<string, string> } | { unresolved: string } {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(submitted)) {
    if (value === SECRET_MASK) {
      const kept = stored?.[name];
      if (kept === undefined) return { unresolved: name };
      out[name] = kept;
    } else {
      out[name] = value;
    }
  }
  return { headers: out };
}
