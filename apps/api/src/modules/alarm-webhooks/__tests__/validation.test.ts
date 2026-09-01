import { describe, it, expect } from 'vitest';
import { validateTargetDraft } from '../validation.js';

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
