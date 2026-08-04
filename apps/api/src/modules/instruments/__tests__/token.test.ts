import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, tokenPrefix, tokenMatches, TOKEN_PREFIX_LEN } from '../token.js';

describe('device tokens', () => {
  it('generates a distinct high-entropy token each call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);   // base64url, safe in a header
  });

  it('hashes deterministically to 64 hex chars (sha256)', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives a stable prefix for lookup', () => {
    const t = generateToken();
    expect(tokenPrefix(t)).toBe(t.slice(0, TOKEN_PREFIX_LEN));
    expect(tokenPrefix(t)).toHaveLength(TOKEN_PREFIX_LEN);
  });

  it('matches a token against its own hash', () => {
    const t = generateToken();
    expect(tokenMatches(t, hashToken(t))).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(tokenMatches(generateToken(), hashToken(generateToken()))).toBe(false);
  });

  it('rejects a malformed stored hash without throwing', () => {
    const t = generateToken();
    expect(tokenMatches(t, '')).toBe(false);
    expect(tokenMatches(t, 'not-hex')).toBe(false);
    expect(tokenMatches(t, 'ab'.repeat(10))).toBe(false);  // wrong length
  });
});
