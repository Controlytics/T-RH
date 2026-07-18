/**
 * Shared types for the filter-operations route family
 * (`routes/filter-management/filter-operations.tsx` desktop +
 *  `routes/mobile/mobile-operations.tsx` tablet).
 *
 * Phase 8.7 Wave-5 split — these types previously lived inline on the desktop
 * page (PendingChecklist) or were typed-as-`any` on the mobile page. Both
 * pages now import from here so the dialog payload shape is one definition.
 */

/**
 * Pending checklist payload as the ChecklistDialog component expects it.
 *
 * Source priority (resolved by the FE pages):
 *   1. The action tape's `SUBMIT_CHECKLIST` actions (via `dialogChecklistsFromActions`)
 *   2. The cached `pendingChecklist[]` on the `filter-state-{id}` cache row
 *      (via `getCachedPendingChecklists` in `lib/offline-cache.ts`)
 *   3. The server's `/current-state` response inline `pendingChecklist[]`
 *
 * All three sources produce the same field shape, by design.
 */
export interface PendingChecklist {
  pipelineNodeId: string;
  checklistProfileId: string;
  checklistProfileName: string;
  /**
   * Phase A.1: server returns the cycle-pinned version (or live fallback).
   * Sent back on submit as `expectedProfileVersions[profileId]` for drift
   * detection. Optional because the cached/legacy paths may not carry it.
   */
  profileVersion?: number;
  questions: PendingChecklistQuestion[];
}

/**
 * One question inside a `PendingChecklist`. Mirrors `TapeQuestion` from the
 * shared executor (intentional — both sources project to this shape).
 */
export interface PendingChecklistQuestion {
  id: string;
  question: string;
  questionType: string;
  required: boolean;
  section: string | null;
  description: string | null;
  options: any[];
  /**
   * Validation hints for NUMERIC questions etc. Not present in every source
   * (the action-tape derived payload doesn't carry it; the cached payload
   * may); typed as a permissive object so existing call-sites compile
   * without widening per-page changes.
   */
  validation?: Record<string, any>;
  sortOrder: number;
}
