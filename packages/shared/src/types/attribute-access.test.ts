import { describe, it, expect } from 'vitest';
import {
  parseAttributeAccess,
  canEditAttributeKey,
  canAddAttribute,
  attributeWriteNeedsReauth,
  validateAttributeRemark,
  effectiveAttributeAccess,
  ATTRIBUTE_REMARK_MIN,
  ATTRIBUTE_REMARK_MAX,
} from './attribute-access.js';

const sel = (keys: string[], requireReauth = false) =>
  ({ mode: 'SELECTED' as const, keys, requireReauth });

describe('parseAttributeAccess', () => {
  it('reads a well-formed value', () => {
    expect(parseAttributeAccess({ mode: 'SELECTED', keys: ['A', 'B'], requireReauth: true }))
      .toEqual({ mode: 'SELECTED', keys: ['A', 'B'], requireReauth: true });
  });

  it('treats anything it does not recognise as UNCONFIGURED, never as a grant', () => {
    // A restore, an older release or a hand-edit can leave any shape here.
    // Inheriting today's behaviour is a safe answer; inventing ALL_EDIT is not.
    for (const bad of [null, undefined, 'ALL_EDIT', 42, [], {}, { mode: 'EVERYTHING' }]) {
      expect(parseAttributeAccess(bad)).toBeNull();
    }
  });

  it('cleans the key list rather than trusting it', () => {
    const a = parseAttributeAccess({ mode: 'SELECTED', keys: [' Room ', 'Room', '', 7, null] });
    expect(a?.keys).toEqual(['Room']);
  });

  it('defaults requireReauth to false unless it is exactly true', () => {
    expect(parseAttributeAccess({ mode: 'ALL_EDIT' })?.requireReauth).toBe(false);
    expect(parseAttributeAccess({ mode: 'ALL_EDIT', requireReauth: 'yes' })?.requireReauth).toBe(false);
  });
});

describe('canEditAttributeKey', () => {
  it('refuses without INSTRUMENT_UPDATE, whatever the mode says', () => {
    // The rule NARROWS the permission; it must never be a second route to it.
    expect(canEditAttributeKey({ mode: 'ALL_EDIT', keys: [], requireReauth: false }, 'Room', false))
      .toBe(false);
    expect(canEditAttributeKey(null, 'Room', false)).toBe(false);
  });

  it('behaves exactly as before when the role is unconfigured', () => {
    expect(canEditAttributeKey(null, 'anything', true)).toBe(true);
  });

  it('ALL_EDIT allows every key; ALL_VIEW allows none', () => {
    expect(canEditAttributeKey({ mode: 'ALL_EDIT', keys: [], requireReauth: false }, 'Room', true)).toBe(true);
    expect(canEditAttributeKey({ mode: 'ALL_VIEW', keys: ['Room'], requireReauth: false }, 'Room', true)).toBe(false);
  });

  it('SELECTED allows only the named keys', () => {
    expect(canEditAttributeKey(sel(['Room']), 'Room', true)).toBe(true);
    expect(canEditAttributeKey(sel(['Room']), 'High Temperature Limit', true)).toBe(false);
  });

  it('matches a selected key case-insensitively and ignoring space', () => {
    // The keys are operator-typed on both sides; an exact-match rule would make
    // the config silently do nothing.
    expect(canEditAttributeKey(sel([' room ']), 'Room', true)).toBe(true);
    expect(canEditAttributeKey(sel(['High Temperature']), 'high temperature', true)).toBe(true);
  });

  it('SELECTED with an empty list is view-only, not everything', () => {
    expect(canEditAttributeKey(sel([]), 'Room', true)).toBe(false);
  });
});

describe('canAddAttribute', () => {
  it('follows the permission first', () => {
    expect(canAddAttribute({ mode: 'ALL_EDIT', keys: [], requireReauth: false }, false)).toBe(false);
  });

  it('allows adding in SELECTED mode — a new key cannot overwrite a protected one', () => {
    expect(canAddAttribute(sel(['Room']), true)).toBe(true);
  });

  it('blocks adding for a read-only role', () => {
    expect(canAddAttribute({ mode: 'ALL_VIEW', keys: [], requireReauth: false }, true)).toBe(false);
  });

  it('allows adding when unconfigured', () => {
    expect(canAddAttribute(null, true)).toBe(true);
  });
});

describe('attributeWriteNeedsReauth', () => {
  it('is off unless the role is configured for it', () => {
    expect(attributeWriteNeedsReauth(null)).toBe(false);
    expect(attributeWriteNeedsReauth({ mode: 'ALL_EDIT', keys: [], requireReauth: false })).toBe(false);
    expect(attributeWriteNeedsReauth({ mode: 'ALL_EDIT', keys: [], requireReauth: true })).toBe(true);
  });
});

describe('validateAttributeRemark', () => {
  it('accepts a real sentence', () => {
    expect(validateAttributeRemark('Corrected against the calibration certificate')).toBeNull();
  });

  it('refuses blank, whitespace and too-short', () => {
    expect(validateAttributeRemark('')).toBeTruthy();
    expect(validateAttributeRemark('    ')).toBeTruthy();
    expect(validateAttributeRemark('a'.repeat(ATTRIBUTE_REMARK_MIN - 1))).toBeTruthy();
    expect(validateAttributeRemark(null)).toBeTruthy();
    expect(validateAttributeRemark(undefined)).toBeTruthy();
  });

  it('refuses one long enough to overflow signature_meaning', () => {
    // VARCHAR(255) and auditLog does not truncate: an over-long remark would
    // write the attribute and THEN throw, leaving the change unaudited.
    expect(validateAttributeRemark('a'.repeat(ATTRIBUTE_REMARK_MAX + 1))).toBeTruthy();
    expect(validateAttributeRemark('a'.repeat(ATTRIBUTE_REMARK_MAX))).toBeNull();
  });
});

describe('effectiveAttributeAccess — a user rule COMBINED with the role rule (2026-10-24)', () => {
  const rule = (mode: 'ALL_EDIT' | 'ALL_VIEW' | 'SELECTED', keys: string[] = [], requireReauth = false) => ({ mode, keys, requireReauth });

  it("no user rule: the role rule, unchanged (today's behaviour)", () => {
    expect(effectiveAttributeAccess(null, null)).toBeNull();
    const r = rule('SELECTED', ['Room']);
    expect(effectiveAttributeAccess(r, null)).toBe(r);
  });

  it("role not configured (all editable): stays all editable; only the user's re-auth switch can add a prompt", () => {
    expect(effectiveAttributeAccess(null, rule('ALL_VIEW'))).toEqual(rule('ALL_EDIT'));
    expect(effectiveAttributeAccess(null, rule('SELECTED', ['a'], true))).toEqual(rule('ALL_EDIT', [], true));
  });

  it('ALL_EDIT on either side wins', () => {
    expect(effectiveAttributeAccess(rule('ALL_EDIT'), rule('ALL_VIEW'))).toEqual(rule('ALL_EDIT'));
    expect(effectiveAttributeAccess(rule('ALL_VIEW'), rule('ALL_EDIT'))).toEqual(rule('ALL_EDIT'));
  });

  it('view-only only when BOTH are view-only', () => {
    expect(effectiveAttributeAccess(rule('ALL_VIEW'), rule('ALL_VIEW'))).toEqual(rule('ALL_VIEW'));
    expect(effectiveAttributeAccess(rule('ALL_VIEW'), rule('SELECTED', ['b']))).toEqual(rule('SELECTED', ['b']));
    expect(effectiveAttributeAccess(rule('SELECTED', ['a']), rule('ALL_VIEW'))).toEqual(rule('SELECTED', ['a']));
  });

  it('selected keys: the union, folded case-insensitively, first spelling kept', () => {
    expect(effectiveAttributeAccess(rule('SELECTED', ['Room', 'Area']), rule('SELECTED', ['room', 'Location'])))
      .toEqual(rule('SELECTED', ['Room', 'Area', 'Location']));
  });

  it('re-auth is never dropped by combining', () => {
    expect(effectiveAttributeAccess(rule('SELECTED', ['a'], true), rule('SELECTED', ['b']))?.requireReauth).toBe(true);
    expect(effectiveAttributeAccess(rule('SELECTED', ['a']), rule('SELECTED', ['b'], true))?.requireReauth).toBe(true);
  });

  it('still needs Edit Instruments: the combined rule never edits without it', () => {
    const eff = effectiveAttributeAccess(rule('ALL_VIEW'), rule('ALL_EDIT'));
    expect(canEditAttributeKey(eff, 'Room', false)).toBe(false);
    expect(canEditAttributeKey(eff, 'Room', true)).toBe(true);
  });
});
