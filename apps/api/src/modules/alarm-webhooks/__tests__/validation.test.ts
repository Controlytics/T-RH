import { describe, it, expect } from 'vitest';
import { validateTargetDraft, invalidHeader } from '../validation.js';

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'QC-3 hooter',
  url: 'http://192.168.1.60/alarm',
  method: 'POST',
  headers: {},
  contentType: 'application/json',
  bodyTemplate: '{"event":"${event}"}',
  successRegex: null,
  timeoutMs: 5000,
  severities: null,
  cooldownSeconds: 0,
  scopeLocationIds: [],
  scopeInstrumentIds: ['I1'],
  ...over,
});

describe('validateTargetDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(validateTargetDraft(draft() as never)).toBeNull();
  });

  it('requires a name', () => {
    expect(validateTargetDraft(draft({ name: '  ' }) as never)?.field).toBe('name');
  });

  it('requires an http or https url', () => {
    expect(validateTargetDraft(draft({ url: 'ftp://x/y' }) as never)?.field).toBe('url');
    expect(validateTargetDraft(draft({ url: 'not a url' }) as never)?.field).toBe('url');
    expect(validateTargetDraft(draft({ url: 'https://192.168.1.60/a' }) as never)).toBeNull();
  });

  it('rejects an unknown method', () => {
    expect(validateTargetDraft(draft({ method: 'DELETE' }) as never)?.field).toBe('method');
  });

  it('rejects an unparseable success regex before it is ever stored', () => {
    expect(validateTargetDraft(draft({ successRegex: '([' }) as never)?.field).toBe('successRegex');
  });

  it('bounds the timeout', () => {
    expect(validateTargetDraft(draft({ timeoutMs: 0 }) as never)?.field).toBe('timeoutMs');
    expect(validateTargetDraft(draft({ timeoutMs: 120_000 }) as never)?.field).toBe('timeoutMs');
  });

  it('bounds the cooldown', () => {
    expect(validateTargetDraft(draft({ cooldownSeconds: -1 }) as never)?.field).toBe('cooldownSeconds');
    expect(validateTargetDraft(draft({ cooldownSeconds: 90_000 }) as never)?.field).toBe('cooldownSeconds');
  });

  // An empty scope is LEGAL — a target may be configured before its instruments exist.
  // It fires for nothing, and the UI shows the resolved count so that is visible.
  it('allows an empty scope', () => {
    expect(validateTargetDraft(draft({ scopeInstrumentIds: [] }) as never)).toBeNull();
  });

  // The two severity-validation cases that stood here were DELETED on 2026-09-01:
  // `severities` is no longer part of a target draft, so there is nothing left to
  // refuse. `${severity}` in a body template IS still refused — by the unknown-
  // variable rule below, which is the case that now covers it.

  it('rejects a body template naming a variable no event provides', () => {
    expect(validateTargetDraft(draft({ bodyTemplate: '{"x":"${nonsense}"}' }) as never)?.field).toBe('bodyTemplate');
  });

  it('accepts variables only some events provide — the template may draw from the union', () => {
    expect(validateTargetDraft(draft({ bodyTemplate: '{"d":"${duration}","who":"${acknowledgedBy}"}' }) as never)).toBeNull();
  });
});

/**
 * Audit 2026-10-03, API-20: headers were stored unvalidated, and a name with a
 * space or a value with CR/LF made `fetch` throw on EVERY delivery — inside the
 * worker, during an excursion, with the delivery row saying only that fetch
 * threw. The same `Headers` constructor is the judge at save time.
 */
describe('invalidHeader', () => {
  it('accepts a well-formed map and an absent one', () => {
    expect(invalidHeader({ Authorization: 'Bearer x', 'X-Site': 'QC-3' })).toBeNull();
    expect(invalidHeader({})).toBeNull();
    expect(invalidHeader(undefined)).toBeNull();
  });

  it('names a header whose value carries a line break', () => {
    expect(invalidHeader({ 'X-Note': 'line one\r\nline two' })).toMatch(/"X-Note"/);
  });

  it('names a header whose name has a space', () => {
    expect(invalidHeader({ 'X Site': 'QC-3' })).toMatch(/"X Site"/);
  });

  it('refuses an empty name and a non-string value', () => {
    expect(invalidHeader({ '': 'x' })).not.toBeNull();
    expect(invalidHeader({ 'X-N': 7 })).toMatch(/string value/);
  });

  it('refuses a non-map', () => {
    expect(invalidHeader(['X-N: 1'])).not.toBeNull();
  });
});

describe('validateTargetDraft — headers', () => {
  it('refuses a draft whose headers could not be sent, naming the field', () => {
    expect(validateTargetDraft(draft({ headers: { 'X-Note': 'a\r\nb' } }) as never)?.field).toBe('headers');
  });

  it('accepts sendable headers', () => {
    expect(validateTargetDraft(draft({ headers: { Authorization: 'Bearer x' } }) as never)).toBeNull();
  });
});
