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

/** `{phone}`, `{message}` — a gateway template placeholder, not a secret. */
const PLACEHOLDER = /^\{[A-Za-z_]+\}$/;

/**
 * Splits an operator-typed URL template into its parts WITHOUT `new URL()`:
 * the WHATWG parser percent-encodes `{` and `}`, which would turn `{phone}` into
 * `%7Bphone%7D` and break the gateway template on the next save.
 */
function splitUrl(url: string) {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = noHash.indexOf('?');
  let base = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const query = qAt >= 0 ? noHash.slice(qAt + 1) : null;
  // userinfo password: scheme://user:PASSWORD@host
  let password: string | null = null;
  const ui = /^([a-z][a-z0-9+.-]*:\/\/[^/@:]*):([^/@]*)@/i.exec(base);
  if (ui) {
    password = ui[2];
    base = `${ui[1]}:\u0000@${base.slice(ui[0].length)}`;
  }
  const params = query === null ? null : query.split('&').map((p) => {
    const eq = p.indexOf('=');
    return eq >= 0 ? { key: p.slice(0, eq), value: p.slice(eq + 1), bare: false } : { key: p, value: '', bare: true };
  });
  return { base, password, params, hash };
}

function joinUrl(s: ReturnType<typeof splitUrl>): string {
  const base = s.password === null ? s.base : s.base.replace('\u0000', s.password);
  const q = s.params === null ? '' : `?${s.params.map((p) => (p.bare ? p.key : `${p.key}=${p.value}`)).join('&')}`;
  return `${base}${q}${s.hash}`;
}

/**
 * The URL with every query VALUE masked except a bare placeholder, and any
 * userinfo password masked. Fail-closed on purpose: the common SMS gateways put
 * the API key in the query string under a name of their own choosing (`authkey`,
 * `apikey`, `key`, `token`, `pwd`…), so a list of "secret-looking" names would
 * leak the next one. The KEYS stay readable.
 */
export function maskUrlSecrets(
  url: string | null | undefined,
  opts: { secretNamesOnly?: boolean } = {},
): string | null | undefined {
  if (!url) return url;
  const s = splitUrl(url);
  if (s.password) s.password = SECRET_MASK;
  if (s.params) {
    for (const p of s.params) {
      if (!p.value || PLACEHOLDER.test(p.value)) continue;
      // `secretNamesOnly` — for a WEBHOOK URL (audit 2026-10-12 follow-up): a
      // hooter's query is mostly device settings (`?relay=1&mode=pulse`), and
      // masking those would hide the configuration the page exists to show.
      // The SMS gateway URL stays fail-closed (every value masked).
      if (opts.secretNamesOnly && !isSecretName(p.key)) continue;
      p.value = SECRET_MASK;
    }
  }
  return joinUrl(s);
}

/**
 * Does a field / parameter NAME say it carries a credential? Matched as a
 * substring, case-insensitively: `authkey`, `api_key`, `apiKey`, `access_token`,
 * `password`, `pwd`, `signature`, `Authorization`, `credential`…  Used only
 * where masking EVERY value would destroy what an operator must read (a body
 * template, a webhook URL); it is a recognisable-shape rule, not a guarantee.
 */
const SECRET_NAME = /(key|token|secret|pass(word|wd)?|pwd|sig(nature)?|credential|auth)/i;
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** `"name": "value"` (JSON) — value may contain escaped quotes. */
const JSON_PAIR = /"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
/** `name=value` at the start or after `&`, `?` or whitespace (form / query). */
const FORM_PAIR = /(^|[?&\s])([A-Za-z0-9_.\-]+)=([^&\s"]*)/g;

type Pair = { name: string; value: string };

function templatePairs(tpl: string): Pair[] {
  const out: Pair[] = [];
  for (const m of tpl.matchAll(JSON_PAIR)) out.push({ name: m[1], value: m[3] });
  for (const m of tpl.matchAll(FORM_PAIR)) out.push({ name: m[2], value: m[3] });
  return out;
}

/** Rewrite each secret-named pair's value through `fn(name, value, nthOfName)`. */
function rewriteSecretPairs(tpl: string, fn: (name: string, value: string, nth: number) => string): string {
  const seen = new Map<string, number>();
  const nth = (name: string) => { const n = seen.get(name) ?? 0; seen.set(name, n + 1); return n; };
  const afterJson = tpl.replace(JSON_PAIR, (whole, name: string, sep: string, value: string) => {
    if (!isSecretName(name)) return whole;
    return `"${name}"${sep}"${fn(name, value, nth(name))}"`;
  });
  return afterJson.replace(FORM_PAIR, (whole, lead: string, name: string, value: string) => {
    if (!isSecretName(name)) return whole;
    return `${lead}${name}=${fn(name, value, nth(name))}`;
  });
}

/**
 * The SMS gateway BODY TEMPLATE with every secret-NAMED field's value masked
 * (audit 2026-10-12 follow-up). Not every value, unlike the gateway URL: the
 * template is the operator's message layout, and masking `{"sender":"DIGLOG"}`
 * or the field names would make it uneditable. A placeholder is never masked.
 */
export function maskTemplateSecrets(tpl: string | null | undefined): string | null | undefined {
  if (!tpl) return tpl;
  return rewriteSecretPairs(tpl, (_n, value) => (value && !PLACEHOLDER.test(value) ? SECRET_MASK : value));
}

/** Mask-means-keep for a template: the n-th masked `name` takes the n-th stored `name`'s value. */
export function restoreMaskedTemplate(
  submitted: string,
  stored: string | null | undefined,
): { value: string } | { unresolved: string } {
  if (!submitted.includes(SECRET_MASK)) return { value: submitted };
  const storedByName = new Map<string, string[]>();
  for (const p of templatePairs(stored ?? '')) {
    const list = storedByName.get(p.name) ?? [];
    list.push(p.value);
    storedByName.set(p.name, list);
  }
  let unresolved: string | null = null;
  const value = rewriteSecretPairs(submitted, (name, v, n) => {
    if (v !== SECRET_MASK) return v;
    const kept = storedByName.get(name)?.[n];
    if (kept === undefined || kept === '') { unresolved ??= name; return v; }
    return kept;
  });
  if (unresolved) return { unresolved };
  if (value.includes(SECRET_MASK)) return { unresolved: 'a masked part of the template' };
  return { value };
}

/**
 * Put the stored values back wherever the submitted URL carries the mask: a query
 * value by its key (the n-th occurrence of a key maps to the n-th stored one), a
 * userinfo password by position. A mask with nothing stored behind it is refused.
 */
export function restoreMaskedUrl(
  submitted: string,
  stored: string | null | undefined,
): { url: string } | { unresolved: string } {
  if (!submitted.includes(SECRET_MASK)) return { url: submitted };
  const s = splitUrl(submitted);
  const st = stored ? splitUrl(stored) : null;
  if (s.password === SECRET_MASK) {
    if (!st?.password) return { unresolved: 'the URL password' };
    s.password = st.password;
  }
  if (s.params) {
    const seen = new Map<string, number>();
    for (const p of s.params) {
      const n = seen.get(p.key) ?? 0;
      seen.set(p.key, n + 1);
      if (p.value !== SECRET_MASK) continue;
      const match = (st?.params ?? []).filter((q) => q.key === p.key)[n];
      if (!match || !match.value) return { unresolved: `query parameter "${p.key}"` };
      p.value = match.value;
    }
  }
  const out = joinUrl(s);
  if (out.includes(SECRET_MASK)) return { unresolved: 'a masked part of the URL' };
  return { url: out };
}
