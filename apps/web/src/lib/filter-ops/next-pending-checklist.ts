/**
 * Multi-filter batch checklist cycling — the "next pending" finder.
 *
 * Background: when an operator scans a batch of filters and submits the queue,
 * the post-advance step may need to pop a checklist dialog for any/all of the
 * filters whose pipeline prescribes a CHECKLIST node after this stage. The
 * desktop and mobile pages BOTH used to do:
 *
 *   for (const item of batch) {
 *     const rows = await resolveDialog(item.filterId);
 *     if (rows) { setChecklistDialog(...); break; }
 *   }
 *
 * — which only ever opened the dialog for the FIRST filter with a pending
 * checklist. After that one was submitted the dialog closed and the rest of
 * the batch silently skipped the gate (PHASE_5_RECENT_WORK.md § 11 known
 * follow-up from session 04-20).
 *
 * The fix is to CYCLE the dialog through every batch item that has a pending
 * checklist. The page stores the remaining (un-resolved) batch in state, and
 * after each successful submission walks the queue to find the next filter
 * whose tape STILL says SUBMIT_CHECKLIST is pending. Filters whose checklist
 * was just submitted return `null` from `resolvePendingChecklistDialog` and
 * are skipped automatically — the cycle self-terminates when no more remain.
 *
 * `findNextPendingChecklist` is a pure helper that performs that walk. It
 * takes the remaining batch + an injected resolver (so the caller — desktop or
 * mobile route — wires its own `resolvePendingChecklistDialog` reference) and
 * returns the first item that surfaced a non-null dialog payload, plus the
 * tail of the batch that the caller should persist for the NEXT cycle.
 *
 * Returning `null` means "no more dialogs needed" — the caller clears the
 * batch state and the cycle ends.
 */

import type { PendingChecklist } from './types';

export interface PendingChecklistBatchItem {
  filterId: string;
  filterName: string;
}

export interface NextPendingChecklistResult {
  item: PendingChecklistBatchItem;
  checklists: PendingChecklist[];
  /**
   * The portion of the batch AFTER the resolved item. The caller stores this
   * back into state so the next submit-then-cycle iteration starts here.
   * Items that returned `null` from the resolver (no dialog needed) are
   * already consumed and not present in `remaining`.
   */
  remaining: PendingChecklistBatchItem[];
}

/**
 * Walk `batch` in order, calling `resolver(filterId)` for each item. Stop at
 * the first item that returns a non-null `PendingChecklist[]` and return the
 * resolved payload + the items AFTER it as `remaining`. Returns `null` when
 * no item in the batch needs a dialog.
 *
 * Items that resolve to `null` are SKIPPED (consumed from the batch) — the
 * checklist either was never required (e.g. the filter wasn't in a CHECKLIST
 * gate) or has already been submitted on a prior cycle iteration.
 */
export async function findNextPendingChecklist(
  batch: ReadonlyArray<PendingChecklistBatchItem>,
  resolver: (filterId: string) => Promise<PendingChecklist[] | null>,
): Promise<NextPendingChecklistResult | null> {
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    let checklists: PendingChecklist[] | null = null;
    try {
      checklists = await resolver(item.filterId);
    } catch {
      // A resolver failure for one filter must not poison the whole cycle —
      // skip and let the operator re-scan if they need to retry that one.
      checklists = null;
    }
    if (checklists && checklists.length > 0) {
      return { item, checklists, remaining: batch.slice(i + 1) };
    }
  }
  return null;
}
