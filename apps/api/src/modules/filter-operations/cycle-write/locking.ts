/**
 * Filter Operations — shared row-lock helper for the 4 write methods.
 *
 * Phase 5b.4 introduced a SELECT FOR UPDATE on filter_details to serialize
 * advance/bypass/terminate against concurrent writes on the same filter.
 * Phase 8.7 audit (AUDIT-2026-05-02-concurrent-operator.md) added the
 * CYCLE_CHANGED recheck to the same lock — every cycle-mutating write now
 * uses an identical shape:
 *
 *   1. SELECT current_lifecycle_state, current_cycle_id
 *      FROM filter_details WHERE ... FOR UPDATE
 *   2. If lockedFD.current_lifecycle_state !== expectedState -> 409 STATE_CHANGED
 *   3. If lockedFD.current_cycle_id      !== expectedCycleId -> 409 CYCLE_CHANGED
 *
 * Extracted as a shared helper so the writers stay in lockstep when the lock
 * semantics get audited again. submitChecklist ALSO uses this helper (race fix
 * 2026-07-04) and keeps its ALREADY_SUBMITTED filter_event guard on top of the
 * (state, cycle) recheck.
 */
import type { Prisma } from '@prisma/client';
import { AppError } from '../../../lib/errors.js';

type TxClient = Prisma.TransactionClient;

/**
 * Acquire a row lock on filter_details + verify the filter is still in the
 * expected (state, cycle) tuple. Throws 409 STATE_CHANGED or CYCLE_CHANGED
 * on mismatch. Caller stays inside the same `prisma.$transaction` boundary.
 */
export async function lockAndVerifyFilterState(
  tx: TxClient,
  filterId: string,
  expectedState: string | null,
  expectedCycleId: string | null,
): Promise<void> {
  const lockedRows = await tx.$queryRaw<Array<{ current_lifecycle_state: string | null; current_cycle_id: string | null }>>`
    SELECT current_lifecycle_state, current_cycle_id
    FROM filter_details
    WHERE asset_instance_id = ${filterId}::uuid
    FOR UPDATE
  `;
  const lockedFD = lockedRows[0];
  if (lockedFD?.current_lifecycle_state !== expectedState) {
    throw new AppError(409, 'STATE_CHANGED', 'Filter state was modified by another user. Please refresh and try again.');
  }
  if (lockedFD?.current_cycle_id !== expectedCycleId) {
    throw new AppError(409, 'CYCLE_CHANGED', 'Cleaning cycle changed. Please refresh and try again.');
  }
}
