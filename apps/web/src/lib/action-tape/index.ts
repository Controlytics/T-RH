/**
 * Action-tape FE barrel — Phase 8.6 part 2.
 *
 * Centralizes the FE entry-points for consuming the decision-tape. The tape
 * is the ordered list of permitted actions for a filter at its current cycle
 * state, computed by the shared executor (`@digilog/shared`).
 *
 * ── Resolution ladder ────────────────────────────────────────────────────
 *
 * `getCurrentActions()` resolves the tape in three tiers:
 *
 *   1. Server-provided `actions[]` from the `/current-state` response. Only
 *      populated when `TAPE_PARALLEL=true` on the server (off by default in
 *      dev). Treated as authoritative when present.
 *
 *   2. Local computation via `executor.computeNextActions(ctx)` over the
 *      `LocalContext` projected by `loadLocalContextFromCache()`. This is
 *      the path that fires in dev today and offline always. The same pure
 *      function the server tape generator runs — no client/server drift.
 *
 *   3. Empty tape (`[]`). Only when context is missing entirely (filter not
 *      cached, no profile resolvable). Callers fall back to the legacy
 *      `nextAllowedStages` / `pendingChecklist` cache fields when this hits.
 *
 * `actionsForStage()` filters a tape by stage key, with an action-kind aware
 * matcher (see jsdoc on the function).
 */
import { computeNextActions, type Action } from '@digilog/shared';
import { loadLocalContextFromCache } from '@/lib/local-context';

export type { Action } from '@digilog/shared';

/**
 * Filter a tape down to actions that target a given stage.
 *
 * Action-kind matching rules (mirror the server's `computeNextActions`
 * emission rules):
 *
 *   - `ADVANCE_TO_STAGE`, `BYPASS_STAGE`, `SET_DRYER_DURATION` →
 *     `params.targetState === stage`
 *   - `SUBMIT_CHECKLIST` → `params.afterStage === stage`
 *   - `SUBMIT_DRYER_READINGS` → only when `stage === 'DRY_IN'`
 *   - `TERMINATE_CYCLE`, `COMPLETE_CYCLE` → not stage-scoped; excluded.
 *     Callers requesting these surface them via direct `actions.find()`.
 *
 * Returns a new array; does not mutate the input.
 */
export function actionsForStage(stage: string, actions: Action[]): Action[] {
  return actions.filter((a) => {
    switch (a.type) {
      case 'ADVANCE_TO_STAGE':
      case 'BYPASS_STAGE':
        return a.params.targetState === stage;
      case 'SET_DRYER_DURATION':
        return a.params.targetState === stage;
      case 'SUBMIT_CHECKLIST':
        return a.params.afterStage === stage;
      case 'SUBMIT_DRYER_READINGS':
        return stage === 'DRY_IN';
      case 'TERMINATE_CYCLE':
      case 'COMPLETE_CYCLE':
        return false;
      default:
        return false;
    }
  });
}

/**
 * Resolve the current action tape for a filter.
 *
 *   - When `serverActions` is non-empty, return it. The server emitted a
 *     fresh tape (TAPE_PARALLEL on); FE trusts it.
 *   - Otherwise project a `LocalContext` from IDB caches and run
 *     `computeNextActions(ctx)` — the same pure function the server runs.
 *
 * The local-compute path is the production path until 8.7 flips
 * `TAPE_PARALLEL` permanently on. Callers can use
 * `actionsForStage(stage, await getCurrentActions(...))` as the gate test
 * everywhere.
 */
export async function getCurrentActions(
  filterId: string,
  serverActions?: Action[] | null,
): Promise<Action[]> {
  if (Array.isArray(serverActions) && serverActions.length > 0) {
    return serverActions;
  }
  const ctx = await loadLocalContextFromCache(filterId);
  const tape = computeNextActions(ctx);
  return tape.actions;
}

/** True if the tape contains an action of the given kind. */
export function hasActionKind(actions: Action[], kind: Action['type']): boolean {
  return actions.some((a) => a.type === kind);
}
