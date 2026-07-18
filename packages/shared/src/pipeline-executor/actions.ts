/**
 * Tape-generator entry point — Phase 8.5 Commit 2.
 *
 * Moved from `apps/api/src/modules/filter-operations/tape/tape-generator.ts`
 * (Phase 8.0 generator) and rewritten to consume `LocalContext` slices
 * instead of the bespoke `TapeInput`. Identical action emission rules; the
 * existing apps/api file becomes a thin wrapper that adapts TapeInput →
 * LocalContext and delegates here so both server + FE share the same code path.
 *
 * Rules mirror filter-operations.service.ts (getCurrentState + advance) plus
 * Phase 8.0 / 8.1 / 8.2 fixes (M1 bypass surface expansion, M3 tapeVersion
 * formula).
 */
import type {
  Action,
  ActionTape,
  AdvanceToStageAction,
  BypassStageAction,
  CompleteCycleAction,
  OperatingRangeMap,
  SetDryerDurationAction,
  SubmitChecklistAction,
  SubmitDryerReadingsAction,
  TerminateCycleAction,
} from '../types/action-tape.js';
import type {
  ChecklistProfileSlice,
  EquipmentGroupSlice,
  LocalContext,
  ProfileEdge,
  ProfileNode,
  TapeInstrument,
} from './types.js';
import { collectChecklistsAfterStage, prettyStageLabel } from './transitions.js';

// ── Pipeline-graph helpers ────────────────────────────────────────────────

function findReachable(
  fromNodeId: string,
  allStages: ProfileNode[],
  connections: ProfileEdge[],
): { reachableStages: { stateKey: string; stage: ProfileNode }[]; leadsToEnd: boolean } {
  const reachable: { stateKey: string; stage: ProfileNode }[] = [];
  let leadsToEnd = false;
  const visited = new Set<string>();
  const walk = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const c of connections.filter(cn => cn.fromStageId === nodeId)) {
      const next = allStages.find(s => s.id === c.toStageId);
      if (!next) continue;
      if (next.nodeType === 'STAGE' && next.stateKey) {
        reachable.push({ stateKey: next.stateKey, stage: next });
      } else if (next.nodeType === 'END') {
        leadsToEnd = true;
      } else if (next.nodeType === 'CHECKLIST') {
        walk(next.id);
      }
    }
  };
  walk(fromNodeId);
  return { reachableStages: reachable, leadsToEnd };
}

// ── Instrument helpers ────────────────────────────────────────────────────

function instrumentsForStage(
  eq: EquipmentGroupSlice | null,
  stageKey: string,
): TapeInstrument[] {
  if (!eq) return [];
  return eq.instruments
    .filter(i => i.stageKey === stageKey)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function buildOperatingRanges(
  insts: { id: string; operatingMin: number; operatingMax: number }[],
): OperatingRangeMap {
  const m: OperatingRangeMap = {};
  for (const i of insts) m[i.id] = { min: i.operatingMin, max: i.operatingMax };
  return m;
}

// ── Tape-version formula (single source of truth) ─────────────────────────

/**
 * `profileVersion * 1_000_000 + filterEventCount`. Per-cycle event-count cap
 * is 1e6 (M3 — Phase 8.4 2026-05-02). filterEventCount is scoped to a single
 * CleaningCycle, not the filter's lifetime.
 */
export function computeTapeVersion(
  profileVersion: number,
  filterEventCount: number,
): number {
  return (profileVersion ?? 0) * 1_000_000 + (filterEventCount ?? 0);
}

// ── Resolved checklist-profile lookup ─────────────────────────────────────

/**
 * Optional caller-supplied map of checklistProfileId → ChecklistProfileSlice.
 *
 * The legacy TapeInput carried `pinnedChecklistProfiles` (a fully-resolved
 * Map). LocalContext exposes a single `checklistProfile` (current pending
 * profile only) — sufficient for most cases. Callers with multiple
 * checklists across the cycle pass the full Map here.
 */
export interface ComputeNextActionsOptions {
  checklistProfilesById?: Map<string, ChecklistProfileSlice>;
}

// ── Main entry ────────────────────────────────────────────────────────────

/**
 * Pure-function tape generator over a LocalContext snapshot. Returns a
 * well-formed ActionTape with stable ordering for fixed inputs.
 *
 * Determinism contract identical to the legacy `generateTape()`. The output
 * `tapeVersion` is `profileVersion * 1e6 + ctx.events.length`.
 */
export function computeNextActions(
  ctx: LocalContext,
  options: ComputeNextActionsOptions = {},
): ActionTape {
  const { profile, cycle, filter, equipmentGroup } = ctx;
  const checklistProfilesById =
    options.checklistProfilesById ?? singleMap(ctx.checklistProfile);
  const actions: Action[] = [];
  const state = filter.currentLifecycleState;

  const filterEventCount = ctx.events.length;

  // No live cycle → no advance-surface actions. cycle.status='NONE' is the
  // sentinel the FE / server uses for "no current cycle"; treat anything
  // not IN_PROGRESS the same way.
  if (!cycle || cycle.status !== 'IN_PROGRESS') {
    return {
      state,
      actions: [],
      tapeVersion: computeTapeVersion(cycle?.profileVersion ?? 0, filterEventCount),
    };
  }

  // TERMINATE always available while cycle in progress. Pushed last to match
  // legacy ordering — declared up here so early returns include it.
  const terminate: TerminateCycleAction = {
    type: 'TERMINATE_CYCLE',
    label: 'Terminate Cycle',
    requiresJustification: { minLength: 10 },
  };

  // Without a profile we can still terminate.
  if (!profile) {
    actions.push(terminate);
    return {
      state,
      actions,
      tapeVersion: computeTapeVersion(cycle.profileVersion, filterEventCount),
    };
  }

  const stages = profile.nodes;
  const connections = profile.edges;

  // Locate "from" node — current STAGE if state set, else START.
  const fromNode = state
    ? stages.find(s => s.stateKey === state) ?? stages.find(s => s.nodeType === 'START')
    : stages.find(s => s.nodeType === 'START');

  if (!fromNode) {
    actions.push(terminate);
    return {
      state,
      actions,
      tapeVersion: computeTapeVersion(cycle.profileVersion, filterEventCount),
    };
  }

  // 1. Pending-checklist gate.
  const checklistNodes = state
    ? collectChecklistsAfterStage(fromNode, stages, connections)
    : [];
  const checklistAnswered = (afterStage: string | null): boolean => {
    if (!afterStage) return false;
    return ctx.events.some(
      e =>
        e.eventType === 'CHECKLIST_COMPLETED' &&
        ((e.attributes as { afterStage?: string | null })?.afterStage ?? null) === afterStage,
    );
  };

  let checklistsPending = false;
  if (state && checklistNodes.length > 0 && !checklistAnswered(state)) {
    const submits: SubmitChecklistAction[] = [];
    for (const cl of checklistNodes) {
      const checklistProfileId = (cl.configuration as { checklistProfileId?: string })
        ?.checklistProfileId;
      if (!checklistProfileId) continue;
      const resolved = checklistProfilesById.get(checklistProfileId);
      if (!resolved || resolved.questions.length === 0) continue;
      submits.push({
        type: 'SUBMIT_CHECKLIST',
        label: `Submit Checklist: ${resolved.name ?? prettyStageLabel(state)}`,
        params: {
          checklistProfileId,
          versionPin: resolved.version,
          afterStage: state,
          questions: resolved.questions,
        },
        blocking: true,
      });
    }
    if (submits.length > 0) {
      checklistsPending = true;
      actions.push(...submits);
    }
  }

  if (checklistsPending) {
    actions.push(terminate);
    return {
      state,
      actions,
      tapeVersion: computeTapeVersion(cycle.profileVersion, filterEventCount),
    };
  }

  // 2. Reachable stages (skipping CHECKLIST nodes).
  const { reachableStages, leadsToEnd } = findReachable(fromNode.id, stages, connections);

  // 3. DRY_IN specials.
  let blockedByDryerHalfTime = false;
  let dryerReadingsAction: SubmitDryerReadingsAction | null = null;
  if (state === 'DRY_IN' && cycle.dryerStartedAt && cycle.dryerDurationMinutes) {
    const halfMs = (cycle.dryerDurationMinutes * 60_000) / 2;
    const startedMs =
      cycle.dryerStartedAt instanceof Date
        ? cycle.dryerStartedAt.getTime()
        : new Date(cycle.dryerStartedAt as string).getTime();
    const elapsedMs = ctx.now - startedMs;
    const halfElapsed = elapsedMs >= halfMs;
    if (!halfElapsed) {
      blockedByDryerHalfTime = true;
    }
    if (halfElapsed && !cycle.dryerReadingsSubmitted) {
      const dryInInsts = instrumentsForStage(equipmentGroup, 'DRY_IN');
      if (dryInInsts.length > 0) {
        dryerReadingsAction = {
          type: 'SUBMIT_DRYER_READINGS',
          label: 'Submit Dryer Readings',
          params: { instrumentIds: dryInInsts.map(i => i.id) },
          validations: {
            halfDurationMs: halfMs,
            operatingRanges: buildOperatingRanges(dryInInsts),
          },
        };
      }
    }
  }

  if (dryerReadingsAction) {
    actions.push(dryerReadingsAction);
  }

  // 4. Advance / SET_DRYER_DURATION / COMPLETE.
  if (!blockedByDryerHalfTime) {
    for (const r of reachableStages) {
      if (r.stateKey === 'DRY_IN' && state !== 'DRY_IN' && !cycle.dryerStartedAt) {
        const setDur: SetDryerDurationAction = {
          type: 'SET_DRYER_DURATION',
          label: 'Set Dryer Duration',
          params: { targetState: 'DRY_IN', minMinutes: 1, maxMinutes: 1440 },
        };
        actions.push(setDur);
        continue;
      }

      const stageInsts = instrumentsForStage(equipmentGroup, r.stateKey);
      const adv: AdvanceToStageAction = {
        type: 'ADVANCE_TO_STAGE',
        label: `Advance to ${prettyStageLabel(r.stateKey)}`,
        params: {
          targetState: r.stateKey,
          ...(stageInsts.length > 0
            ? { requiresInstrumentReadings: stageInsts.map(i => i.id) }
            : {}),
        },
        ...(stageInsts.length > 0
          ? { validations: { operatingRanges: buildOperatingRanges(stageInsts) } }
          : {}),
      };
      actions.push(adv);
    }

    if (leadsToEnd && reachableStages.length === 0) {
      const complete: CompleteCycleAction = {
        type: 'COMPLETE_CYCLE',
        label: 'Complete Cycle',
      };
      actions.push(complete);
    }
  }

  // 5. BYPASS_STAGE — full pipeline-stage set excl. current state, when
  // flowMode permits bypass. Mirrors M1 (Phase 8.2 fix 2026-05-02).
  if (
    !checklistsPending &&
    !blockedByDryerHalfTime &&
    profile.flowMode === 'BYPASS_ENABLED'
  ) {
    const allBypassTargets = stages
      .filter(s => s.nodeType === 'STAGE' && s.stateKey && s.stateKey !== state)
      .slice()
      .sort((a, b) => {
        const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (so !== 0) return so;
        return (a.stateKey ?? '').localeCompare(b.stateKey ?? '');
      });
    for (const s of allBypassTargets) {
      const byp: BypassStageAction = {
        type: 'BYPASS_STAGE',
        label: `Bypass to ${prettyStageLabel(s.stateKey!)}`,
        params: { targetState: s.stateKey! },
        requiresJustification: { minLength: 10 },
      };
      actions.push(byp);
    }
  }

  actions.push(terminate);
  return {
    state,
    actions,
    tapeVersion: computeTapeVersion(cycle.profileVersion, filterEventCount),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build a single-entry Map from an optional ChecklistProfileSlice. Used when
 * the caller's LocalContext only exposes the current pending profile.
 */
function singleMap(
  cl: ChecklistProfileSlice | null | undefined,
): Map<string, ChecklistProfileSlice> {
  const m = new Map<string, ChecklistProfileSlice>();
  if (cl) m.set(cl.id, cl);
  return m;
}
