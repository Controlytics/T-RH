import { describe, it, expect } from 'vitest';
import {
  updateInstrumentSchema,
  setInstrumentAttributeSchema,
  updateInstrumentAttributeSchema,
  setInstrumentTokenSchema,
  createInstrumentSchema,
  instrumentCodeTopicViolation,
  MQTT_RESERVED_TOPIC_SEGMENTS,
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
  /**
   * REVERSED 2026-08-07 at the operator's request: no length floor at all.
   *
   * The floor existed for a real reason, which has NOT gone away —
   * `instrument_credentials.token_prefix` is the first TOKEN_PREFIX_LEN
   * characters, returned by the INSTRUMENT_READ list and detail endpoints, so a
   * token that short is fully disclosed to any viewer with no password and no
   * `INSTRUMENT_TOKEN_VIEWED` audit row. That is now the operator's call, warned
   * at the point of entry in `token-panel.tsx` rather than refused after it.
   *
   * This test is kept, inverted, so the reversal is deliberate rather than
   * something a future edit re-tightens by accident.
   */
  it('accepts a token short enough for its public prefix to expose it', () => {
    expect(ok('a'.repeat(TOKEN_PREFIX_LEN))).toBe(true);
    expect(ok('a')).toBe(true);
  });

  it('still refuses an empty token', () => {
    expect(ok('')).toBe(false);
  });

  /**
   * The charset went with the length: a credential fixed in a device's firmware
   * is not negotiable, and a rule the hardware violates makes the feature
   * unusable.
   */
  it('accepts spaces, symbols and unicode the old charset refused', () => {
    for (const good of ['has spaces', 'has:colon', 'has/slash', 'plus+sign', 'ünïcode', '<b>']) {
      expect(ok(good), good).toBe(true);
    }
  });

  /**
   * The ONE rule left, and it is physics rather than policy. The token travels
   * as an `Authorization: Bearer` header value, an MQTT username, and a field in
   * the newline-delimited TCP protocol. A CR or LF survives none of the three —
   * the HTTP client rejects it (or it becomes header injection) and the TCP
   * framing splits mid-credential. Accepting one would mint a credential that
   * authenticates nowhere.
   */
  it('refuses a line break, which no transport could carry', () => {
    for (const bad of ['abc\ndef', 'abc\rdef', 'trailing\n']) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
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

/**
 * The code IS the MQTT client id and the topic segment again (2026-09-04,
 * operator: "i want client id as CWH/RDU/001-00"). That puts operator text
 * back into a topic, so the three things that would let one instrument reach
 * another's topic are refused HERE, at registration — the ACL template
 * `instruments/${clientid}/...` cannot defend itself against a client id of
 * `+`. Everything else, including `/`, is allowed: the plant's codes are
 * `CWH/RDU/001-00` and a slash is a topic level, which the bridge handles by
 * matching a fixed prefix and suffix rather than counting segments.
 */
describe('instrumentCodeTopicViolation', () => {
  it("accepts the plant's slash-separated codes", () => {
    for (const ok of ['CWH/RDU/001-00', 'IOTGW01', 'A/B/C', 'has spaces', 'ünïcode', '<b>', 'A/', '/A']) {
      expect(instrumentCodeTopicViolation(ok)).toBeNull();
    }
  });

  it('refuses the MQTT wildcard characters — a client id of + matches every instrument', () => {
    for (const bad of ['+', '#', 'A+B', 'A/#', 'CWH/+/001']) {
      expect(instrumentCodeTopicViolation(bad)).toMatch(/\+|#/);
    }
  });

  it('refuses a NUL character, which a topic cannot carry', () => {
    expect(instrumentCodeTopicViolation('A\u0000B')).toMatch(/NUL/i);
  });

  it('refuses a code whose LAST segment is a topic keyword', () => {
    // The bridge subscribes `instruments/#` and reads the message KIND from the
    // last segment. A child coded `X/telemetry` gets its attribute downlink on
    // `instruments/<gw>/attributes/X/telemetry`, which parses as telemetry for
    // an instrument coded `<gw>/attributes/X`.
    for (const word of MQTT_RESERVED_TOPIC_SEGMENTS) {
      expect(instrumentCodeTopicViolation(word)).toMatch(new RegExp(word));
      expect(instrumentCodeTopicViolation(`CWH/${word}`)).toMatch(new RegExp(word));
      // Only the LAST segment is reserved — a keyword elsewhere is unambiguous.
      expect(instrumentCodeTopicViolation(`${word}/CWH`)).toBeNull();
      expect(instrumentCodeTopicViolation(`${word}-01`)).toBeNull();
    }
  });
});

describe('updateInstrumentSchema — code (2026-09-16)', () => {
  // The code became changeable on the operator's instruction ("in settings
  // Instrument id should be changable"). The SAME rule as on create applies:
  // no MQTT wildcard, no reserved last segment. The route handles uniqueness
  // and the broker consequences.
  it('accepts a code and applies the topic rule to it', () => {
    expect(updateInstrumentSchema.safeParse({ code: 'CWH/RDU/009-00' }).success).toBe(true);
    const bad = updateInstrumentSchema.safeParse({ code: 'CWH/+/009' });
    expect(bad.success).toBe(false);
  });

  it('keeps the code optional — a PUT without one changes nothing about it', () => {
    const r = updateInstrumentSchema.safeParse({ name: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBeUndefined();
  });
});

describe('createInstrumentSchema — code', () => {
  const base = { name: 'n', profileId: '11111111-1111-4111-8111-111111111111' };

  it('accepts a slash-separated code', () => {
    const r = createInstrumentSchema.safeParse({ ...base, code: 'CWH/RDU/001-00' });
    expect(r.success).toBe(true);
  });

  it('refuses a wildcard code with the topic reason on the code field', () => {
    const r = createInstrumentSchema.safeParse({ ...base, code: '+' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const codeIssue = r.error.issues.find((i) => i.path[0] === 'code');
      expect(codeIssue?.message).toMatch(/\+/);
    }
  });

  it('still refuses an empty code', () => {
    expect(createInstrumentSchema.safeParse({ ...base, code: '' }).success).toBe(false);
  });
});
