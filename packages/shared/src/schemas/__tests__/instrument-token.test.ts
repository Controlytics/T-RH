import { describe, it, expect } from 'vitest';
import { setInstrumentTokenSchema } from '../instruments.js';

/**
 * An operator-supplied token has NO length limit and NO charset (2026-08-07).
 * A device's credential is often fixed in firmware or on an installer's sheet;
 * a rule the hardware violates makes the feature unusable, and the operator
 * cannot change the hardware.
 */
const parse = (token: string) => setInstrumentTokenSchema.safeParse({ token });

describe('setInstrumentTokenSchema', () => {
  it('accepts any length, including one the old floor refused', () => {
    expect(parse('a').success).toBe(true);
    expect(parse('a'.repeat(500)).success).toBe(true);
  });

  it('accepts symbols, spaces and unicode the old charset refused', () => {
    for (const t of ['has spaces', 'a:b/c+d#e', '!@#$%^&*()', 'ключ-é-ok', '<b>']) {
      expect(parse(t).success, t).toBe(true);
    }
  });

  /**
   * The one rule that is physics, not policy. The token travels as an
   * `Authorization: Bearer` header value, an MQTT username, and a field in the
   * newline-delimited TCP protocol. A CR or LF cannot survive any of the three
   * — the HTTP client rejects it (or it becomes header injection) and the TCP
   * framing splits mid-credential. Accepting one would mint a credential that
   * authenticates nowhere, which is worse than refusing it.
   */
  it('refuses a line break, on both forms', () => {
    expect(parse('abc\ndef').success).toBe(false);
    expect(parse('abc\rdef').success).toBe(false);
    expect(parse('trailing\n').success).toBe(false);
  });

  it('refuses an empty token', () => {
    expect(parse('').success).toBe(false);
  });
});
