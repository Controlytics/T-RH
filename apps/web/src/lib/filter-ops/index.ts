/**
 * `apps/web/src/lib/filter-ops/` barrel — Phase 8.7 Wave-5 split.
 *
 * Shared modules between the desktop + tablet filter-operations pages
 * (`routes/filter-management/filter-operations.tsx` and
 *  `routes/mobile/mobile-operations.tsx`). See individual file headers for
 * scope; the per-page route files import from this barrel.
 *
 * Drift-prevention rule (per `feedback_unified_tablet_web.md`): if a future
 * bug fix needs to land in BOTH pages, it goes in here, not in the route
 * files. Phase 8 spent multiple sessions chasing checklist-not-appearing /
 * wrong-stage / stale-cache bugs that all came from divergent inline copies
 * of these functions.
 */

export { validateOfflineGate, firstStagesFromGraph } from './validate-offline-gate';

export { resolvePendingChecklistDialog, resolveChecklistForTargetStage } from './resolve-pending-checklist';

export { findNextPendingChecklist } from './next-pending-checklist';
export type {
  PendingChecklistBatchItem,
} from './next-pending-checklist';

export {
  useNowTick,
  buildTempOptionsSnapped,
  buildTempOptionsLinear,
  findDryerTempInstrument,
  projectDryerCountdown,
} from './use-dryer-countdown';

export type { PendingChecklist } from './types';
