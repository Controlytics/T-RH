/**
 * Phase 8.5 — justification.ts unit tests.
 */
import { describe, expect, it } from 'vitest';
import { assertJustificationValid } from '../index.js';
import type { LocalContext } from '../index.js';

const ctx = {} as LocalContext;

describe('assertJustificationValid', () => {
  it('passes when justification meets default min length (10)', () => {
    expect(assertJustificationValid(ctx, '1234567890')).toEqual({ ok: true });
    expect(assertJustificationValid(ctx, 'this is plenty long')).toEqual({ ok: true });
  });
  it('rejects with JUSTIFICATION_REQUIRED when too short', () => {
    expect(assertJustificationValid(ctx, 'short')).toMatchObject({
      ok: false,
      code: 'JUSTIFICATION_REQUIRED',
    });
  });
  it('rejects with bypass-specific message when kind=bypass', () => {
    const r = assertJustificationValid(ctx, '', { kind: 'bypass' });
    expect(r).toMatchObject({
      ok: false,
      code: 'JUSTIFICATION_REQUIRED',
      message: 'Bypass justification required (min 10 characters)',
    });
  });
  it('rejects with terminate message when kind=terminate', () => {
    const r = assertJustificationValid(ctx, '', { kind: 'terminate' });
    expect(r).toMatchObject({
      ok: false,
      code: 'JUSTIFICATION_REQUIRED',
      message: 'Justification required (min 10 characters)',
    });
  });
  it('rejects null / undefined / non-string with JUSTIFICATION_REQUIRED', () => {
    expect(assertJustificationValid(ctx, null)).toMatchObject({ ok: false });
    expect(assertJustificationValid(ctx, undefined)).toMatchObject({ ok: false });
  });
  it('respects custom minLength', () => {
    expect(assertJustificationValid(ctx, '12345', { minLength: 5 })).toEqual({ ok: true });
    expect(assertJustificationValid(ctx, '1234', { minLength: 5 })).toMatchObject({
      ok: false,
    });
  });
});
