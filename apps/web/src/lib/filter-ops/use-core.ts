/**
 * useFilterOperationsCore — Days 1–3 of the D1/D2/D4 dialog-state refactor.
 *
 * See `tasks/D1-D2-D4-DIALOG-STATE-REFACTOR-ENGAGEMENT.md` for the full plan.
 *
 * Day 1 scope (landed 2026-05-17, commit `98b6b6c`): smallest vertical proving
 * the architecture — `advance` + `submitChecklist`. Both wrap `executeOrQueue`
 * and dispatch dialog transitions through `reduceDialogState`. After every
 * cycle write, the resolved action tape decides whether the checklist dialog
 * should open next; dispatch is the SOLE setter so the imperative
 * setChecklistDialog clobber-races from the page files cannot recur.
 *
 * Day 3 scope (this file): full handler surface required for both pages —
 * `advance` (extended args), `startAndAdvance`, `submitChecklist` (extended
 * with offline cache-row clear). Pages are migrated onto this hook in Days
 * 3b–3f (mobile) and Day 4 (desktop). The hook owns:
 *   - executeOrQueue invocation with the full payload
 *   - on-queue cache-row recompute via `recomputeAndCacheFilterState`
 *   - post-op checklist dialog resolution + dispatch (single decision site)
 *   - batch continuation queue walking (D1 fix)
 *
 * IMPORTANT (deep-review fix D6 contract): handlers never swallow REAUTH
 * errors. The wrapped `executeOrQueue` will throw raw REAUTH_REQUIRED /
 * REAUTH_FAILED (api-client.ts:67); the caller's reauth.execute() wrapper
 * is responsible for displaying the dialog. This hook treats REAUTH as
 * "not my problem — propagate".
 */
import { useReducer, useState, useCallback } from 'react';
import { useOffline } from '../../hooks/use-offline';
import {
  reduceDialogState,
  type DialogState,
  type DialogEvent,
  type DeferredAdvance,
} from './dialog-state';
import { resolvePendingChecklistDialog, resolveChecklistForTargetStage } from './resolve-pending-checklist';
import { findNextPendingChecklist, type PendingChecklistBatchItem } from './next-pending-checklist';
import { getCurrentActions } from '@/lib/action-tape';
import { recomputeAndCacheFilterState, appendChecklistCompletion, cacheServerStateResponse } from '@/lib/offline-cache';
import { cacheData, getCachedData, clearOfflineCycleId, OFFLINE_TTL_MS } from '@/lib/offline-store';

/**
 * Advance args — accepts the full payload the page constructs.
 *
 * Maps 1:1 onto `executeOrQueue('advance', ...)`'s payload (which is then
 * forwarded to `/api/filters/:id/advance` online or queued offline). All
 * fields except `filterId` / `filterName` / `targetState` are optional, the
 * hook strips undefined keys before sending so the server schema validator
 * sees a clean payload.
 *
 * `equipmentGroupId` + `instrumentReadings` are the equipment-dialog payload
 * for WASH_IN / DRY_OUT / STORAGE_IN. `dryerAction` + `dryerDurationMinutes`
 * are the DRY_IN payload (SET_DURATION on the dryer dialog, SUBMIT_READINGS
 * on the equipment dialog when DRY_IN's temp is recorded).
 *
 * `batchRemainder` is the desktop multi-scan continuation queue — when set
 * and this filter's advance produces no checklist gate, the hook walks the
 * remainder looking for one. D1 batch fix.
 */
export interface AdvanceArgs {
  filterId: string;
  filterName: string;
  targetState: string;
  cleaningAreaId?: string | null;
  equipmentGroupId?: string;
  instrumentReadings?: Record<string, number>;
  dryerAction?: 'SET_DURATION' | 'SUBMIT_READINGS';
  dryerDurationMinutes?: number;
  remarks?: string;
  batchRemainder?: PendingChecklistBatchItem[];
  /** Reauth password forwarded to executeOrQueue's online path. Pages wrap
   *  this call in reauth.execute() and forward the password the operator
   *  enters. Never persisted to IDB. */
  password?: string;
  /**
   * 2026-05-26: skip the post-advance checklist dispatch. Mirrors the same
   * flag on `StartAndAdvanceArgs`. Set this on filter-2..N iterations of a
   * multi-filter loop where filter-1's advance already opened the dialog —
   * otherwise `resolveAndDispatchChecklist` tries to open a second dialog
   * from `awaiting_checklist` and trips `assertOpenable`. The page is
   * responsible for stashing the remaining filters so the dialog cascade
   * handles them on submit.
   */
  skipChecklistDispatch?: boolean;
  /**
   * Opt OUT of the dialog-first deferral (2026-07-16) for this call.
   *
   * Defaults to deferring. Set `false` when the CALLER knows about follow-on
   * work the hook can't see — e.g. the equipment handler's batch-continuation
   * loop, which must run after this advance. Deferring there would park the
   * advance on a dialog and return before the rest of the batch is processed.
   * Those calls keep the pre-2026-07-16 advance-then-dialog behaviour.
   */
  allowDefer?: boolean;
}

/**
 * Start-cycle compound op args.
 *
 * The cycle-start flow is a compound `executeOrQueue('start-and-advance', ...)`
 * call: the server first POSTs start-cycle (reauth-gated for ADMIN role),
 * then POSTs advance on the same filter. Offline, both halves enqueue
 * atomically. The hook calls `recomputeAndCacheFilterState(...,
 * cycleStarted=true)` when queued so the cache row reflects the new
 * lifecycle state + open cycle.
 */
export interface StartAndAdvanceArgs {
  filterId: string;
  filterName: string;
  cyclePayload: Record<string, any>;
  advancePayload: Record<string, any>;
  targetState: string;
  cleaningAreaId?: string | null;
  password?: string;
  batchRemainder?: PendingChecklistBatchItem[];
  /**
   * 2026-05-25 — Tablet repro on Block FD offline: the FD profile has a
   * WASH_IN → CHECKLIST → DRY_IN gate, so every just-started cycle has a
   * pending checklist immediately. With two filters batched, filter 1's
   * `resolveAndDispatchChecklist` dispatched `open_checklist` (state →
   * `awaiting_checklist`), then the explicit batch-continuation loop in
   * `handleEquipSubmit` called `startAndAdvance` for filter 2, which
   * tried to dispatch another `open_checklist` from `awaiting_checklist`
   * and tripped the state-machine guard in `dialog-state.ts:190-197`.
   *
   * Set this to `true` on every iteration AFTER the first when running a
   * batched cycle-start loop. The first call should still pass
   * `batchRemainder` so the dialog cascade (filter 1's checklist → filter
   * 2's checklist) walks through `remainingBatch` cleanly when the
   * operator submits each one.
   */
  skipChecklistDispatch?: boolean;
  /**
   * Opt OUT of the dialog-first deferral (2026-07-16). Same contract as
   * `AdvanceArgs.allowDefer` — set `false` when the caller has follow-on work
   * (e.g. a batch-continuation loop) that deferring would skip by returning
   * early.
   */
  allowDefer?: boolean;
}

export interface SubmitChecklistArgs {
  filterId: string;
  filterName: string;
  answers: Record<string, unknown>;
  expectedProfileVersions?: Record<string, number>;
  password?: string;
  /**
   * An advance parked for THIS filter that must commit atomically with these
   * answers (2026-07-16).
   *
   * Single-filter callers don't pass this — the hook reads the intent off the
   * open dialog. BATCH callers must: one dialog covers N filters, so members
   * 2..N have no dialog state of their own, and without this they would fall
   * back to a bare `submit-checklist` against a stage their filter never
   * entered. Takes precedence over the dialog lookup.
   */
  deferredAdvance?: DeferredAdvance;
  /**
   * Operator's runtime AHU filter-set choice (SET_A / SET_B / ALL). Rides in the
   * submit body so the server INTERLOCK gate scopes to the same roster the
   * pre-popup chooser showed. Omitted = ALL (legacy behavior).
   */
  filterSet?: 'ALL' | 'SET_A' | 'SET_B';
}

/**
 * `deferred: true` — NOTHING was written. The target stage has a mandatory
 * checklist, so the dialog was opened first and the advance is parked on it;
 * it commits (atomically, with the answers) only when the operator submits.
 *
 * Callers MUST NOT report success, log a recent-op, or show "(queued)" on a
 * deferred outcome — nothing has happened yet. The checklist submit handler
 * reports the combined result. `executed` is false here, which without this
 * flag is indistinguishable from "queued offline".
 */
export interface AdvanceOutcome {
  executed: boolean;
  result?: any;
  dialogOpened: boolean;
  deferred?: boolean;
}

export interface UseFilterOperationsCoreResult {
  dialogState: DialogState;
  dispatch: (event: DialogEvent) => void;
  advance: (args: AdvanceArgs) => Promise<AdvanceOutcome>;
  startAndAdvance: (args: StartAndAdvanceArgs) => Promise<AdvanceOutcome>;
  submitChecklist: (args: SubmitChecklistArgs) => Promise<{ executed: boolean }>;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
}

// Errors that MUST propagate to the page-level catch so the page can handle
// them with structured UI (reauth dialog, block-change modal, etc.).
// BLOCK_CHANGE_REQUIRED: page catches it and dispatches open_block_change.
// REAUTH_REQUIRED / REAUTH_FAILED: reauth.execute() wrapper needs to surface
//   the inline "Incorrect password" message and let the operator retry.
// OFFLINE_CACHE_RECOMPUTE_FAILED: page-level error state for the operator.
const PROPAGATED_ERROR_CODES = new Set([
  'REAUTH_REQUIRED',
  'REAUTH_FAILED',
  'OFFLINE_CACHE_RECOMPUTE_FAILED',
  'BLOCK_CHANGE_REQUIRED',
]);

function isReauthOrRecompute(e: unknown): boolean {
  const err = e as { error?: string; code?: string };
  const code = err?.error ?? err?.code;
  return typeof code === 'string' && PROPAGATED_ERROR_CODES.has(code);
}

/**
 * Build the advance payload that executeOrQueue forwards to /advance. Drops
 * undefined keys so the server schema validator doesn't see e.g.
 * `dryerAction: undefined`. The default remarks string matches what
 * mobile-operations.tsx and filter-operations.tsx emit today.
 */
function buildAdvancePayload(args: AdvanceArgs): Record<string, any> {
  const payload: Record<string, any> = {
    targetState: args.targetState,
  };
  if (args.cleaningAreaId !== undefined) payload.cleaningAreaId = args.cleaningAreaId;
  if (args.equipmentGroupId !== undefined) payload.equipmentGroupId = args.equipmentGroupId;
  if (args.instrumentReadings !== undefined) payload.instrumentReadings = args.instrumentReadings;
  if (args.dryerAction !== undefined) payload.dryerAction = args.dryerAction;
  if (args.dryerDurationMinutes !== undefined) payload.dryerDurationMinutes = args.dryerDurationMinutes;
  payload.remarks = args.remarks ?? `${args.targetState} - ${args.filterName}`;
  return payload;
}

/**
 * Resolve the post-advance checklist dialog and dispatch it. Centralizes the
 * decision: this filter has a gate → open dialog with batchRemainder; this
 * filter is clean but batch has more → walk the queue; nothing pending →
 * stay idle.
 *
 * Returns the dispatched event (or null if no dialog opened) so callers can
 * differentiate "gate opened" from "advance completed cleanly".
 */
async function resolveAndDispatchChecklist(
  filterId: string,
  filterName: string,
  serverActions: unknown[] | null | undefined,
  batchRemainder: PendingChecklistBatchItem[] | undefined,
  dispatch: (event: DialogEvent) => void,
): Promise<'opened' | 'opened_from_batch' | 'none'> {
  const dialogChecklists = await resolvePendingChecklistDialog(
    filterId,
    serverActions as any,
  );
  if (dialogChecklists) {
    dispatch({
      type: 'open_checklist',
      filterId,
      filterName,
      checklists: dialogChecklists,
      remainingBatch: batchRemainder,
    });
    return 'opened';
  }
  if (batchRemainder && batchRemainder.length > 0) {
    const next = await findNextPendingChecklist(
      batchRemainder,
      resolvePendingChecklistDialog,
    );
    if (next) {
      dispatch({
        type: 'open_checklist',
        filterId: next.item.filterId,
        filterName: next.item.filterName,
        checklists: next.checklists,
        remainingBatch: next.remaining,
      });
      return 'opened_from_batch';
    }
  }
  return 'none';
}

export function useFilterOperationsCore(): UseFilterOperationsCoreResult {
  const { executeOrQueue, online } = useOffline();
  const [dialogState, dispatch] = useReducer(reduceDialogState, { kind: 'none' });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  /**
   * advance — single-filter advance with full payload support.
   *
   * Online: executeOrQueue POSTs /advance, returns `result.actions[]` when
   * the server emits the tape. The resolver consumes that to decide the
   * dialog.
   *
   * Offline: executeOrQueue queues the op and we MUST rewrite the cache row
   * via recomputeAndCacheFilterState — without that the next gate decision
   * reads stale `nextAllowedStages` and the operator advances past a
   * required checklist (21 CFR violation). The resolver then reads the
   * locally-recomputed tape.
   *
   * Throws on REAUTH and OFFLINE_CACHE_RECOMPUTE_FAILED so the page's
   * reauth.execute() / catch block can present a structured error.
   */
  const advance = useCallback(
    async (args: AdvanceArgs): Promise<AdvanceOutcome> => {
      setIsLoading(true);
      setError(null);
      try {
        const payload = buildAdvancePayload(args);

        // ── Dialog-first: resolve the TARGET stage's checklist before writing ──
        // The defect this fixes: the advance below commits, THEN the dialog
        // renders, and Close is a client-only no-op — stranding a §11 record of
        // a stage entry whose mandatory checklist was never answered.
        //
        // Single-filter only. Batch continuations (batchRemainder /
        // skipChecklistDispatch) drive their own dialog cascade and would trip
        // assertOpenable here, so they keep today's path — see
        // tasks/ATOMIC-ADVANCE-CHECKLIST-PLAN.md.
        //
        // Works OFFLINE too (2026-07-16): the resolve is cache-first and the
        // combined op queues as ONE entry, replaying via the same endpoint. If
        // the checklist can't be resolved from cache offline, `pending` is empty
        // and we fall through to the legacy path — never a silent skip.
        //
        // `!args.dryerAction` is load-bearing: SET_DURATION / SUBMIT_READINGS
        // are dryer-in-place ops (DRY_IN → DRY_IN, `isDryerInPlace` server-side).
        // They do NOT enter a stage, so the checklist that gates leaving DRY_IN
        // must not pop when the operator merely starts the dryer.
        const canDefer =
          args.allowDefer !== false
          && !args.dryerAction
          && !args.skipChecklistDispatch
          && !(args.batchRemainder && args.batchRemainder.length > 0);
        if (canDefer) {
          const pending = await resolveChecklistForTargetStage(
            args.filterId,
            args.targetState,
            online,
          );
          if (pending.length > 0) {
            // Nothing is written. The intent rides on the dialog; submit sends
            // ONE advance-with-checklist, Close discards it with the dialog.
            dispatch({
              type: 'open_checklist',
              filterId: args.filterId,
              filterName: args.filterName,
              checklists: pending,
              deferredAdvance: {
                targetState: args.targetState,
                payload,
                cleaningAreaId: args.cleaningAreaId ?? null,
              },
            });
            return { executed: false, deferred: true, dialogOpened: true };
          }
          // pending === [] means EITHER no checklist here (advance plainly) OR
          // it couldn't be resolved. Either way fall through to the path below,
          // which is unchanged — the server re-validates every write regardless.
        }

        const { executed, result } = await executeOrQueue(
          'advance',
          args.filterId,
          args.filterName,
          payload,
          args.targetState,
          args.password,
        );

        if (!executed) {
          await recomputeAndCacheFilterState(
            args.filterId,
            args.targetState,
            false,
            args.cleaningAreaId ?? null,
          );
        }

        // 2026-05-26: return dialogOpened so callers can distinguish "checklist
        // dialog auto-opened" from "no gate, equipment dialog still open". A
        // stale-closure read of dialogState.kind in handleEquipSubmit was
        // dispatching close immediately AFTER open_checklist, killing the
        // checklist dialog on L1-style profiles where every stage has a gate.
        //
        // skipChecklistDispatch: multi-filter DRY_IN SET_DURATION loop. The
        // first filter's resolveAndDispatchChecklist opens the dialog; every
        // subsequent filter MUST skip dispatch or it trips assertOpenable
        // (dialog already in awaiting_checklist). Same pattern as
        // startAndAdvance's batch-continuation iterations.
        let dialogOpened = false;
        if (!args.skipChecklistDispatch) {
          const dispatchOutcome = await resolveAndDispatchChecklist(
            args.filterId,
            args.filterName,
            executed ? (result as { actions?: unknown[] } | undefined)?.actions ?? null : null,
            args.batchRemainder,
            dispatch,
          );
          dialogOpened = dispatchOutcome === 'opened' || dispatchOutcome === 'opened_from_batch';
        }

        return { executed, result, dialogOpened, deferred: false };
      } catch (e: unknown) {
        if (isReauthOrRecompute(e)) throw e;
        const err = e as { message?: string };
        setError(err?.message ?? 'Advance failed');
        // Re-throw (don't return { executed: false }) — that pre-fix shape
        // was indistinguishable from a genuinely queued offline op, and the
        // caller (mobile/desktop submit handlers) painted the result with a
        // misleading "(queued)" success message even when the server had
        // rejected the request (e.g. 400 JUSTIFICATION_REQUIRED). Bubbling
        // lets reauth.execute's onError handler / try-catch surface a real
        // error toast. Bug reported 2026-05-25 (wash-in justification path).
        throw e;
      } finally {
        setIsLoading(false);
      }
    },
    [executeOrQueue],
  );

  /**
   * startAndAdvance — compound start-cycle + advance.
   *
   * The cycle-start flow used by the reason / equipment / PM-auto branches.
   * executeOrQueue('start-and-advance') handles both halves: online it posts
   * /start-cycle then /advance with the fresh tapeVersion; offline it queues
   * both operations atomically.
   *
   * On queue, recomputeAndCacheFilterState(...,cycleStarted=true) creates
   * the cycle stub on the cache row so subsequent offline scans see a
   * cycle-in-progress.
   */
  const startAndAdvance = useCallback(
    async (args: StartAndAdvanceArgs): Promise<AdvanceOutcome> => {
      setIsLoading(true);
      setError(null);
      try {
        // Dialog-first for the cycle-START flow (2026-07-16). Same defect as the
        // mid-cycle advance: start-and-advance committed the cycle AND the entry
        // into the first stage before its mandatory checklist rendered, so Close
        // stranded a stage entry with no attestation. Resolve first; if a
        // checklist fires, write NOTHING and park the whole compound op.
        //
        // On submit this dispatches `start-and-advance-with-checklist`, whose
        // ADVANCE half is atomic with the checklist. The start remains a separate
        // request (as it already is) — a started cycle that never entered a stage
        // records no attestation-less transition, so it is not this defect.
        const canDefer =
          args.allowDefer !== false
          && !args.skipChecklistDispatch
          && !(args.batchRemainder && args.batchRemainder.length > 0);
        if (canDefer) {
          const pending = await resolveChecklistForTargetStage(
            args.filterId,
            args.targetState,
            online,
          );
          if (pending.length > 0) {
            dispatch({
              type: 'open_checklist',
              filterId: args.filterId,
              filterName: args.filterName,
              checklists: pending,
              deferredAdvance: {
                targetState: args.targetState,
                payload: args.advancePayload,
                cleaningAreaId: args.cleaningAreaId ?? null,
                // Presence of cyclePayload is what makes the submit dispatch the
                // compound start-and-advance-with-checklist rather than the
                // mid-cycle advance-with-checklist.
                cyclePayload: args.cyclePayload,
              },
            });
            return { executed: false, deferred: true, dialogOpened: true };
          }
        }

        const { executed, result } = await executeOrQueue(
          'start-and-advance',
          args.filterId,
          args.filterName,
          { cyclePayload: args.cyclePayload, advancePayload: args.advancePayload } as any,
          args.targetState,
          args.password,
        );

        if (!executed) {
          await recomputeAndCacheFilterState(
            args.filterId,
            args.targetState,
            true,
            args.cleaningAreaId ?? null,
          );
        }

        // skipChecklistDispatch: batch continuation iterations (filter 2..N
        // in handleEquipSubmit) MUST skip this; the first iteration's
        // dispatch already carries `remainingBatch` and the dialog cascade
        // handles the rest.
        let dialogOpened = false;
        if (!args.skipChecklistDispatch) {
          const dispatchOutcome = await resolveAndDispatchChecklist(
            args.filterId,
            args.filterName,
            executed ? (result as { actions?: unknown[] } | undefined)?.actions ?? null : null,
            args.batchRemainder,
            dispatch,
          );
          dialogOpened = dispatchOutcome === 'opened' || dispatchOutcome === 'opened_from_batch';
        }

        return { executed, result, dialogOpened, deferred: false };
      } catch (e: unknown) {
        if (isReauthOrRecompute(e)) throw e;
        const err = e as { message?: string };
        setError(err?.message ?? 'Start-and-advance failed');
        // See `advance` above — re-throw so the caller can surface the real
        // error (was the wash-in JUSTIFICATION_REQUIRED bug reported 5/25).
        throw e;
      } finally {
        setIsLoading(false);
      }
    },
    [executeOrQueue],
  );

  /**
   * submitChecklist — submit answers, walk batch continuation queue.
   *
   * Offline-parity contract: when queued, we MUST clear `pendingChecklist[]`
   * on the cache row and re-derive `nextAllowedStages` + `actions[]` from
   * the tape. Without this, the next gate decision still sees the pending
   * checklist and refuses to advance. See mobile-operations.tsx:1397-1415
   * (pre-migration) for the legacy inline implementation this replaces.
   *
   * The D1 batch fix: pre-fix the loop took only the first remainingBatch
   * item and dropped subsequent filters silently. We pop the next pending
   * checklist by walking the queue via findNextPendingChecklist, which
   * skips filters with no checklist gate (those advance through cleanly).
   */
  const submitChecklist = useCallback(
    async (args: SubmitChecklistArgs): Promise<{ executed: boolean }> => {
      setIsLoading(true);
      setError(null);

      // Snapshot the profiles whose completion we'll log post-submit. Read
      // from dialogState BEFORE we dispatch close (close wipes the data).
      // afterStage + cycleId come from the cached filter-state row — the
      // hook doesn't have them in args, and the page would have to construct
      // them itself otherwise. Reading from cache keeps the contract minimal.
      const profilesAwaitingLog =
        dialogState.kind === 'awaiting_checklist'
          ? (dialogState.checklists as Array<{ checklistProfileId: string }>)
          : [];

      // An advance parked by the dialog-first flow: it has NOT been written.
      // Submit it together with these answers as ONE atomic op instead of a
      // bare submit-checklist against a stage the filter never entered.
      //
      // Explicit arg wins — batch callers pass each member's own parked advance
      // because ONE dialog covers N filters and members 2..N have no dialog
      // state. Otherwise read it off the open dialog. `dialogState` is in this
      // callback's deps (and drives remainingBatch below), so this is the live
      // value, not a stale closure.
      const deferred =
        args.deferredAdvance
        ?? (dialogState.kind === 'awaiting_checklist' && dialogState.filterId === args.filterId
          ? dialogState.deferredAdvance
          : undefined);

      try {
        // The combined checklist body, shared by both deferred shapes.
        const combinedAdvanceBody = deferred
          ? {
              ...deferred.payload,
              answers: args.answers,
              expectedProfileVersions: args.expectedProfileVersions ?? {},
              ...(args.filterSet ? { filterSet: args.filterSet } : {}),
            }
          : null;

        const { executed, result } = deferred?.cyclePayload
          // Cycle-START flow: the cycle isn't started either. Compound op —
          // start, then the ATOMIC advance+checklist.
          ? await executeOrQueue(
              'start-and-advance-with-checklist',
              args.filterId,
              args.filterName,
              { cyclePayload: deferred.cyclePayload, advancePayload: combinedAdvanceBody } as any,
              deferred.targetState,
              args.password,
            )
          : deferred
          ? await executeOrQueue(
              'advance-with-checklist',
              args.filterId,
              args.filterName,
              combinedAdvanceBody!,
              deferred.targetState, // optimistic local state = the stage we're entering
              args.password,
            )
          : await executeOrQueue(
              'submit-checklist',
              args.filterId,
              args.filterName,
              {
                answers: args.answers,
                expectedProfileVersions: args.expectedProfileVersions ?? {},
                ...(args.filterSet ? { filterSet: args.filterSet } : {}),
              },
              undefined,
              args.password,
            );

        // The combined op moved the filter to targetState in the same tx. The
        // cache row still describes the PRE-advance stage, so reconcile it
        // before the shared post-submit bookkeeping below reads it.
        //   online  → cache the server's own snapshot (authoritative; the op
        //             returns getCurrentState).
        //   queued  → the network dropped between dialog and submit; recompute
        //             locally for the new stage. The block below then clears the
        //             pendingChecklist this recompute re-derives for targetState
        //             (we just answered it) and re-derives the tape.
        if (deferred) {
          if (executed && result) {
            await cacheServerStateResponse(args.filterId, result);
          } else {
            await recomputeAndCacheFilterState(
              args.filterId,
              deferred.targetState,
              // cycleStarted: the cycle-START flow queues its start too, so the
              // cache row needs the cycle stub — otherwise the next offline scan
              // sees no cycle in progress and offers to start a second one.
              !!deferred.cyclePayload,
              deferred.cleaningAreaId ?? null,
            );
          }
        }

        // Explicit checklist-completion log — Tier 1 of local-context.ts
        // synthesizeEvents (Day 2 helper). Populated on EVERY submit (online
        // or offline). Idempotent on (cycleId, checklistProfileId, afterStage)
        // so re-firing on retry is safe. Without this the synthesizer falls
        // through to Tier 2 (the legacy pendingChecklist === [] implicit
        // signal), which Day 5 wants to retire.
        try {
          const cs = await getCachedData<{
            currentState?: string | null;
            currentCycle?: { id?: string | null } | null;
          }>(`filter-state-${args.filterId}`);
          // Deferred: the checklist was answered after the stage we just entered.
          // Reading the cache row instead would be wrong in both directions — it
          // holds the PRE-advance stage when queued, and (for a terminal
          // checklist) the post-completion CLEANING_CYCLE_COMPLETED / null once
          // the server snapshot lands.
          const afterStage = deferred?.targetState ?? cs?.currentState ?? null;
          const cycleId = cs?.currentCycle?.id ?? null;
          if (afterStage) {
            const completedAt = new Date().toISOString();
            for (const p of profilesAwaitingLog) {
              if (!p.checklistProfileId) continue;
              await appendChecklistCompletion(args.filterId, {
                checklistProfileId: p.checklistProfileId,
                afterStage,
                completedAt,
                cycleId,
              });
            }
          }
        } catch {
          /* idempotent log is best-effort — Tier 2 fallback remains for
             legacy cache rows that pre-date this wiring */
        }

        // 2026-05-20: cache rewrite runs for BOTH online + offline submits.
        // Pre-fix: this branch was `if (!executed)`, so an online checklist
        // submit left the cached `actions` tape with SUBMIT_CHECKLIST still
        // at the head. The batch-DRY_IN replay (handleSubmitQueue retrying
        // after the dialog closes) re-read that stale tape, saw the gate
        // still pending, and re-opened the same checklist dialog — the
        // operator submitted, the dialog reopened, looped forever.
        //
        // The legacy mobile-operations.tsx flow didn't care because it
        // didn't have an auto-replay — the operator manually re-scanned
        // after checklist, which triggered a fresh /current-state fetch.
        // The replay path needs the cache to reflect server reality.
        try {
          const cs = await getCachedData<any>(`filter-state-${args.filterId}`) ?? {};
          const clearedRow = { ...cs, pendingChecklist: [] };
          await cacheData(`filter-state-${args.filterId}`, clearedRow, OFFLINE_TTL_MS);
          const tape = await getCurrentActions(args.filterId, null);
          // A terminal checklist (the last gate before END) completes the cycle.
          // The recomputed tape carries COMPLETE_CYCLE in that case (the executor
          // emits it when the stage leadsToEnd with no reachable stages). Mirror
          // the advance path's cycleComplete handling: clear the cycle so the
          // next scan starts a FRESH cycle instead of tripping
          // validateOfflineGate's "in-cycle but no next stage cached — re-sync"
          // (the back-to-back offline-cycle bug — 2026-07-10). Without this the
          // filter stayed parked at the terminal stage, in-cycle, until an
          // online re-sync re-fetched the server-completed state.
          const willComplete = tape.some((a) => a.type === 'COMPLETE_CYCLE');
          if (willComplete) {
            await cacheData(
              `filter-state-${args.filterId}`,
              {
                ...clearedRow,
                currentState: null,
                currentCycle: null,
                nextAllowedStages: [],
                actions: [],
                checklistCompletions: [],
              },
              OFFLINE_TTL_MS,
            );
            await clearOfflineCycleId(args.filterId);
          } else {
            const newAllowed = tape
              .filter((a) => a.type === 'ADVANCE_TO_STAGE' || a.type === 'SET_DRYER_DURATION')
              .map((a) => (a as { params: { targetState: string } }).params.targetState);
            await cacheData(
              `filter-state-${args.filterId}`,
              { ...clearedRow, nextAllowedStages: newAllowed, actions: tape },
              OFFLINE_TTL_MS,
            );
          }
        } catch {
          /* IDB failure non-fatal — the next /current-state fetch will
             repopulate. Without this swallow, a transient IDB hiccup would
             trip OFFLINE_CACHE_RECOMPUTE_FAILED and surface a scary error
             for a flow that's already succeeded server-side. */
        }

        const remainingBatch =
          dialogState.kind === 'awaiting_checklist'
            ? (dialogState.remainingBatch ?? [])
            : [];

        if (remainingBatch.length === 0) {
          dispatch({ type: 'close' });
        } else {
          const next = await findNextPendingChecklist(
            remainingBatch,
            resolvePendingChecklistDialog,
          );
          if (next) {
            dispatch({ type: 'close' });
            dispatch({
              type: 'open_checklist',
              filterId: next.item.filterId,
              filterName: next.item.filterName,
              checklists: next.checklists,
              remainingBatch: next.remaining,
            });
          } else {
            dispatch({ type: 'close' });
          }
        }

        return { executed };
      } catch (e: unknown) {
        if (isReauthOrRecompute(e)) throw e;
        const err = e as { message?: string };
        setError(err?.message ?? 'Checklist submission failed');
        // See `advance` above — re-throw so the caller can surface the real
        // error instead of mistaking server rejection for a queued op.
        throw e;
      } finally {
        setIsLoading(false);
      }
    },
    [executeOrQueue, dialogState],
  );

  return {
    dialogState,
    dispatch,
    advance,
    startAndAdvance,
    submitChecklist,
    isLoading,
    error,
    clearError,
  };
}

export type { DialogState, DialogEvent } from './dialog-state';
