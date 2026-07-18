/**
 * Stage / cycle / profile transition guards (Phase 8.5).
 *
 * Pure portions of the four write methods in
 * `apps/api/src/modules/filter-operations/filter-operations.service.ts`,
 * extracted per the Phase 8.5 inventory.
 *
 * Every guard returns `GuardResult`; the caller (server: AppError throw, FE:
 * blocking dialog) interprets `{ ok: false, code, message, details? }` —
 * codes + messages MUST match the originals for cross-runtime parity.
 */
import type {
  FilterSlice,
  GuardResult,
  LocalContext,
  ProfileEdge,
  ProfileNode,
  ProfileSlice,
  StageInfo,
} from './types.js';

/** Guards #1, #9, #36, #43: cycle exists + filter has currentCycleId. */
export function assertCycleActive(ctx: LocalContext): GuardResult {
  if (!ctx.filter.currentCycleId) {
    return {
      ok: false,
      code: 'NO_CYCLE',
      message: 'No active cleaning cycle',
    };
  }
  return { ok: true };
}

/** Guard #47: startCycle — reject when an IN_PROGRESS cycle already exists. */
export function assertNoCycleActive(ctx: LocalContext, filter: FilterSlice): GuardResult {
  if (filter.currentCycleId && ctx.cycle && ctx.cycle.status === 'IN_PROGRESS') {
    return {
      ok: false,
      code: 'CYCLE_ACTIVE',
      message: 'Filter already has an active cleaning cycle',
    };
  }
  return { ok: true };
}

/** Guards #12, #46: a resolved cleaning profile id must exist for this filter. */
export function assertProfileAssigned(
  _ctx: LocalContext,
  resolvedProfileId: string | null | undefined,
): GuardResult {
  if (!resolvedProfileId) {
    return {
      ok: false,
      code: 'NO_PROFILE',
      message: 'Filter has no assigned profile',
    };
  }
  return { ok: true };
}

/**
 * Guard #13 (advance): the resolved cleaning profile must be present AND
 * status='ACTIVE'. Phase 8.6 fix — the original guard only null-checked,
 * which forced filter-operations.service.ts to add a redundant manual
 * `cp.status !== 'ACTIVE'` check immediately after every call. The status
 * check now lives here so the guard fully validates "active and ready".
 */
export function assertProfileActive(
  _ctx: LocalContext,
  cp: ProfileSlice | null | undefined,
): GuardResult {
  if (!cp) {
    return {
      ok: false,
      code: 'PROFILE_DISABLED',
      message: 'Cleaning profile is disabled or not found. Contact admin to activate it.',
    };
  }
  if (cp.status !== 'ACTIVE') {
    return {
      ok: false,
      code: 'PROFILE_DISABLED',
      message: 'Cleaning profile is disabled or not found. Contact admin to activate it.',
    };
  }
  return { ok: true };
}

/** Guard #48 (startCycle): the cleaning profile is present + ACTIVE. */
export function assertProfileEnabled(
  _ctx: LocalContext,
  cp: { name: string; status: string } | null | undefined,
): GuardResult {
  if (cp && cp.status !== 'ACTIVE') {
    return {
      ok: false,
      code: 'PROFILE_DISABLED',
      message: `Cleaning profile "${cp.name}" is disabled. Contact admin to activate it.`,
    };
  }
  return { ok: true };
}

/**
 * Guard #14: pending checklist gate before advance.
 *
 * If the cycle's current stage has CHECKLIST nodes downstream and no
 * `CHECKLIST_COMPLETED` event with `attributes.afterStage === currentState`
 * exists in the cycle's events, advance is blocked.
 *
 * Mirrors `advance()` filter-operations.service.ts:1199-1215 — gates frozen at
 * cycle start (A5), no `isActive` filter on profiles.
 */
export function assertChecklistGatePassed(
  ctx: LocalContext,
  cp: ProfileSlice,
  currentState: string | null | undefined,
): GuardResult {
  if (!currentState) return { ok: true };
  const currentStage = cp.nodes.find(s => s.stateKey === currentState);
  if (!currentStage) return { ok: true };

  const pendingCLNodes = collectChecklistsAfterStageInternal(currentStage, cp.nodes, cp.edges)
    .filter(n => Boolean((n.configuration as { checklistProfileId?: unknown })?.checklistProfileId));

  if (pendingCLNodes.length === 0) return { ok: true };

  const answered = ctx.events.some(
    e =>
      e.eventType === 'CHECKLIST_COMPLETED' &&
      ((e.attributes as { afterStage?: string | null })?.afterStage ?? null) === currentState,
  );
  if (answered) return { ok: true };

  return {
    ok: false,
    code: 'CHECKLIST_PENDING',
    message: `Please complete the checklist before advancing from ${prettyStageLabel(currentState)}`,
  };
}

/**
 * Guard #15: cycle complete — no reachable stages forward but END is reachable.
 * Mirrors advance() lines 1250-1252.
 */
export function assertNotCycleComplete(
  _ctx: LocalContext,
  reachableStages: string[],
  hasEndNext: boolean,
): GuardResult {
  if (reachableStages.length === 0 && hasEndNext) {
    return {
      ok: false,
      code: 'CYCLE_COMPLETE',
      message: 'Cleaning cycle is complete. No more stages.',
    };
  }
  return { ok: true };
}

/**
 * Guard #16: target state reachable.
 *
 * `reachableStages.includes(targetState)` OR flowMode is BYPASS_ENABLED OR
 * dryer in-place action (DRY_IN -> DRY_IN). Mirrors advance() lines 1254-1257.
 */
export function assertTargetStateReachable(
  _ctx: LocalContext,
  targetState: string,
  reachableStages: string[],
  flowMode: string,
  isDryerInPlace: boolean,
  currentState: string | null | undefined,
): GuardResult {
  if (reachableStages.includes(targetState)) return { ok: true };
  if (flowMode === 'BYPASS_ENABLED') return { ok: true };
  if (isDryerInPlace) return { ok: true };

  return {
    ok: false,
    code: 'OUT_OF_SEQUENCE',
    message: `Cannot move to ${targetState} from ${currentState ?? 'START'}. Next allowed: ${reachableStages.join(', ')}`,
  };
}

/** Guard #17: target state exists in the pipeline as a STAGE node. */
export function assertTargetStateExists(
  _ctx: LocalContext,
  targetState: string,
  cp: ProfileSlice,
): GuardResult {
  const targetStage = cp.nodes.find(s => s.stateKey === targetState);
  if (!targetStage) {
    return {
      ok: false,
      code: 'INVALID_TARGET',
      message: `Invalid target state: ${targetState}`,
    };
  }
  return { ok: true };
}

/**
 * Guards #3, #11, #37, #44 (hybrid): tape-version freshness.
 *
 * Pure portion: compute `currentTapeVersion = profileVersion * 1_000_000 +
 * eventCount`, compare to client-submitted version. Server's `loadLocalContext`
 * is responsible for `ctx.events.length` reflecting truth from the DB.
 *
 * `submittedTapeVersion === undefined | null` is a non-check (backwards compat
 * for pre-8.4 callers — server route schema still tightens this independently).
 */
export function assertTapeVersionFresh(
  ctx: LocalContext,
  submittedTapeVersion: number | undefined | null,
): GuardResult {
  if (submittedTapeVersion === undefined || submittedTapeVersion === null) {
    return { ok: true };
  }
  const profileVersion = ctx.cycle?.profileVersion ?? 0;
  const eventCount = ctx.events.length;
  const currentTapeVersion = profileVersion * 1_000_000 + eventCount;
  if (submittedTapeVersion !== currentTapeVersion) {
    return {
      ok: false,
      code: 'STALE_TAPE',
      message: 'Tape version mismatch — another operator may have changed this cycle. Refresh and retry.',
      details: { currentTapeVersion },
    };
  }
  return { ok: true };
}

// ── Helpers (also exported for caller convenience) ──────────────────────────

/**
 * Walk forward from a STAGE/START node; collect any CHECKLIST nodes between
 * it and the next STAGE/END. Mirrors `collectChecklistsAfterStage` in
 * filter-operations.service.ts:68-92.
 */
export function collectChecklistsAfterStage(
  stage: ProfileNode,
  allStages: ProfileNode[],
  connections: ProfileEdge[],
): ProfileNode[] {
  return collectChecklistsAfterStageInternal(stage, allStages, connections);
}

function collectChecklistsAfterStageInternal(
  stage: ProfileNode,
  allStages: ProfileNode[],
  connections: ProfileEdge[],
): ProfileNode[] {
  const checklists: ProfileNode[] = [];
  const visited = new Set<string>();
  const walk = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const c of connections.filter(cn => cn.fromStageId === nodeId)) {
      const next = allStages.find(s => s.id === c.toStageId);
      if (!next) continue;
      if (next.nodeType === 'CHECKLIST') {
        checklists.push(next);
        walk(next.id);
      }
    }
  };
  walk(stage.id);
  return checklists;
}

/**
 * Walk forward from a node; collect reachable STAGE stateKeys (skipping
 * CHECKLIST nodes) and a `leadsToEnd` flag. Mirrors the per-call
 * `findReachableStages` walker inside advance() (lines 1226-1248) and the
 * tape generator's `findReachable`.
 */
export function findReachable(
  fromNodeId: string,
  allStages: ProfileNode[],
  connections: ProfileEdge[],
): { reachableStages: string[]; hasEndNext: boolean } {
  const reachableStages: string[] = [];
  let hasEndNext = false;
  const visited = new Set<string>();
  const walk = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const c of connections.filter(cn => cn.fromStageId === nodeId)) {
      const next = allStages.find(s => s.id === c.toStageId);
      if (!next) continue;
      if (next.nodeType === 'STAGE' && next.stateKey) {
        reachableStages.push(next.stateKey);
      } else if (next.nodeType === 'END') {
        hasEndNext = true;
      } else if (next.nodeType === 'CHECKLIST') {
        walk(next.id);
      }
    }
  };
  walk(fromNodeId);
  return { reachableStages, hasEndNext };
}

/** Returns the list of stateKeys reachable from the cycle's current state. */
export function getReachableStages(ctx: LocalContext): string[] {
  if (!ctx.cycle) return [];
  const state = ctx.filter.currentLifecycleState;
  const fromNode = state
    ? ctx.profile.nodes.find(s => s.stateKey === state) ?? ctx.profile.nodes.find(s => s.nodeType === 'START')
    : ctx.profile.nodes.find(s => s.nodeType === 'START');
  if (!fromNode) return [];
  return findReachable(fromNode.id, ctx.profile.nodes, ctx.profile.edges).reachableStages;
}

/** Returns true when the next non-CHECKLIST node forward from current state is END. */
export function leadsToEnd(ctx: LocalContext): boolean {
  const state = ctx.filter.currentLifecycleState;
  const fromNode = state
    ? ctx.profile.nodes.find(s => s.stateKey === state) ?? ctx.profile.nodes.find(s => s.nodeType === 'START')
    : ctx.profile.nodes.find(s => s.nodeType === 'START');
  if (!fromNode) return false;
  return findReachable(fromNode.id, ctx.profile.nodes, ctx.profile.edges).hasEndNext;
}

/** Pretty-print a stateKey for operator-facing messages — same impl as service. */
export function prettyStageLabel(stateKey: string | null | undefined): string {
  if (!stateKey) return 'this stage';
  return stateKey
    .split('_')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Build `stageLookup` from a profile graph. Mirrors the per-stage table built
 * in getCurrentState() (filter-operations.service.ts:632-658). Server may
 * pre-compute this once per request and stash on `ctx.stageLookup`; this
 * helper exists for the FE / tests that have only the profile slice.
 */
export function buildStageLookup(profile: ProfileSlice): Record<string, StageInfo> {
  const stageLookup: Record<string, StageInfo> = {};
  for (const s of profile.nodes) {
    if (s.nodeType !== 'STAGE' || !s.stateKey) continue;
    const checklistNodes = collectChecklistsAfterStageInternal(s, profile.nodes, profile.edges);
    const { reachableStages, hasEndNext } = findReachable(s.id, profile.nodes, profile.edges);
    const seen = new Set<string>();
    const dedupedStages: string[] = [];
    for (const k of reachableStages) {
      if (seen.has(k)) continue;
      seen.add(k);
      dedupedStages.push(k);
    }
    stageLookup[s.stateKey] = {
      nextStages: dedupedStages,
      pendingChecklistProfileIds: checklistNodes
        .map(n => (n.configuration as { checklistProfileId?: string })?.checklistProfileId)
        .filter((v): v is string => typeof v === 'string'),
      leadsToEnd: hasEndNext,
    };
  }
  return stageLookup;
}

/**
 * For tape callers: the legacy `assertCanTransition(ctx, target)` shape.
 * Computes reachability + delegates to `assertTargetStateReachable` with
 * defaults (no flowMode override, no dryer in-place) — useful for unit
 * tests / FE pre-render checks before the server transition fires.
 */
export function assertCanTransition(
  ctx: LocalContext,
  targetStateKey: string,
): GuardResult {
  const reachable = getReachableStages(ctx);
  if (reachable.includes(targetStateKey)) return { ok: true };
  return {
    ok: false,
    code: 'OUT_OF_SEQUENCE',
    message: `Cannot move to ${targetStateKey} from ${ctx.filter.currentLifecycleState ?? 'START'}. Next allowed: ${reachable.join(', ')}`,
  };
}
