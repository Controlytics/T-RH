/**
 * FE local-context loader (Phase 8.6 — Option D, 2026-05-02).
 *
 * Mirror of the server's `apps/api/src/modules/filter-operations/local-context.ts`,
 * but reads from IDB (legacy `cache` + new versioned v5 sync stores) instead
 * of Prisma. Builds a `LocalContext` the shared executor (`@digilog/shared`)
 * can consume from the FE — both online (richer data) and offline (degraded
 * but consistent).
 *
 * ── Data sources (in priority order) ─────────────────────────────────────
 *
 *   1. Legacy `filter-state-{filterId}` cache (24h TTL) — populated by every
 *      `/api/filters/:id/current-state` round trip. This is the primary
 *      source for current cycle, lifecycle state, equipment group, pipeline
 *      graph, and (critically) the server-computed `stageLookup`.
 *
 *   2. IDB v5 sync stores (`syncFilterCleaningProfiles`, `syncFilters`,
 *      `syncEquipmentGroups`, `syncChecklistProfiles`) — populated by
 *      `/api/sync/since` (Phase 8.4b). Used to fill in profile shapes that
 *      the legacy `filter-state-*` cache may not have if pipelineGraph is
 *      missing.
 *
 *   3. Cached user from `localStorage.digilog_cached_user` (set by useAuth).
 *
 * ── The `events[]` synthesis question ─────────────────────────────────────
 *
 * The server loader reads `events[]` from Prisma (`FilterEvent` rows). The FE
 * has no event stream — `/api/filters/:id/current-state` does not include
 * events. The shared guards consume events for ONE thing in practice:
 *
 *   `assertChecklistGatePassed` looks for `CHECKLIST_COMPLETED` rows whose
 *   `attributes.afterStage === currentState`. The same logic is mirrored in
 *   `computeNextActions` (`checklistAnswered`). If a checklist is required
 *   and no completion event exists, advance is gated.
 *
 *   `assertTapeVersionFresh` reads `events.length` for the version formula.
 *   But the FE-side tapeVersion is the value the server sent in
 *   `/current-state`, NOT a value the FE recomputes — that guard is
 *   server-only in practice.
 *
 * Synthesis policy (FE only):
 *
 *   - When the cached `pendingChecklist` is empty (`[]`) AND the profile DOES
 *     have CHECKLIST nodes between `currentState` and the next STAGE node,
 *     the only legitimate explanation is "operator submitted the checklist
 *     offline already, the cache was cleared by handleChecklistSubmit". We
 *     synthesize a `CHECKLIST_COMPLETED` event with
 *     `attributes.afterStage = currentState` so the executor's gate clears.
 *
 *   - When cached `pendingChecklist` is non-empty, we leave events empty —
 *     the gate fires correctly because no completion event matches.
 *
 *   - We do NOT walk the offline op queue to reconstruct prior STATE_TRANSITION
 *     events — none of the shared guards consume them (they read
 *     `filter.currentLifecycleState` instead, which is up-to-date in cache).
 *
 * ── Graceful degradation ──────────────────────────────────────────────────
 *
 * Each entity falls back to a `null`-ish shape rather than throwing when its
 * cache slot is missing. The shared guards are explicitly fail-closed under
 * those conditions — `assertCycleActive` rejects when `filter.currentCycleId`
 * is missing, `assertProfileAssigned` rejects when there's no profile, etc.
 * Callers should treat a `null` profile as "no actions available" rather than
 * "executor crashed".
 */
import type {
  ChecklistProfileSlice,
  CycleSlice,
  EquipmentGroupSlice,
  FilterEventSlice,
  FilterSlice,
  LocalContext,
  ProfileEdge,
  ProfileNode,
  ProfileSlice,
  StageInfo,
} from '@digilog/shared';
import { buildStageLookup, collectChecklistsAfterStage } from '@digilog/shared';
import {
  getCachedData,
  getCachedEntity,
  getCachedFilters,
} from './offline-store';

// ── Cached-state shape (legacy filter-state-{id} cache) ───────────────────
//
// Mirrors what `/api/filters/:id/current-state` returns. Fields are loosely
// typed (`any`) here because the cache stores the response verbatim and the
// API surface is permissive (`additionalProperties: true` in the route schema).
interface CachedFilterState {
  currentState?: string | null;
  currentCycle?: any;
  nextAllowedStages?: string[];
  pendingChecklist?: any[];
  pipelineStages?: any[];
  pipelineGraph?: { stages?: any[]; connections?: any[] } | null;
  stageLookup?: Record<string, StageInfo> | null;
  equipmentGroup?: any;
  isPmDue?: boolean;
  pmReasonKey?: string | null;
  homeBlock?: { id: string; name: string } | null;
  blockChangeStatus?: string | null;
  // Phase 8.0+ tape fields, when TAPE_PARALLEL=true
  tapeVersion?: number | null;
  actions?: any[];
  // Day 2 of D1/D2/D4 refactor (2026-05-17): explicit completion log that
  // replaces the legacy "pendingChecklist === [] means operator submitted"
  // implicit signal. synthesizeEvents prefers this when present; falls back
  // to the legacy signal so existing cache rows from before this migration
  // still work. Day 5 drops the legacy field once pages migrate off it.
  checklistCompletions?: ChecklistCompletion[];
}

export interface ChecklistCompletion {
  /** Which ChecklistProfile was completed. */
  checklistProfileId: string;
  /** The stage the cycle was on when the operator submitted the checklist.
   *  This matches the `afterStage` attribute the synthesized
   *  CHECKLIST_COMPLETED event carries — the executor's gate checks for any
   *  CHECKLIST_COMPLETED with `afterStage === currentState`. */
  afterStage: string;
  /** ISO timestamp the operator submitted. Surfaces in synthesized events. */
  completedAt: string;
  /** Optional — the cycle the completion was recorded against. Used by the
   *  executor's cycle-isolation invariant. */
  cycleId?: string | null;
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * Build a `LocalContext` for `filterId` from IDB caches. Always resolves —
 * missing slices fall back to sentinels (status='NONE' cycle, empty profile,
 * etc.) so the shared guards can fail-closed without the caller wrapping
 * every access in a try/catch.
 *
 * Used by:
 *   - mobile-operations.tsx + filter-operations.tsx (desktop) for offline
 *     gate decisions and to render the correct action surface.
 *   - Component tests via fixture-based mocks of the four IDB readers.
 */
export async function loadLocalContextFromCache(
  filterId: string,
): Promise<LocalContext> {
  // Read everything in parallel — IDB transactions are non-blocking.
  const [cachedState, cachedFilters, cachedUser] = await Promise.all([
    getCachedData<CachedFilterState>(`filter-state-${filterId}`),
    getCachedFilters(),
    Promise.resolve(readCachedUser()),
  ]);

  // The full server response includes pipelineGraph; if it's missing, fall
  // back to the v5 sync store (cleaning profile lineage). cachedState may
  // also be null entirely if the operator hasn't visited this filter yet.
  const cachedFilter =
    (cachedFilters ?? []).find((f: any) => f.id === filterId) ?? null;

  const profile = await resolveProfile(cachedState, cachedFilter);
  const cycle = projectCycle(cachedState, profile);
  const filter = projectFilter(filterId, cachedFilter, cachedState, cycle);
  const equipmentGroup = projectEquipmentGroup(cachedState);
  const checklistProfile = await resolveChecklistProfile(cachedState);
  const events = synthesizeEvents(cachedState, profile);
  const stageLookup = resolveStageLookup(cachedState, profile);

  return {
    profile,
    cycle,
    events,
    stageLookup,
    filter,
    equipmentGroup,
    checklistProfile,
    assetTemplate: null, // FE doesn't gate on asset-template fields today
    user: cachedUser,
    now: Date.now(),
  };
}

// ── Profile resolution ────────────────────────────────────────────────────

/**
 * Resolve the filter's pinned cleaning profile. Priority:
 *
 *   1. cachedState.pipelineGraph + pipelineStages — the most recent server
 *      response, includes the live nodes/edges + version.
 *   2. cachedFilter.filterProfileId / currentCycle.profileId — when the cache
 *      knows the profile id but the graph isn't expanded, fetch from the v5
 *      sync store.
 *   3. Sentinel empty profile (status='INACTIVE', empty nodes/edges) so
 *      `assertProfileAssigned` / `assertProfileActive` reject cleanly.
 */
async function resolveProfile(
  cachedState: CachedFilterState | null,
  _cachedFilter: any | null,
): Promise<ProfileSlice> {
  // Tier 1: legacy cache has the full graph + version inline.
  if (cachedState?.pipelineGraph?.stages && cachedState.pipelineGraph.connections) {
    const graph = cachedState.pipelineGraph as {
      stages: any[];
      connections: any[];
      flowMode?: string;
      version?: number;
      status?: string;
      id?: string;
      lineageId?: string;
      name?: string;
      cleaningReasons?: unknown;
    };
    return {
      id: graph.id ?? '',
      lineageId: graph.lineageId ?? '',
      name: graph.name ?? '',
      flowMode: graph.flowMode ?? 'SEQUENTIAL',
      version: graph.version ?? 0,
      status: graph.status ?? 'ACTIVE',
      cleaningReasons: graph.cleaningReasons ?? {},
      nodes: graph.stages.map(projectNode),
      edges: graph.connections.map(projectEdge),
    };
  }

  // Tier 2: try the v5 sync store via cycle.profileId or filterDetails.filterProfileId.
  const profileId =
    cachedState?.currentCycle?.profileId ??
    null;
  if (profileId) {
    const row = await getCachedEntity<any>('syncFilterCleaningProfiles', profileId);
    if (row) {
      return {
        id: row.id,
        lineageId: row.lineageId ?? '',
        name: row.name ?? '',
        flowMode: row.flowMode ?? 'SEQUENTIAL',
        version: row.version ?? 0,
        status: row.status ?? 'ACTIVE',
        cleaningReasons: row.cleaningReasons ?? {},
        nodes: (row.stages ?? []).map(projectNode),
        edges: (row.connections ?? []).map(projectEdge),
      };
    }
  }

  // Tier 3: sentinel — guards reject before walking these arrays.
  return {
    id: '',
    lineageId: '',
    name: '',
    flowMode: 'SEQUENTIAL',
    version: 0,
    status: 'INACTIVE',
    cleaningReasons: {},
    nodes: [],
    edges: [],
  };
}

function projectNode(s: any): ProfileNode {
  return {
    id: s.id,
    stateKey: s.stateKey ?? null,
    nodeType: s.nodeType,
    configuration: (s.configuration as Record<string, unknown>) ?? {},
    sortOrder: s.sortOrder ?? 0,
  };
}

function projectEdge(c: any): ProfileEdge {
  return {
    fromStageId: c.fromStageId,
    toStageId: c.toStageId,
  };
}

// ── Cycle projection ──────────────────────────────────────────────────────

/**
 * Project the cached cycle into a CycleSlice. Returns a status='NONE' sentinel
 * when no cycle is in flight — the executor's `if (!cycle || cycle.status !==
 * 'IN_PROGRESS')` short-circuit handles this without the FE branching.
 */
function projectCycle(
  cachedState: CachedFilterState | null,
  profile: ProfileSlice,
): CycleSlice {
  const c = cachedState?.currentCycle;
  if (!c) {
    return {
      id: '',
      cycleCode: '',
      filterId: '',
      profileId: profile.id,
      profileVersion: profile.version,
      status: 'NONE',
      cleaningAreaId: null,
      equipmentGroupId: null,
      equipmentGroupVersionPin: null,
      checklistVersionPins: null,
      dryerStartedAt: null,
      dryerDurationMinutes: null,
      dryerReadingsSubmitted: false,
      cleaningReasonKey: '',
      cleaningReasonLabel: '',
      startedAt: new Date(0),
      completedAt: null,
      terminatedAt: null,
    };
  }
  return {
    id: c.id ?? '',
    cycleCode: c.cycleCode ?? '',
    filterId: c.filterId ?? '',
    profileId: c.profileId ?? profile.id,
    profileVersion: c.profileVersion ?? profile.version,
    status: c.status ?? 'IN_PROGRESS',
    cleaningAreaId: c.cleaningAreaId ?? null,
    equipmentGroupId: c.equipmentGroupId ?? null,
    equipmentGroupVersionPin: c.equipmentGroupVersionPin ?? null,
    checklistVersionPins:
      (c.checklistVersionPins as Record<string, number> | null) ?? null,
    dryerStartedAt: c.dryerStartedAt ?? null,
    dryerDurationMinutes: c.dryerDurationMinutes ?? null,
    dryerReadingsSubmitted: !!c.dryerReadingsSubmitted,
    cleaningReasonKey: c.cleaningReasonKey ?? '',
    cleaningReasonLabel: c.cleaningReasonLabel ?? '',
    startedAt: c.startedAt ?? new Date(0),
    completedAt: c.completedAt ?? null,
    terminatedAt: c.terminatedAt ?? null,
  };
}

// ── Filter projection ─────────────────────────────────────────────────────

/**
 * Project the filter row + cached state into a FilterSlice. The legacy
 * `filters` IDB store carries currentLifecycleState/currentCycleId; the
 * cached state carries the same fields (more recent). Cached state wins when
 * both are present.
 */
function projectFilter(
  filterId: string,
  cachedFilter: any | null,
  cachedState: CachedFilterState | null,
  cycle: CycleSlice,
): FilterSlice {
  const currentLifecycleState =
    cachedState?.currentState ??
    cachedFilter?.currentLifecycleState ??
    null;
  const currentCycleId =
    (cycle.status === 'IN_PROGRESS' && cycle.id) ? cycle.id : (cachedFilter?.currentCycleId ?? null);

  return {
    id: filterId,
    name: cachedFilter?.name ?? '',
    parentId: cachedFilter?.parentId ?? null,
    filterProfileId: cachedFilter?.filterProfileId ?? null,
    currentLifecycleState,
    currentCycleId,
    filterSet: cachedFilter?.filterSet ?? null,
    block: cachedState?.homeBlock
      ? { id: cachedState.homeBlock.id, name: cachedState.homeBlock.name, templateKind: 'BLOCK' }
      : null,
    area: null,  // not surfaced in the legacy cache shape
    ahu: null,   // not surfaced in the legacy cache shape
  };
}

// ── Equipment group ───────────────────────────────────────────────────────

function projectEquipmentGroup(
  cachedState: CachedFilterState | null,
): EquipmentGroupSlice | null {
  const eg = cachedState?.equipmentGroup;
  if (!eg) return null;
  return {
    id: eg.id ?? '',
    name: eg.name ?? '',
    blockId: eg.blockId ?? '',
    isActive: eg.isActive !== false,
    version: eg.version ?? 0,
    instruments: (eg.instruments ?? []).map((i: any) => ({
      id: i.id,
      instrumentId: i.instrumentId ?? i.id,
      description: i.description ?? '',
      stageKey: i.stageKey ?? null,
      uom: i.uom ?? null,
      operatingMin: typeof i.operatingMin === 'number' ? i.operatingMin : 0,
      operatingMax: typeof i.operatingMax === 'number' ? i.operatingMax : 0,
      leastCount: typeof i.leastCount === 'number' ? i.leastCount : 1,
      sortOrder: i.sortOrder ?? 0,
    })),
  };
}

// ── Checklist profile ─────────────────────────────────────────────────────

/**
 * Resolve the *first* pending ChecklistProfile from cache, when cachedState
 * carries `pendingChecklist[].checklistProfileId`. Mirrors the server loader
 * behaviour (single profile per call). Falls back to v5 sync store when the
 * legacy cache has no inline questions array.
 */
async function resolveChecklistProfile(
  cachedState: CachedFilterState | null,
): Promise<ChecklistProfileSlice | null> {
  const pending = cachedState?.pendingChecklist;
  if (!pending || pending.length === 0) return null;
  const first = pending[0];
  const profileId = first?.checklistProfileId;
  if (!profileId) return null;

  // Tier 1: inline on the cache row (handleChecklistSubmit + buildOfflineChecklist
  // resolve `questions` from the legacy `checklist-profiles` cache).
  if (Array.isArray(first.questions) && first.questions.length > 0) {
    return {
      id: profileId,
      name: first.checklistProfileName ?? '',
      isActive: true,
      version: first.profileVersion ?? 0,
      questions: first.questions.map((q: any, i: number) => ({
        id: q.id,
        question: q.question,
        questionType: q.questionType,
        required: !!q.required,
        section: q.section ?? null,
        description: q.description ?? null,
        options: q.options ?? [],
        validation: q.validation ?? {},
        sortOrder: q.sortOrder ?? i,
      })),
    };
  }

  // Tier 2: fall through to v5 sync store (added in 8.4a follow-up).
  const row = await getCachedEntity<any>('syncChecklistProfiles', profileId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? '',
    isActive: row.isActive !== false,
    version: row.version ?? 0,
    questions: (row.questions ?? []).map((q: any, i: number) => ({
      id: q.id,
      question: q.question,
      questionType: q.questionType,
      required: !!q.required,
      section: q.section ?? null,
      description: q.description ?? null,
      options: q.options ?? [],
      validation: q.validation ?? {},
      sortOrder: q.sortOrder ?? i,
    })),
  };
}

// ── Events synthesis ──────────────────────────────────────────────────────

/**
 * Reconstruct the minimal `events[]` slice the shared executor needs.
 *
 * The FE has no event stream, so we synthesize `CHECKLIST_COMPLETED` events
 * with `attributes.afterStage = currentState` — what the executor's gate
 * checks via `assertChecklistGatePassed`.
 *
 * # Synthesis sources (priority order)
 *
 *   1. **Explicit completion log** (`cachedState.checklistCompletions[]`) —
 *      preferred, 21 CFR-friendly. Reliably populated post-Day-3/4 refactor
 *      (commits dc60cca + b9be6f3): `useFilterOperationsCore.submitChecklist`
 *      calls `appendChecklistCompletion()` for every profile in the dialog
 *      on every successful submit. Each entry yields one synthesized event.
 *
 *   2. **Legacy implicit signal** (`pendingChecklist === []`) — RETAINED as
 *      backwards-compat for cache rows written before the Day 3/4 hook
 *      wiring shipped. Empty pending + profile has CHECKLIST nodes after
 *      current stage = "operator submitted offline, cache was cleared"
 *      footprint. Synthesizes ONE event matching current stage. Will be
 *      removed once we're confident no operator is running on a stale APK
 *      whose cache predates the wiring (separate cache-schema-version bump).
 *
 * Chained CHECKLIST→CHECKLIST→STAGE: one synthesized event per afterStage
 * suffices because the executor's gate checks for existence, not cardinality.
 *
 * Other event types (STATE_TRANSITION, CYCLE_STARTED, etc.) are NOT consumed
 * by guards that the FE invokes today — `filter.currentLifecycleState` is
 * the source of truth instead, and is updated via `updateFilterStateLocally()`.
 */
function synthesizeEvents(
  cachedState: CachedFilterState | null,
  profile: ProfileSlice,
): FilterEventSlice[] {
  const currentState = cachedState?.currentState ?? null;
  if (!currentState) return [];

  // Tier 1: explicit completion log (preferred, 21 CFR-friendly).
  // Emit one synthesized event per logged completion. The executor's gate
  // checks `attributes.afterStage === currentState`, so we filter by that.
  const completions = cachedState?.checklistCompletions ?? [];
  const matchingCompletions = completions.filter(
    (c) => c.afterStage === currentState,
  );
  if (matchingCompletions.length > 0) {
    return matchingCompletions.map((c, i) => ({
      id: `synth-checklist-completed-${currentState}-${c.checklistProfileId}-${i}`,
      cycleId: c.cycleId ?? cachedState?.currentCycle?.id ?? null,
      eventType: 'CHECKLIST_COMPLETED',
      fromState: null,
      toState: null,
      performedAt: new Date(c.completedAt),
      attributes: {
        afterStage: currentState,
        checklistProfileId: c.checklistProfileId,
        synthesizedByLoader: true,
        source: 'completion-log',
      },
    }));
  }

  // Tier 2: legacy implicit signal — retained for cache rows from before
  // the Day 3/4 hook wiring shipped. New cache rows always populate Tier 1
  // above via useFilterOperationsCore.submitChecklist, so this branch only
  // fires for stale rows. Slated for removal with a cache-schema-version bump.
  const pending = cachedState?.pendingChecklist ?? [];
  if (pending.length > 0) return [];

  const currentNode = profile.nodes.find(
    (n) => n.nodeType === 'STAGE' && n.stateKey === currentState,
  );
  if (!currentNode) return [];

  const checklistsAfter = collectChecklistsAfterStage(
    currentNode,
    profile.nodes,
    profile.edges,
  );
  const hasChecklistAfter = checklistsAfter.some(
    (n) =>
      Boolean((n.configuration as { checklistProfileId?: unknown })?.checklistProfileId),
  );
  if (!hasChecklistAfter) return [];

  return [
    {
      id: `synth-checklist-completed-${currentState}`,
      cycleId: cachedState?.currentCycle?.id ?? null,
      eventType: 'CHECKLIST_COMPLETED',
      fromState: null,
      toState: null,
      performedAt: new Date(0),
      attributes: {
        afterStage: currentState,
        synthesizedByLoader: true,
        source: 'legacy-pending-signal',
      },
    },
  ];
}

// ── stageLookup resolution ────────────────────────────────────────────────

/**
 * Prefer the server-computed `stageLookup` from the cached current-state
 * response (B.7 — the same table the legacy graph-walk fallbacks already
 * defer to). Falls back to a local `buildStageLookup(profile)` when missing.
 */
function resolveStageLookup(
  cachedState: CachedFilterState | null,
  profile: ProfileSlice,
): Record<string, StageInfo> {
  if (cachedState?.stageLookup && Object.keys(cachedState.stageLookup).length > 0) {
    return cachedState.stageLookup;
  }
  if (profile.nodes.length === 0) return {};
  return buildStageLookup(profile);
}

// ── User from local cache ─────────────────────────────────────────────────

/**
 * Read the cached user from `localStorage.digilog_cached_user` (set by
 * `useAuth`). Falls back to an empty user when not yet logged in — guards
 * that read `user.permissions` will see `[]` and treat the operator as
 * unprivileged. The server is always the final authority on permission
 * enforcement (Phase 8.5+ permission audit).
 */
function readCachedUser(): LocalContext['user'] {
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem('digilog_cached_user')
      : null;
    if (!raw) return { id: '', role: '', permissions: [] };
    const u = JSON.parse(raw);
    return {
      id: u?.id ?? '',
      role: u?.role ?? '',
      permissions: Array.isArray(u?.permissions) ? u.permissions : [],
    };
  } catch {
    return { id: '', role: '', permissions: [] };
  }
}
