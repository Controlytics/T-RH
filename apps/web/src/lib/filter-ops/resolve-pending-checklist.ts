/**
 * Pending-checklist dialog resolution — Phase 8.7 Wave-5 split.
 *
 * The pattern below appears 8x in `routes/filter-management/filter-operations.tsx`
 * (desktop) and 6x in `routes/mobile/mobile-operations.tsx` (tablet):
 *
 *   const tape = await getCurrentActions(filterId, serverActions);
 *   if (hasActionKind(tape, 'SUBMIT_CHECKLIST')) {
 *     let rows = dialogChecklistsFromActions(tape);
 *     if (rows.length === 0 || rows.every(c => (c.questions?.length ?? 0) === 0)) {
 *       rows = await getCachedPendingChecklists(filterId);
 *     }
 *     if (rows.length > 0) { setChecklistDialog({ ... }); }
 *   }
 *
 * `resolvePendingChecklistDialog` consolidates the resolution. The caller
 * still owns the `setChecklistDialog(...)` wiring because the dialog state
 * shape differs between desktop and mobile (desktop carries
 * `PendingChecklist[]` typed; mobile uses `any[]`).
 *
 * Returns:
 *   - `null` when the tape has no SUBMIT_CHECKLIST actions OR neither the
 *     tape nor the cache produced any rows. Caller does NOT pop a dialog.
 *   - `PendingChecklist[]` (always non-empty) when a dialog should be shown.
 *
 * Tier-1 (server actions): when `serverActions` is non-empty,
 * `getCurrentActions` returns it verbatim; we derive rows from those.
 * Tier-2 (local executor): `getCurrentActions` calls
 * `executor.computeNextActions(loadLocalContextFromCache(filterId))` and we
 * derive rows from that tape.
 * Tier-3 (cached payload): the legacy server response (TAPE_PARALLEL=false)
 * carries `SUBMIT_CHECKLIST` actions WITHOUT inline questions — we fall back
 * to the cached `pendingChecklist[]` shape on the `filter-state-{id}` row,
 * which the dialog renders identically.
 */

import type { Action } from '@digilog/shared';
import {
  getCurrentActions,
  hasActionKind,
} from '@/lib/action-tape';
import {
  dialogChecklistsFromActions,
  getCachedPendingChecklists,
  resolvePendingChecklistForStage,
} from '@/lib/offline-cache';
import { cacheData, OFFLINE_TTL_MS } from '@/lib/offline-store';
import { apiClient } from '@/lib/api-client';
import type { PendingChecklist } from './types';

/** Every row reaching a dialog must carry a questions[] — both pages do `cl.questions.map(...)`. */
function withQuestions(rows: PendingChecklist[]): PendingChecklist[] {
  return rows.map((r) => ({ ...r, questions: Array.isArray(r.questions) ? r.questions : [] }));
}

/**
 * Resolve the checklist for a stage the operator is about to advance INTO —
 * before anything is written. The pre-advance counterpart to
 * `resolvePendingChecklistDialog` (which answers the same question only AFTER
 * the advance has committed, which is the defect being fixed).
 *
 * Cache first, then refetch: the tablet caches `checklist-profiles` (SWR when
 * online + the offline sync), but the DESKTOP page never caches it at all — so
 * a cache-only resolve would silently fall back to the old advance-first path
 * on desktop. The refetch is the same call the sync makes, and
 * `GET /api/checklist-profiles` accepts **FILTER_OPERATE** as an alternate gate
 * (added 2026-07-10 for the roles-lack-FCP_READ 403), so any role that can
 * advance a filter can read the checklist it's required to answer.
 *
 * Returns `[]` for BOTH "no checklist here" and "couldn't resolve it" — the
 * caller must treat `[]` as "fall back to today's post-advance path", never as
 * a licence to skip a gate. The server re-validates on every write regardless.
 */
export async function resolveChecklistForTargetStage(
  filterId: string,
  targetState: string,
  online: boolean,
): Promise<PendingChecklist[]> {
  const first = await resolvePendingChecklistForStage(filterId, targetState);
  if (first.checklists.length > 0) return withQuestions(first.checklists as PendingChecklist[]);
  // No checklist fires after this stage at all — nothing to defer.
  if (first.expectedIds.length === 0) return [];
  // A checklist EXISTS but its questions aren't cached. Offline we can't do
  // better; the caller falls through to the existing path (unchanged behaviour).
  if (!online) return [];
  try {
    const res = await apiClient.get<any>(
      '/api/checklist-profiles?limit=100&isActive=true&expand=questions',
    );
    const list = res?.data ?? res;
    if (!Array.isArray(list)) return [];
    await cacheData('checklist-profiles', list, OFFLINE_TTL_MS);
  } catch {
    return []; // caller falls back to today's behaviour — no regression
  }
  const retry = await resolvePendingChecklistForStage(filterId, targetState);
  return withQuestions(retry.checklists as PendingChecklist[]);
}

/**
 * Resolve the dialog payload for a filter's post-stage checklist gate.
 *
 * @param filterId - the filter whose pending-checklist should be resolved
 * @param serverActions - optional `actions[]` carried on the just-received
 *   server response (e.g. an /advance result). When non-empty, the resolver
 *   trusts the server tape; otherwise it computes locally via the executor.
 * @returns `null` when no dialog should be shown; otherwise a non-empty
 *   `PendingChecklist[]` ready to feed `setChecklistDialog({ checklists: ... })`.
 */
export async function resolvePendingChecklistDialog(
  filterId: string,
  serverActions?: Action[] | null,
): Promise<PendingChecklist[] | null> {
  const tape = await getCurrentActions(filterId, serverActions);
  if (!hasActionKind(tape, 'SUBMIT_CHECKLIST')) return null;

  let rows: PendingChecklist[] = dialogChecklistsFromActions(tape) as PendingChecklist[];
  if (rows.length === 0 || rows.every((c) => (c.questions?.length ?? 0) === 0)) {
    rows = (await getCachedPendingChecklists(filterId)) as PendingChecklist[];
  }
  if (rows.length === 0) return null;
  // Guarantee every row carries a `questions` array before it reaches either
  // page's checklist dialog (both do `cl.questions.map(...)` on render). A
  // stale-shaped cache row could otherwise arrive with `questions` undefined
  // and crash the whole page (the `?.` above already anticipates this).
  return withQuestions(rows);
}
