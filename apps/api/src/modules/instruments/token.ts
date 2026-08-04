import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Length of the stored, non-secret prefix used to index-seek a credential. */
export const TOKEN_PREFIX_LEN = 8;

/**
 * 32 random bytes -> 43 base64url chars. base64url so the value is safe in an
 * Authorization header, an MQTT username and a JSON line without escaping.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, NOT bcrypt. bcrypt exists to make guessing LOW-entropy human
 * passwords slow; at rounds=12 it costs ~300ms, which would cap ingest at a
 * handful of readings per second. A 256-bit random token cannot be guessed, so
 * a fast hash is the correct control here.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LEN);
}

/** Timing-safe compare so a response-time oracle cannot reveal the hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
