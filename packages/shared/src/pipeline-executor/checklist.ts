/**
 * Checklist-validation guards (Phase 8.5).
 *
 * Pure portions of submitChecklist() in
 * `apps/api/src/modules/filter-operations/filter-operations.service.ts`
 * (lines 884-921). Schema-drift detection + answer-shape validation.
 */
import type {
  ChecklistQuestion,
  GuardResult,
  LocalContext,
} from './types.js';

/**
 * Resolved per-checklist-node payload as built by the service's
 * `resolveChecklistQuestions` (lines 158-181). Re-declared here so the guard
 * is callable from tests + the FE without depending on the service shape.
 */
export interface ResolvedChecklist {
  pipelineNodeId: string;
  checklistProfileId: string;
  checklistProfileName: string;
  /** Live profile version (or pinned version when cycle has pins). */
  profileVersion: number;
  questions: ChecklistQuestion[];
}

/**
 * Guard #4: detect schema drift between the offline cache and the live profile.
 *
 * `expectedProfileVersions` is the offline cache's snapshot of `(profileId →
 * version)`. `resolved` is what the server resolved against (live or pinned).
 * Mismatch → 409 SCHEMA_DRIFT with `{ drift: [{ profileId, expected, current }] }`.
 *
 * Mirrors filter-operations.service.ts:884-898. When
 * `expectedProfileVersions` is null/undefined OR the resolved checklists list
 * is empty, the guard is a non-check.
 */
export function assertChecklistSchemaFresh(
  _ctx: LocalContext,
  expectedProfileVersions: Record<string, number> | null | undefined,
  resolved: ResolvedChecklist[],
): GuardResult {
  if (!expectedProfileVersions) return { ok: true };
  if (resolved.length === 0) return { ok: true };

  const drift: Array<{ profileId: string; expected: number; current: number }> = [];
  for (const cl of resolved) {
    const expected = expectedProfileVersions[cl.checklistProfileId];
    const current = cl.profileVersion ?? 1;
    if (expected !== undefined && expected !== current) {
      drift.push({ profileId: cl.checklistProfileId, expected, current });
    }
  }
  if (drift.length === 0) return { ok: true };

  return {
    ok: false,
    code: 'SCHEMA_DRIFT',
    message: 'Checklist profile changed since this submission was prepared. Please reload and re-answer.',
    details: { drift },
  };
}

/**
 * Guard #5: every required question on the resolved checklists has an answer.
 *
 * Mirrors filter-operations.service.ts:909-914. Throws on the FIRST missing
 * required question — message includes that question id (preserving original
 * server behavior for parity with existing tests / FE error rendering).
 *
 * `answers === null | undefined | non-object` skips the check entirely
 * (matches the `if (answers && typeof answers === 'object')` gate at L909).
 */
export function assertRequiredChecklistAnswered(
  _ctx: LocalContext,
  answers: Record<string, unknown> | null | undefined,
  resolved: ResolvedChecklist[],
): GuardResult {
  if (!answers || typeof answers !== 'object') return { ok: true };
  for (const cl of resolved) {
    for (const q of cl.questions) {
      if (!q.required) continue;
      const v = answers[q.id];
      if (v === undefined || v === null || v === '') {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Required checklist question not answered: ${q.id}`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Guard #6: reject answer keys not present in any of the resolved checklists.
 *
 * Mirrors filter-operations.service.ts:917-920. Existing extras would be
 * hash-bound + audit-immutable, so the server rejects them up-front.
 */
export function assertChecklistAnswerKeysValid(
  _ctx: LocalContext,
  answers: Record<string, unknown> | null | undefined,
  resolved: ResolvedChecklist[],
): GuardResult {
  if (!answers || typeof answers !== 'object') return { ok: true };
  const validQuestionIds = new Set<string>();
  for (const cl of resolved) {
    for (const q of cl.questions) validQuestionIds.add(q.id);
  }
  const answerKeys = Object.keys(answers);
  const extraKeys = answerKeys.filter(k => !validQuestionIds.has(k));
  if (extraKeys.length === 0) return { ok: true };
  return {
    ok: false,
    code: 'INVALID_QUESTIONS',
    message: `Unexpected answer keys (not in any active checklist for this stage): ${extraKeys.join(', ')}`,
  };
}
