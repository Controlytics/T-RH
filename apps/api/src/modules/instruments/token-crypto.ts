import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Reversible storage for a device access token, so an operator can be SHOWN the
 * credential a device is using instead of having to regenerate it and go
 * reconfigure the device.
 *
 * This reverses design decision D5 ("token stored hashed, shown once — a
 * retrievable credential is a standing liability", spec
 * `2026-08-04-instruments-inbound-ingestion-design.md`), at the operator's
 * explicit request on 2026-08-06. The compensating controls are: encrypted at
 * rest with a key held OUTSIDE the database, gated on `INSTRUMENT_UPDATE` plus
 * a password re-auth, and every single view written to the hash-chained audit
 * trail.
 *
 * WHAT THIS PROTECTS
 *   A stolen database — a `pg_dump`, a filesystem backup, a lifted RDS snapshot,
 *   a SQL-injection read — yields ciphertext and nothing else. The key lives in
 *   `INSTRUMENT_TOKEN_KEY` in the environment, not in any table, so possession
 *   of the data alone does not yield a usable device credential.
 *
 * WHAT THIS DOES NOT PROTECT
 *   A host compromise. Anyone who can read BOTH the database and the process
 *   environment (or `.env`) can decrypt every token. This is confidentiality at
 *   rest, not confidentiality from an attacker who owns the machine. Nor does it
 *   protect against a legitimate operator with `INSTRUMENT_UPDATE` reading a
 *   token — it makes that act *attributable*, which is the actual §11 control.
 *
 * AUTHENTICATION NEVER DECRYPTS.
 *   `resolveInstrumentByToken` compares the presented token against the SHA-256
 *   hash in `instrument_credentials.token_hash`, exactly as before. The
 *   ciphertext is a second, purely informational copy. If the two ever disagree
 *   the hash is right and the ciphertext is what is broken — which is why
 *   `token_encrypted` is nullable, and why ingest keeps working with no key
 *   configured at all.
 */

/** AES-256-GCM: 12-byte IV is the standard/efficient size, 16-byte tag. */
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const ENV_VAR = 'INSTRUMENT_TOKEN_KEY';

/** Memoised per resolved env value so the parse cost is not paid per token. */
let cached: { raw: string; key: Buffer | null } | null = null;

/** Test seam: drops the memo so a test can swap `INSTRUMENT_TOKEN_KEY`. */
export function resetTokenKeyCache(): void {
  cached = null;
}

/**
 * Accepts the key as hex (64 chars) or base64 (44 chars). Anything that does not
 * decode to exactly 32 bytes is an ERROR, never a silent truncate or pad — a
 * key that is quietly wrong would encrypt tokens nobody can ever read back.
 */
function parseKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${ENV_VAR} must decode to exactly 32 bytes (got ${buf.length}). ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return buf;
}

/**
 * The key, or null when none is configured. A key that IS configured but
 * unusable throws — silence there would look identical to "no key", and the
 * operator would never learn why nothing is recoverable.
 */
function getKey(): Buffer | null {
  const raw = (process.env[ENV_VAR] ?? '').trim();
  // The memo is keyed on the raw env value, so changing the variable
  // self-invalidates it — the reset seam below is belt-and-braces for tests.
  if (cached && cached.raw === raw) return cached.key;
  if (raw === '') {
    cached = { raw, key: null };
    return null;
  }
  // The failure path is deliberately NOT memoised: parseKey throws, and it must
  // keep throwing on every later call rather than degrade into a quiet null.
  const key = parseKey(raw);
  cached = { raw, key };
  return key;
}

/**
 * True when a usable 32-byte key is configured. Deliberately never throws — it
 * answers the UI's "can this instrument's token be revealed at all?" question,
 * and a misconfigured key is a *no*, reported through the reveal path's specific
 * error rather than as a crash on a status check.
 */
export function tokenKeyConfigured(): boolean {
  try {
    return getKey() !== null;
  } catch {
    return false;
  }
}

/**
 * `iv:authTag:ciphertext`, all base64, one column. Returns null — not a throw —
 * when no key is configured: issuing a credential must never depend on the key
 * being present, or a deployment without one could not register a device.
 */
export function encryptToken(plain: string): string | null {
  const key = getKey();
  if (!key) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Throws on a missing key, a malformed blob, the WRONG key, or any tampering
 * (GCM's auth tag catches the last two). Callers must translate the throw into a
 * specific error; there is no partial or best-effort result by design.
 */
export function decryptToken(blob: string): string {
  const key = getKey();
  if (!key) throw new Error(`${ENV_VAR} is not configured; stored tokens cannot be decrypted.`);

  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted token: expected iv:authTag:ciphertext.');
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error('Malformed encrypted token: bad IV or auth-tag length.');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // `final()` is what verifies the tag — a wrong key or a flipped byte throws
  // here rather than yielding plausible-looking garbage.
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
