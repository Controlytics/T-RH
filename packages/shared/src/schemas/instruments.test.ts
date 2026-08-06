import { describe, it, expect } from 'vitest';
import {
  setInstrumentAttributeSchema,
  updateInstrumentAttributeSchema,
  setInstrumentTokenSchema,
  TOKEN_PREFIX_LEN,
} from './instruments.js';

/**
 * The operator-supplied token rules, tested in ISOLATION — for the same reason
 * the attribute rules are: this schema is what a client form validates against
 * before any request leaves the browser, with no route and no sanitiser in
 * front of it.
 *
 * The 32–128 length bounds were removed 2026-08-06 at the operator's request
 * (a device credential fixed in firmware is not negotiable, and a bound the
 * hardware violates makes the endpoint useless). What these tests pin is the
 * ONE bound that survived, which is not a strength bound at all.
 */
describe('setInstrumentTokenSchema', () => {
  const ok = (token: string) => setInstrumentTokenSchema.safeParse({ token }).success;

  it('accepts a token far shorter than the old 32-character floor', () => {
    // The point of the change. `TOKEN_PREFIX_LEN + 1` characters is the
    // shortest legal token and it must pass, or the removal did not happen.
    expect(ok('a'.repeat(TOKEN_PREFIX_LEN + 1))).toBe(true);
    expect(ok('DEV-KEY-01234')).toBe(true);
  });

  it('accepts a token far longer than the old 128-character ceiling', () => {
    expect(ok('a'.repeat(129))).toBe(true);
    expect(ok('a'.repeat(4096))).toBe(true);
  });

  /**
   * THE BOUND THAT MATTERS, and it is not about brute force.
   *
   * `token_prefix` is the first TOKEN_PREFIX_LEN characters, stored as
   * non-secret and returned by the `INSTRUMENT_READ`-gated list and detail
   * endpoints, where both instrument pages render it. At TOKEN_PREFIX_LEN
   * characters or fewer, that prefix IS the token — so a viewer who cannot
   * reveal tokens would read a live credential off the screen with no password
   * and no `INSTRUMENT_TOKEN_VIEWED` audit row, bypassing all three controls
   * the reveal endpoint rests on.
   *
   * Boundary-exact on purpose: a test that only checked "5 characters is
   * refused" would still pass with the floor set one too low, which is the
   * error that reopens the leak.
   */
  it('refuses a token short enough that its public prefix is the whole value', () => {
    expect(ok('a'.repeat(TOKEN_PREFIX_LEN))).toBe(false);       // prefix === token
    expect(ok('a'.repeat(TOKEN_PREFIX_LEN - 1))).toBe(false);
    expect(ok('a')).toBe(false);
    expect(ok('')).toBe(false);
  });

  it('still refuses anything that would not survive a header, a topic or a JSON line', () => {
    // Unchanged by the length removal: this is a FORMAT rule, not a limit. A
    // space or colon would authenticate here and fail on the device — the worst
    // kind of bug to debug from the field.
    for (const bad of ['has spaces', 'has:colon', 'has/slash', '<script>xx</script>', 'ünïcode', 'plus+sign']) {
      expect(ok(bad), bad).toBe(false);
    }
  });
});

/**
 * The attribute schema's key rules, tested in ISOLATION.
 *
 * The e2e suite cannot prove these: the route runs `sanitizeStrings` first, and
 * that already trims, so an e2e test passes whether or not the schema trims.
 * These rules still have to hold on their own — the same schema is what a client
 * form validates against before any request is sent, and there `sanitizeStrings`
 * has not run. Written as a unit test so removing `.trim()` or the `min(1)`
 * turns something red.
 */
describe('setInstrumentAttributeSchema', () => {
  it('trims the key, so " Room " and "Room" are one attribute', () => {
    const parsed = setInstrumentAttributeSchema.parse({ key: '  Room  ', value: 'CR-1' });
    expect(parsed.key).toBe('Room');
  });

  it('refuses a key that is empty after trimming', () => {
    // A whitespace-only key is unreachable through the edit/delete endpoints
    // (the key is a URL segment) and invisible in a table: it can only ever
    // accumulate. The length check runs AFTER the trim, which is the whole point
    // — `'   '` is 3 characters and would otherwise pass `min(1)`.
    for (const key of ['', ' ', '   ', '\t', '\n \t ']) {
      expect(setInstrumentAttributeSchema.safeParse({ key, value: 'x' }).success).toBe(false);
    }
  });

  it('measures the key length AFTER trimming', () => {
    // 64 significant characters wrapped in spaces is a valid 64-char key, not a
    // 66-char one.
    const key = 'k'.repeat(64);
    expect(setInstrumentAttributeSchema.parse({ key: ` ${key} `, value: 'v' }).key).toBe(key);
    expect(setInstrumentAttributeSchema.safeParse({ key: 'k'.repeat(65), value: 'v' }).success).toBe(false);
  });

  it('accepts an empty value but caps it at 1000', () => {
    // "we track this, we do not know it yet" is a real state; forcing a
    // placeholder like "-" would put junk in a column reports filter on.
    expect(setInstrumentAttributeSchema.safeParse({ key: 'Serial', value: '' }).success).toBe(true);
    expect(setInstrumentAttributeSchema.safeParse({ key: 'Serial', value: 'v'.repeat(1000) }).success).toBe(true);
    expect(setInstrumentAttributeSchema.safeParse({ key: 'Serial', value: 'v'.repeat(1001) }).success).toBe(false);
  });

  it('does not restrict the character set — an attribute is display text', () => {
    // Unlike `code` and the token, this value never becomes an MQTT topic
    // segment or an Authorization header, so a site that records
    // "Certificat d'étalonnage" gets to.
    const parsed = setInstrumentAttributeSchema.parse({
      key: "Certificat d'étalonnage", value: 'Réf. 12/2027 — 校准',
    });
    expect(parsed.key).toBe("Certificat d'étalonnage");
  });
});

describe('updateInstrumentAttributeSchema', () => {
  it('takes only a value — the key is the URL segment', () => {
    expect(updateInstrumentAttributeSchema.parse({ value: 'x' })).toEqual({ value: 'x' });
    expect(updateInstrumentAttributeSchema.safeParse({}).success).toBe(false);
    expect(updateInstrumentAttributeSchema.safeParse({ value: 'v'.repeat(1001) }).success).toBe(false);
  });
});
