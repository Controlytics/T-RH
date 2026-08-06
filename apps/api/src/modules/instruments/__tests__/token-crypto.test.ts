import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptToken, decryptToken, tokenKeyConfigured, resetTokenKeyCache } from '../token-crypto.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

/**
 * The key is read from the environment and memoised, so every test that changes
 * `INSTRUMENT_TOKEN_KEY` must drop the memo — otherwise the second test in a
 * file silently runs against the first one's key and proves nothing.
 */
function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env.INSTRUMENT_TOKEN_KEY;
  else process.env.INSTRUMENT_TOKEN_KEY = value;
  resetTokenKeyCache();
}

const original = process.env.INSTRUMENT_TOKEN_KEY;
beforeEach(() => setKey(KEY_A));
afterEach(() => setKey(original));

describe('token-crypto', () => {
  it('round-trips a token', () => {
    const plain = 'abcdefgh_ijklmnop-1234567890.ABCDEFG';
    const blob = encryptToken(plain);
    expect(blob).not.toBeNull();
    expect(blob).not.toContain(plain);
    expect(decryptToken(blob as string)).toBe(plain);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plain = 'the-same-token-twice';
    const a = encryptToken(plain);
    const b = encryptToken(plain);
    expect(a).not.toBe(b);
    // ...and both still decrypt to the same value.
    expect(decryptToken(a as string)).toBe(plain);
    expect(decryptToken(b as string)).toBe(plain);
  });

  it('stores three base64 parts: iv:authTag:ciphertext', () => {
    const blob = encryptToken('token') as string;
    const parts = blob.split(':');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0], 'base64')).toHaveLength(12);  // GCM IV
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(16);  // GCM auth tag
  });

  it('THROWS rather than returning garbage when decrypted with a different key', () => {
    const blob = encryptToken('secret-token') as string;
    setKey(KEY_B);
    expect(() => decryptToken(blob)).toThrow();
  });

  it('throws on a tampered ciphertext (the auth tag is doing its job)', () => {
    const blob = encryptToken('secret-token') as string;
    const [iv, tag, ct] = blob.split(':');
    const bytes = Buffer.from(ct, 'base64');
    bytes[0] ^= 0xff;
    expect(() => decryptToken(`${iv}:${tag}:${bytes.toString('base64')}`)).toThrow();
  });

  it('throws on a tampered auth tag', () => {
    const blob = encryptToken('secret-token') as string;
    const [iv, tag, ct] = blob.split(':');
    const bytes = Buffer.from(tag, 'base64');
    bytes[0] ^= 0xff;
    expect(() => decryptToken(`${iv}:${bytes.toString('base64')}:${ct}`)).toThrow();
  });

  it('throws on a malformed blob rather than silently returning something', () => {
    expect(() => decryptToken('not-a-blob')).toThrow();
    expect(() => decryptToken('')).toThrow();
    expect(() => decryptToken('a:b')).toThrow();
  });

  it('returns null and reports not-configured when the env var is unset', () => {
    setKey(undefined);
    expect(tokenKeyConfigured()).toBe(false);
    expect(encryptToken('anything')).toBeNull();
  });

  it('treats an empty / whitespace key as unset rather than as a key', () => {
    setKey('   ');
    expect(tokenKeyConfigured()).toBe(false);
    expect(encryptToken('anything')).toBeNull();
  });

  it('reports configured when a key is present', () => {
    expect(tokenKeyConfigured()).toBe(true);
  });

  it('accepts a hex key as well as base64', () => {
    const hex = randomBytes(32).toString('hex');
    setKey(hex);
    expect(tokenKeyConfigured()).toBe(true);
    expect(decryptToken(encryptToken('hex-keyed') as string)).toBe('hex-keyed');
  });

  it('REJECTS a key of the wrong length with a clear message, never truncating', () => {
    setKey(randomBytes(16).toString('base64'));
    expect(tokenKeyConfigured()).toBe(false);
    expect(() => encryptToken('x')).toThrow(/INSTRUMENT_TOKEN_KEY/);
    expect(() => encryptToken('x')).toThrow(/32 bytes/);
  });

  it('REJECTS an unparseable key rather than hashing it into one', () => {
    setKey('!!! not base64 or hex !!!');
    expect(tokenKeyConfigured()).toBe(false);
    expect(() => encryptToken('x')).toThrow(/INSTRUMENT_TOKEN_KEY/);
  });

  it('a base64 key and its hex form are the SAME key', () => {
    const raw = randomBytes(32);
    setKey(raw.toString('base64'));
    const blob = encryptToken('cross-encoding') as string;
    setKey(raw.toString('hex'));
    expect(decryptToken(blob)).toBe('cross-encoding');
  });
});
