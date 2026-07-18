/**
 * Filter Operations — advanceWithChecklist(): ONE transaction performing the
 * stage advance AND its post-stage checklist.
 *
 * Why this exists
 * ---------------
 * `advance()` persists the stage transition (checksummed `filter_events` row,
 * `FilterDetails.currentLifecycleState`, hash-chained `audit_trail` row) BEFORE
 * the operator has answered the mandatory post-stage checklist — the dialog is
 * only rendered once that write has committed, and closing it makes no API call
 * and writes no compensating record. At a TERMINAL stage nothing later forces
 * the operator back, so the system is left permanently asserting that a filter
 * entered its final cleaning stage with its required attestation absent — a
 * 21 CFR §11 record of an event whose mandatory attestation does not exist.
 * (At non-terminal stages the same orphan exists; it is merely invisible because
 * the NEXT advance throws CHECKLIST_PENDING and drags the operator back.)
 *
 * Reproduced by `__tests__/terminal-checklist-advance-persistence.test.ts`.
 * Design + decisions: `tasks/ATOMIC-ADVANCE-CHECKLIST-PLAN.md`.
 *
 * The fix is ordering: the client resolves the checklist for the TARGET stage
 * first, renders the dialog, writes nothing, and on submit dispatches this ONE
 * op. Cancel becomes a true no-op because nothing was ever written.
 *
 * Composition, not reimplementation
 * ---------------------------------
 * This is deliberately NOT a third copy of the advance/checklist rules. It calls
 * the SAME `prepareAdvance` / `prepareChecklist` (every gate, in the same order)
 * and the SAME `executeAdvanceTx` / `executeChecklistTx`, just inside one
 * `$transaction` so they commit or roll back together. `bulk-operate` cannot
 * serve this need: it runs a transaction PER ITEM, so advance+checklist as two
 * items is two transactions — the same orphan window.
 *
 * Completion composes for free: the advance half defers completion whenever a
 * checklist follows the target stage (`completesCycle=false`), and the checklist
 * half performs it (`shouldComplete=true`) — the identical handoff as the
 * two-request flow, now in one tx.
 *
 * PHASE 1 (this commit): the bare `/advance` endpoint still accepts an advance
 * with an unanswered post-stage checklist. That is intentional — offline queues
 * built before this shipped must be allowed to drain on replay. Phase 2 flips a
 * flag to reject bare advances once they have.
 */
import type { RequestContext } from '../../../types/context.js';
import { prisma } from '../../../lib/prisma.js';
import { AppError } from '../../../lib/errors.js';
import type { FilterOperationsService } from '../filter-operations.service.js';
import { prepareAdvance, executeAdvanceTx, notifyAdvanceInterlock } from './advance.js';
import { prepareChecklist, executeChecklistTx } from './submit-checklist.js';

/** @param data - Validated by Fastify JSON schema before reaching this method */
export async function advanceWithChecklistImpl(
  service: FilterOperationsService,
  ctx: RequestContext,
  filterId: string,
  data: any,
) {
  const targetState: string = data.targetState;

  // ── Prepare BOTH halves before anything is written ────────────────────────
  // Every gate of both ops runs here. A rejection (bad answers, stale tape,
  // unreachable stage, interlock 422, AHU gate) throws with zero writes.
  const advPrep = await prepareAdvance(service, ctx, filterId, data, {
    composedWithChecklist: true,
  });
  // Replay of an already-applied composed op: the advance half's event carries
  // the shared clientOpId. Atomicity guarantees the checklist half committed
  // with it, so finding one means the whole op is done.
  if (advPrep.kind === 'dedup') return service.getCurrentState(ctx, filterId);

  // The checklist belongs to the stage the advance is moving TO — the filter
  // has not moved yet, so loadLocalContext still reports the pre-advance stage.
  const clPrep = await prepareChecklist(service, ctx, filterId, data, {
    stateOverride: targetState,
    skipDedup: true, // deduped once, above, on the shared clientOpId
  });
  /* c8 ignore next */
  if (clPrep.kind === 'dedup') return service.getCurrentState(ctx, filterId); // unreachable: skipDedup

  // No checklist actually follows the target stage → this op is the wrong tool
  // and would write a CHECKLIST_COMPLETED event snapshotting nothing. Reject
  // rather than fabricate an attestation record for a checklist that does not
  // exist (21 CFR §11). The client uses bare /advance for these stages.
  if (clPrep.plan.profileCount === 0) {
    throw new AppError(
      400,
      'NO_CHECKLIST_AT_TARGET',
      `No active checklist follows ${targetState} in this cleaning profile. Use the plain advance operation for this stage.`,
    );
  }

  // ── ONE transaction: advance then checklist, both or neither ──────────────
  const createdApproval = await prisma.$transaction(async (tx) => {
    const approval = await executeAdvanceTx(tx, advPrep.plan);
    // Re-locks + re-verifies filter_details against targetState, which the
    // advance above set in THIS tx — doubles as an assertion the advance half
    // did what it claimed before the attestation is recorded against it.
    await executeChecklistTx(tx, clPrep.plan);
    return approval;
  });

  // Best-effort, post-commit: a notification failure must never roll back the
  // cycle write. Same call the bare advance makes.
  await notifyAdvanceInterlock(advPrep.plan, createdApproval);

  return service.getCurrentState(ctx, filterId);
}
