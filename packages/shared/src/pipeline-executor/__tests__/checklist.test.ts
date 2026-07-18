/**
 * Phase 8.5 — checklist.ts unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  assertChecklistAnswerKeysValid,
  assertChecklistSchemaFresh,
  assertRequiredChecklistAnswered,
} from '../index.js';
import type { ChecklistQuestion, LocalContext, ResolvedChecklist } from '../index.js';

const ctx = {} as LocalContext; // guards don't read ctx fields here

function q(id: string, required = false): ChecklistQuestion {
  return {
    id,
    question: `Q-${id}`,
    questionType: 'TEXT',
    required,
    section: null,
    description: null,
    options: [],
    validation: {},
    sortOrder: 0,
  };
}

function resolved(profileId: string, version: number, questions: ChecklistQuestion[]): ResolvedChecklist {
  return {
    pipelineNodeId: `node-${profileId}`,
    checklistProfileId: profileId,
    checklistProfileName: `Profile ${profileId}`,
    profileVersion: version,
    questions,
  };
}

describe('assertChecklistSchemaFresh', () => {
  it('passes when expectedProfileVersions is null', () => {
    expect(assertChecklistSchemaFresh(ctx, null, [])).toEqual({ ok: true });
  });
  it('passes when expected map omits the resolved profile id', () => {
    const r = assertChecklistSchemaFresh(ctx, { other: 1 }, [resolved('cl-1', 2, [])]);
    expect(r).toEqual({ ok: true });
  });
  it('passes when expected version matches resolved version', () => {
    const r = assertChecklistSchemaFresh(ctx, { 'cl-1': 2 }, [resolved('cl-1', 2, [])]);
    expect(r).toEqual({ ok: true });
  });
  it('rejects with SCHEMA_DRIFT when versions differ', () => {
    const r = assertChecklistSchemaFresh(ctx, { 'cl-1': 1 }, [resolved('cl-1', 2, [])]);
    expect(r).toMatchObject({
      ok: false,
      code: 'SCHEMA_DRIFT',
      details: { drift: [{ profileId: 'cl-1', expected: 1, current: 2 }] },
    });
  });
  it('passes when resolved is empty', () => {
    expect(assertChecklistSchemaFresh(ctx, { 'cl-1': 1 }, [])).toEqual({ ok: true });
  });
});

describe('assertRequiredChecklistAnswered', () => {
  it('passes when all required answered', () => {
    const cl = [resolved('cl-1', 1, [q('q1', true), q('q2', true), q('q3', false)])];
    const r = assertRequiredChecklistAnswered(ctx, { q1: 'yes', q2: 'no' }, cl);
    expect(r).toEqual({ ok: true });
  });
  it('rejects with VALIDATION_ERROR on first missing required', () => {
    const cl = [resolved('cl-1', 1, [q('q1', true), q('q2', true)])];
    const r = assertRequiredChecklistAnswered(ctx, { q1: 'ok', q2: '' }, cl);
    expect(r).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Required checklist question not answered: q2',
    });
  });
  it('passes when answers is null/undefined (matches source gate)', () => {
    expect(assertRequiredChecklistAnswered(ctx, null, [])).toEqual({ ok: true });
    expect(assertRequiredChecklistAnswered(ctx, undefined, [])).toEqual({ ok: true });
  });
  it('rejects when value is undefined', () => {
    const cl = [resolved('cl-1', 1, [q('q1', true)])];
    const r = assertRequiredChecklistAnswered(ctx, {}, cl);
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  });
});

describe('assertChecklistAnswerKeysValid', () => {
  it('passes when all keys are valid', () => {
    const cl = [resolved('cl-1', 1, [q('q1'), q('q2')])];
    const r = assertChecklistAnswerKeysValid(ctx, { q1: 'a', q2: 'b' }, cl);
    expect(r).toEqual({ ok: true });
  });
  it('rejects with INVALID_QUESTIONS listing extra keys', () => {
    const cl = [resolved('cl-1', 1, [q('q1')])];
    const r = assertChecklistAnswerKeysValid(ctx, { q1: 'ok', extra1: 'x', extra2: 'y' }, cl);
    expect(r).toMatchObject({
      ok: false,
      code: 'INVALID_QUESTIONS',
      message: 'Unexpected answer keys (not in any active checklist for this stage): extra1, extra2',
    });
  });
  it('passes when answers is null/undefined', () => {
    expect(assertChecklistAnswerKeysValid(ctx, null, [])).toEqual({ ok: true });
    expect(assertChecklistAnswerKeysValid(ctx, undefined, [])).toEqual({ ok: true });
  });
});
