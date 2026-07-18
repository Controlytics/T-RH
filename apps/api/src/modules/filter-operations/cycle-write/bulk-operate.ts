/**
 * Filter Operations — bulk-operate() orchestration.
 *
 * Batches advance / start-and-advance / submit-checklist / advance-with-checklist
 * ops for the tablet to submit 50-100 filter cleaning ops in one request instead
 * of one-per-filter. Each item runs via the existing single-op service method
 * (own transaction, own audit row, all gates). Per-item try/catch -> partial
 * success: a failed filter does not affect the others.
 *
 * TRANSACTION SCOPE (2026-07-16): the transaction is PER ITEM, and that is why
 * an item's own atomicity has to come from the service method it calls — this
 * orchestrator cannot provide it. A stage advance whose target carries a
 * mandatory checklist must therefore be sent as ONE `advance-with-checklist`
 * item, never as an `advance` item plus a `submit-checklist` item: the latter is
 * two transactions with a gap between them, and an operator who abandons the
 * checklist leaves a committed stage transition whose required attestation never
 * happened (21 CFR §11). See cycle-write/advance-with-checklist.ts.
 */
import type { RequestContext } from '../../../types/context.js';
import type { FilterOperationsService } from '../filter-operations.service.js';

export type BulkOpKind = 'advance' | 'start-and-advance' | 'submit-checklist' | 'advance-with-checklist';

export interface BulkOpItem {
  clientOpId: string;
  filterId: string;
  kind: BulkOpKind;
  payload?: any;          // advance | submit-checklist body
  cyclePayload?: any;     // start-and-advance: start-cycle body
  advancePayload?: any;   // start-and-advance: advance body
}

export type BulkOpResult =
  | { clientOpId: string; filterId: string; status: 'ok'; snapshot: any }
  | { clientOpId: string; filterId: string; status: 'failed'; error: { code: string; message: string } };

/** Reauth action implied by each op kind (mid-cycle advance is not reauth-gated). */
export function reauthActionsForItems(items: BulkOpItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.kind === 'advance') set.add('ADVANCE_FILTER_STAGE');
    else if (it.kind === 'start-and-advance') set.add('START_CLEANING_CYCLE');
    else if (it.kind === 'submit-checklist') set.add('SUBMIT_CHECKLIST_WITH_SIGNATURE');
    // Performs BOTH writes in one tx, so it must clear BOTH gates — mirrors the
    // single-filter /advance-with-checklist route.
    else if (it.kind === 'advance-with-checklist') {
      set.add('ADVANCE_FILTER_STAGE');
      set.add('SUBMIT_CHECKLIST_WITH_SIGNATURE');
    }
  }
  return [...set];
}

/**
 * Orchestrate a batch of cleaning ops. Each item runs via the existing single-op
 * service method (own transaction, own audit row, all gates). Per-item try/catch
 * -> partial success: a failed filter does not affect the others.
 *
 * Notes matching the single-op paths (parity, not gaps):
 * - start-and-advance's advance half is intentionally NOT ADVANCE_FILTER_STAGE-
 *   reauth-gated (reauthActionsForItems maps it to START_CLEANING_CYCLE only) —
 *   the single-filter path also treats /advance as non-reauth (see use-offline.ts
 *   "/advance is NOT in the reauth config"). Only matters if an admin ever gates
 *   ADVANCE_FILTER_STAGE.
 * - idempotency: item.clientOpId correlates request<->response; per-item replay
 *   dedup relies on the tapeVersion staleness guard (advance/submit-checklist) and
 *   CYCLE_ACTIVE (start-and-advance), not on a threaded clientOpId — acceptable for
 *   the online-only bulk path. A lost-response retry is caught by those guards.
 */
export async function bulkOperate(
  service: FilterOperationsService,
  ctx: RequestContext,
  items: BulkOpItem[],
): Promise<{ results: BulkOpResult[] }> {
  const results: BulkOpResult[] = [];
  for (const item of items) {
    try {
      let snapshot: any;
      if (item.kind === 'advance') {
        snapshot = await service.advance(ctx, item.filterId, item.payload);
      } else if (item.kind === 'start-and-advance') {
        await service.startCycle(ctx, item.filterId, item.cyclePayload);
        snapshot = await service.advance(ctx, item.filterId, item.advancePayload);
      } else if (item.kind === 'advance-with-checklist') {
        // 2026-07-16: the ONE kind whose two writes share a transaction. Passing
        // an 'advance' item plus a 'submit-checklist' item would run them in two
        // separate per-item transactions (see the note above) — leaving exactly
        // the orphaned-advance window this whole change exists to close.
        snapshot = await service.advanceWithChecklist(ctx, item.filterId, item.payload);
      } else {
        snapshot = await service.submitChecklist(ctx, item.filterId, item.payload);
      }
      results.push({ clientOpId: item.clientOpId, filterId: item.filterId, status: 'ok', snapshot });
    } catch (e: any) {
      results.push({
        clientOpId: item.clientOpId,
        filterId: item.filterId,
        status: 'failed',
        error: { code: e?.code ?? 'OP_FAILED', message: e?.message ?? 'Operation failed' },
      });
    }
  }
  return { results };
}
