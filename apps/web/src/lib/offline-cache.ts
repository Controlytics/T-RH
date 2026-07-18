/**
 * Offline filter-state cache helpers — Phase 8.6 part 2.
 *
 * Centralizes the post-advance cache rewrite that the mobile + desktop
 * filter-operations pages used to do via local `updateOfflineState` /
 * `updateCachedStateAfterAdvance` helpers (now deleted). One implementation,
 * two callers, no drift.
 *
 * ── What this does ────────────────────────────────────────────────────────
 *
 * After a queued offline advance (or a cycle-start that didn't reach the
 * server), the local `filter-state-{filterId}` cache must be rewritten so
 * the next gate decision sees the new lifecycle state. The rewrite needs:
 *
 *   1. The filter row's `currentLifecycleState` updated in IDB
 *      (`updateFilterStateLocally`) — the `loadLocalContextFromCache` loader
 *      reads this when the cache row is missing the field.
 *   2. A fresh `pendingChecklist[]` computed from the profile graph —
 *      CHECKLIST nodes that fire AFTER the new stage, with their `questions`
 *      resolved against the cached `checklist-profiles` store. Without this,
 *      the loader would synthesize a CHECKLIST_COMPLETED event next read
 *      (its "operator submitted offline" footprint), and the executor would
 *      skip the gate — a 21 CFR violation.
 *   3. A fresh `nextAllowedStages[]` (legacy mirror) and `actions[]` (tape
 *      mirror) so that subsequent gate sites don't have to recompute.
 *   4. `currentState` rewritten on the cache row, and `currentCycle` either
 *      preserved or cleared on cycle completion.
 *
 * ── Why we cache the legacy mirrors AND the tape ──────────────────────────
 *
 * Most gate sites in the FE pages now consume `actions[]` via
 * `getCurrentActions()` (Phase 8.6 part 2 commit 1). But:
 *
 *   - Some legacy components still read `pendingChecklist` directly (the
 *     ChecklistDialog payload format hasn't been unified yet — that's 8.7
 *     territory).
 *   - The `local-context.ts` loader's checklist-completed synthesis depends
 *     on `cachedState.pendingChecklist.length > 0` as the "no synthesis"
 *     signal.
 *
 * So we keep both legacy mirror fields (`nextAllowedStages`, `pendingChecklist`)
 * AND the tape (`actions`, `tapeVersion`) in cache until 8.7 retires the
 * legacy ones.
 */
import {
  collectChecklistsAfterStage,
  computeNextActions,
  findReachable,
  type Action,
} from '@digilog/shared';
import {
  cacheData,
  clearOfflineCycleId,
  getCachedData,
  updateFilterStateLocally,
  OFFLINE_TTL_MS,
} from './offline-store';
import { loadLocalContextFromCache } from './local-context';

interface CachedFilterState {
  currentState?: string | null;
  currentCycle?: any;
  nextAllowedStages?: string[];
  pendingChecklist?: any[];
  pipelineStages?: any[];
  pipelineGraph?: { stages?: any[]; connections?: any[] } | null;
  stageLookup?: Record<string, any> | null;
  equipmentGroup?: any;
  isPmDue?: boolean;
  pmReasonKey?: string | null;
  homeBlock?: { id: string; name: string } | null;
  blockChangeStatus?: string | null;
  actions?: any[] | null;
  tapeVersion?: number | null;
  // Day 2 of D1/D2/D4 refactor (2026-05-17): explicit checklist completion log.
  // Replaces the legacy "pendingChecklist === [] means operator submitted"
  // implicit signal. handleChecklistSubmit appends here; the local-context
  // loader's synthesizeEvents prefers this over the legacy pendingChecklist
  // signal. recomputeAndCacheFilterState preserves the array across advance
  // recomputes.
  checklistCompletions?: ChecklistCompletion[];
}

export interface ChecklistCompletion {
  checklistProfileId: string;
  afterStage: string;
  completedAt: string;
  cycleId?: string | null;
}

/**
 * Day 2 helper — append a completion record to the cache row, preserving
 * any existing entries. Used by handleChecklistSubmit in both pages
 * (which today inline the cache mutation; Days 3/4 lift the call into
 * useFilterOperationsCore). Idempotent on (cycleId, checklistProfileId,
 * afterStage) so re-firing on retry doesn't double-log.
 */
export async function appendChecklistCompletion(
  filterId: string,
  completion: ChecklistCompletion,
): Promise<void> {
  const existing = (await getCachedData<CachedFilterState>(
    `filter-state-${filterId}`,
  )) ?? {};
  const existingLog = existing.checklistCompletions ?? [];
  const alreadyLogged = existingLog.some(
    (c) =>
      c.checklistProfileId === completion.checklistProfileId &&
      c.afterStage === completion.afterStage &&
      (c.cycleId ?? null) === (completion.cycleId ?? null),
  );
  if (alreadyLogged) return;
  await cacheData(
    `filter-state-${filterId}`,
    { ...existing, checklistCompletions: [...existingLog, completion] },
    OFFLINE_TTL_MS,
  );
}

/**
 * Build the legacy `pendingChecklist[]` shape from CHECKLIST nodes after the
 * given stage. Resolves each profile against the cached `checklist-profiles`
 * store (populated by sync). Skips profiles that aren't cached or are
 * inactive — same conservative behaviour as the deleted local helper.
 *
 * Empty array → no checklist gate → caller writes `pendingChecklist: []` and
 * `loadLocalContextFromCache` will not synthesize a CHECKLIST_COMPLETED event
 * (it only fires when the profile actually has CHECKLIST nodes after the
 * stage, so empty here is consistent with "no gate").
 */
/**
 * Ids of CHECKLIST profiles that fire after `newStage` — the "is there a
 * checklist gate here?" question, independent of whether that checklist's
 * QUESTIONS can be resolved from the checklist-profiles cache. Prefers the
 * server-computed stageLookup (B.7 — authoritative), else walks the cached
 * profile graph via the shared executor.
 *
 * recomputeAndCacheFilterState uses this to fail CLOSED: if the graph says a
 * checklist exists after the stage but buildPendingChecklistFromProfile can't
 * resolve its questions from cache, the cycle must NOT auto-complete (that
 * skips a required checklist and rolls into a fresh cycle — 21 CFR §11).
 */
function expectedChecklistIdsAfterStage(
  graph: { stages?: any[]; connections?: any[] } | null | undefined,
  stageLookup: Record<string, any> | null | undefined,
  newStage: string,
): string[] {
  const lookupHit = stageLookup?.[newStage]?.pendingChecklistProfileIds;
  if (Array.isArray(lookupHit)) return lookupHit;
  if (graph?.stages && graph?.connections) {
    const stageNode = graph.stages.find((s: any) => s.stateKey === newStage);
    if (!stageNode) return [];
    return collectChecklistsAfterStage(stageNode, graph.stages, graph.connections)
      .map((n) => (n.configuration as { checklistProfileId?: string })?.checklistProfileId)
      .filter((id): id is string => Boolean(id));
  }
  return [];
}

/**
 * Resolve the checklist that fires after `targetStage` WITHOUT advancing —
 * the pre-advance half of the atomic advance+checklist flow (2026-07-16).
 *
 * The advance used to commit before this could be asked, so a cancelled
 * checklist stranded a §11 record of a stage entry whose attestation never
 * happened. The client can answer this question up-front because the server
 * pre-computes `stageLookup[<stage>].pendingChecklistProfileIds` for EVERY
 * stage (current-state.ts), not just the current one.
 *
 * Reuses the same two helpers `recomputeAndCacheFilterState` uses — no second
 * implementation of "which checklist fires here" to drift from the server.
 *
 * `expectedIds` is returned alongside so the caller can tell the two very
 * different empty cases apart:
 *   - `expectedIds: []`          → genuinely no checklist here. Advance plainly.
 *   - `expectedIds: [...]`, `checklists: []` → a checklist EXISTS but its
 *     questions aren't in cache (never synced / stale). Caller must NOT treat
 *     this as "no gate" — see resolveChecklistForTargetStage, which refetches.
 */
export async function resolvePendingChecklistForStage(
  filterId: string,
  targetStage: string,
): Promise<{ checklists: any[]; expectedIds: string[] }> {
  const cachedState = (await getCachedData<CachedFilterState>(
    `filter-state-${filterId}`,
  )) ?? {};
  const graph = cachedState.pipelineGraph;
  const stageLookup = cachedState.stageLookup;
  const expectedIds = expectedChecklistIdsAfterStage(graph, stageLookup, targetStage);
  if (expectedIds.length === 0) return { checklists: [], expectedIds };
  const checklists = await buildPendingChecklistFromProfile(graph, stageLookup, targetStage);
  return { checklists, expectedIds };
}

async function buildPendingChecklistFromProfile(
  graph: { stages?: any[]; connections?: any[] } | null | undefined,
  stageLookup: Record<string, any> | null | undefined,
  newStage: string,
): Promise<any[]> {
  const profileIds = expectedChecklistIdsAfterStage(graph, stageLookup, newStage);
  if (profileIds.length === 0) return [];

  const cachedProfiles = (await getCachedData<any[]>('checklist-profiles')) ?? [];
  const result: any[] = [];
  for (const profileId of profileIds) {
    const profile = cachedProfiles.find(
      (p: any) => p.id === profileId && p.isActive !== false,
    );
    if (!profile) continue;
    if (!Array.isArray(profile.questions) || profile.questions.length === 0) {
      // Stale cache — surface for operator awareness rather than a silent skip
      console.warn('[offline-cache] checklist profile cached without questions', profileId);
    }
    result.push({
      pipelineNodeId: `${newStage}-${profileId}`,
      checklistProfileId: profileId,
      checklistProfileName: profile.name,
      profileVersion: profile.version,
      questions: (profile.questions ?? []).slice().sort(
        (a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
      ),
    });
  }
  return result;
}

/**
 * Compute reachable advance targets from `newStage` via the shared executor's
 * `findReachable` walker. Mirrors the server's `nextAllowedStages` derivation.
 *
 * Returns an empty array when:
 *   - the cache has no graph data,
 *   - or `newStage` does not appear in the graph (cycle-complete fallback).
 */
function computeNextAllowed(
  graph: { stages?: any[]; connections?: any[] } | null | undefined,
  newStage: string,
): string[] {
  if (!graph?.stages || !graph?.connections) return [];
  const currentNode = graph.stages.find((s: any) => s.stateKey === newStage);
  if (!currentNode) return [];
  return findReachable(currentNode.id, graph.stages, graph.connections).reachableStages;
}

/**
 * Linear-pipeline fallback for cycles whose graph data wasn't cached but the
 * legacy `pipelineStages[]` array is. Returns the next stage in sortOrder.
 */
function computeNextAllowedLinear(
  pipelineStages: any[] | undefined,
  newStage: string,
): string[] {
  const pipeline = (pipelineStages ?? [])
    .filter((s: any) => s.stateKey)
    .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const idx = pipeline.findIndex((s: any) => s.stateKey === newStage);
  return idx >= 0 && idx < pipeline.length - 1 ? [pipeline[idx + 1].stateKey] : [];
}

/**
 * Recompute and persist the `filter-state-{filterId}` cache after an offline
 * advance. Single source of truth — replaces both `updateOfflineState`
 * (mobile) and `updateCachedStateAfterAdvance` (desktop).
 *
 * Sequence:
 *   1. `updateFilterStateLocally` — mutates the IDB filter row's lifecycle
 *      state. Cycle-completion case clears the row's lifecycle state to ''.
 *   2. Read existing cache row (the cycle-side fields we need to preserve).
 *   3. Compute the new `pendingChecklist[]` via profile graph walk +
 *      checklist-profiles cache lookup.
 *   4. Compute the new `nextAllowedStages[]` (graph fallback to linear
 *      pipeline if no graph). When pendingChecklist is non-empty, the
 *      checklist gate blocks advancement → nextAllowedStages = [].
 *   5. Determine `cycleComplete` (no advance targets, no pending checklist,
 *      not a fresh cycle-start, AND we have authoritative pipeline data).
 *   6. Write the cache row with all derived fields. Also re-runs
 *      `computeNextActions` over the freshly-loaded LocalContext to populate
 *      `actions` + `tapeVersion` (the tape-native fields). When 8.7 retires
 *      the legacy mirror fields, only this final tape write will remain.
 *   7. Clear `currentCycleId` from the IDB filter row when the cycle just
 *      completed, so the next scan starts a fresh cycle.
 */
export async function recomputeAndCacheFilterState(
  filterId: string,
  newStage: string,
  cycleStarted: boolean,
  blockId?: string | null,
): Promise<void> {
  try {
    await updateFilterStateLocally(filterId, newStage, cycleStarted);

    const cachedState = (await getCachedData<CachedFilterState>(
      `filter-state-${filterId}`,
    )) ?? {};
    const graph = cachedState.pipelineGraph;
    const stageLookup = cachedState.stageLookup;

    // 21 CFR compliance — never skip required checklists offline. Computed
    // BEFORE writing the cache row so the loader's CHECKLIST_COMPLETED
    // synthesis stays correct (synthesis only fires when pendingChecklist=[]).
    const pendingChecklist = await buildPendingChecklistFromProfile(
      graph,
      stageLookup,
      newStage,
    );

    // 21 CFR fail-closed. The graph/stageLookup may say a CHECKLIST fires after
    // `newStage` while buildPendingChecklistFromProfile returned [] because the
    // checklist's questions couldn't be resolved from cache (profile not synced /
    // stale / a custom role couldn't read /api/checklist-profiles). In that case
    // pendingChecklist.length===0 does NOT mean "no checklist" — treating it as
    // such silently skips a required checklist AND, at a terminal stage, marks
    // the cycle complete and rolls the filter into a fresh cycle (exactly the
    // STORAGE_OUT bug: checklist vanished, WASH_IN of a new cycle started, then
    // the server rejected the un-checklisted cycle on sync). Block instead: keep
    // the filter parked at `newStage` until it re-syncs online and the server
    // re-resolves the gate. Online recompute has no checklist-profiles cache
    // dependency, so it self-heals on reconnect.
    const expectedChecklistIds = expectedChecklistIdsAfterStage(graph, stageLookup, newStage);
    const checklistUnresolved =
      expectedChecklistIds.length > 0 && pendingChecklist.length === 0;

    // Reachable advance targets — graph wins, linear pipeline fallback.
    let nextAllowed: string[] = [];
    let hasGraphData = false;
    if (pendingChecklist.length > 0 || checklistUnresolved) {
      // Checklist gate blocks until answered (or, when unresolved, until sync).
      nextAllowed = [];
      hasGraphData = !!graph;
    } else if (graph?.stages && graph?.connections) {
      nextAllowed = computeNextAllowed(graph, newStage);
      hasGraphData = true;
    }
    if (!hasGraphData) {
      nextAllowed = computeNextAllowedLinear(cachedState.pipelineStages, newStage);
      hasGraphData = (cachedState.pipelineStages?.length ?? 0) > 0;
    }

    const cycleComplete =
      hasGraphData &&
      nextAllowed.length === 0 &&
      pendingChecklist.length === 0 &&
      !checklistUnresolved &&
      !cycleStarted;

    if (checklistUnresolved) {
      // Structured warning so the operator knows to reconnect rather than
      // seeing a silently-stuck stage. Not thrown — the advance itself was
      // valid; only the downstream checklist gate is unresolvable offline.
      // eslint-disable-next-line no-console -- intentional structured log
      console.warn(
        '[offline-cache] checklist gate unresolved offline for',
        filterId,
        'at',
        newStage,
        '— parked (needs online sync to load checklist questions). expected profiles:',
        expectedChecklistIds,
      );
    }

    // Mid-write: stamp the cache with the new lifecycle state, the new
    // legacy mirrors, and a placeholder for actions[]. The executor read
    // below picks these up via loadLocalContextFromCache.
    const updatedCacheRow: CachedFilterState = {
      ...cachedState,
      currentState: cycleComplete ? null : newStage,
      nextAllowedStages: cycleComplete ? [] : nextAllowed,
      pendingChecklist,
      currentCycle: cycleComplete
        ? null
        : (cachedState.currentCycle ??
            (cycleStarted
              ? {
                  id: `offline-${Date.now()}`,
                  status: 'IN_PROGRESS',
                  cleaningAreaId: blockId ?? null,
                }
              : null)),
      // Day 2 (D1/D2/D4 refactor): clear the completion log when a cycle
      // completes — entries with cycleId === oldCycleId are inert against
      // the next cycle, and clearing prevents IDB bloat over time.
      // Otherwise spread above preserves the array across mid-cycle advances.
      checklistCompletions: cycleComplete ? [] : (cachedState.checklistCompletions ?? []),
    };
    await cacheData(`filter-state-${filterId}`, updatedCacheRow, OFFLINE_TTL_MS);

    // Re-run the executor over the just-written cache so the tape-native
    // fields (`actions`, `tapeVersion`) end up on the row too. This is the
    // path 8.7 will keep when the legacy mirror fields are retired.
    if (!cycleComplete) {
      try {
        const ctx = await loadLocalContextFromCache(filterId);
        const tape = computeNextActions(ctx);
        await cacheData(
          `filter-state-${filterId}`,
          { ...updatedCacheRow, actions: tape.actions, tapeVersion: tape.tapeVersion },
          OFFLINE_TTL_MS,
        );
      } catch {
        /* tape recompute is best-effort — gate sites fall back to
           getCurrentActions which re-runs the executor on demand */
      }
    }

    if (cycleComplete) {
      await clearOfflineCycleId(filterId);
    }
  } catch (err) {
    // 21 CFR-relevant — silent failure here can leave the checklist gate
    // mis-wired offline (operator could advance past a required checklist
    // because the cache says none is pending). Deep-review fix 2026-05-17:
    // re-throw so callers can surface the error to the operator instead of
    // proceeding against a corrupted cache. The error message is structured
    // so the calling page can render a clear "offline cache recompute failed,
    // re-scan to refresh" message.
    // eslint-disable-next-line no-console -- intentional structured log
    console.error(
      '[offline-cache] recomputeAndCacheFilterState failed for',
      filterId,
      err instanceof Error ? err.message : String(err),
    );
    const wrapped = err instanceof Error ? err : new Error(String(err));
    (wrapped as Error & { code?: string }).code = 'OFFLINE_CACHE_RECOMPUTE_FAILED';
    throw wrapped;
  }
}

// ── Phase 8.7 cutover helpers ────────────────────────────────────────────────
// These hide the legacy mirror field NAMES (`pendingChecklist`, `nextAllowedStages`)
// behind helper functions so the FE pages can stop referencing them by name.
// The cache layer still POPULATES the legacy fields because:
//   1. local-context.ts synthesizes CHECKLIST_COMPLETED events based on cached
//      pendingChecklist (21 CFR — never silently skip a required checklist)
//   2. mobile-operations.tsx still reads them (cleaned up separately by agent E)
// Removing the writes is Wave 2's responsibility (server-side flag flip).

/** Subset of /current-state response we persist to the cache row. */
export interface ServerCurrentStateForCache {
  currentState?: string | null;
  currentCycle?: any;
  equipmentGroup?: any;
  blockEquipmentGroups?: any[];
  pendingChecklist?: any[];
  pipelineStages?: any[];
  pipelineGraph?: any;
  stageLookup?: Record<string, any> | null;
  nextAllowedStages?: string[];
  isPmDue?: boolean;
  pmReasonKey?: string | null;
  homeBlock?: { id: string; name: string } | null;
  blockChangeStatus?: string | null;
  actions?: Action[] | null;
  tapeVersion?: number | null;
}

/**
 * Derive the legacy `pendingChecklist[]` cache shape from a tape's
 * SUBMIT_CHECKLIST entries.
 *
 * 2026-05-26 — Issue 2 fix (online checklist appearing one stage late):
 * after Phase 8.7 the server stopped emitting `pendingChecklist` on
 * /advance + /current-state responses; only the tape carries the gate.
 * `cacheServerStateResponse` was writing `pendingChecklist: []` for every
 * online response, and `synthesizeEvents` Tier 2 then read the empty array
 * as "no gate pending" → synthesized a fake CHECKLIST_COMPLETED → local
 * tape recompute skipped SUBMIT_CHECKLIST. The dialog therefore opened on
 * the NEXT stage transition (the server's 400 reply on the second advance
 * surfaced it), not the one that just landed.
 *
 * Deriving `pendingChecklist` from the tape closes the gap without touching
 * the synthesizeEvents Tier 2 invariant (offline still works via
 * recomputeAndCacheFilterState's graph-walk derivation).
 */
function pendingChecklistFromActions(actions: Action[] | null | undefined): any[] {
  if (!Array.isArray(actions) || actions.length === 0) return [];
  const LABEL_PREFIX = 'Submit Checklist: ';
  const rows: any[] = [];
  for (const a of actions) {
    if (a.type !== 'SUBMIT_CHECKLIST') continue;
    const params = a.params;
    const name = a.label?.startsWith(LABEL_PREFIX)
      ? a.label.slice(LABEL_PREFIX.length)
      : a.label;
    rows.push({
      pipelineNodeId: `${params.afterStage}-${params.checklistProfileId}`,
      checklistProfileId: params.checklistProfileId,
      checklistProfileName: name,
      profileVersion: params.versionPin,
      questions: Array.isArray(params.questions) ? params.questions : [],
    });
  }
  return rows;
}

/**
 * Persist a /current-state server response to the `filter-state-{filterId}`
 * cache row. Replaces the inline `cache(...)` blocks in filter-operations.tsx
 * (and the equivalent block in the pre-cache loop) so those pages no longer
 * need to reference the deprecated field names by string.
 *
 * Both legacy mirrors AND the action tape are persisted — see the file header
 * for why the mirrors are still required at the cache layer.
 */
export async function cacheServerStateResponse(
  filterId: string,
  st: ServerCurrentStateForCache,
  ttlMs: number = 24 * 60 * 60 * 1000,
): Promise<void> {
  // Server stopped emitting pendingChecklist post Phase 8.7 — derive from the
  // tape so synthesizeEvents Tier 2 keeps its "empty pendingChecklist + gate
  // node present = synthesize completion" invariant correct. See
  // pendingChecklistFromActions docblock.
  const derivedPending =
    Array.isArray(st.pendingChecklist) && st.pendingChecklist.length > 0
      ? st.pendingChecklist
      : pendingChecklistFromActions(st.actions);
  await cacheData(
    `filter-state-${filterId}`,
    {
      currentState: st.currentState ?? null,
      equipmentGroup: st.equipmentGroup ?? null,
      blockEquipmentGroups: st.blockEquipmentGroups ?? [],
      pendingChecklist: derivedPending,
      pipelineStages: st.pipelineStages ?? [],
      pipelineGraph: st.pipelineGraph ?? null,
      stageLookup: st.stageLookup ?? null,
      nextAllowedStages: st.nextAllowedStages ?? [],
      isPmDue: st.isPmDue ?? false,
      pmReasonKey: st.pmReasonKey ?? null,
      currentCycle: st.currentCycle ?? null,
      homeBlock: st.homeBlock ?? null,
      blockChangeStatus: st.blockChangeStatus ?? null,
      // Persist server tape when emitted (TAPE_PARALLEL=true) so subsequent
      // gate decisions can prefer the authoritative server actions[] over a
      // locally-recomputed tape.
      actions: st.actions ?? null,
      tapeVersion: st.tapeVersion ?? null,
    },
    ttlMs,
  );
}

/**
 * Attach a derived `pendingChecklist[]` to a raw /current-state (or
 * /batch-states) response BEFORE the offline sync caches it verbatim.
 *
 * 2026-07-10 — offline checklist regression. The offline sync
 * (`offline-sync-service.ts`) caches the server state object with a raw
 * `cacheItem(...)`, bypassing `cacheServerStateResponse`. Post-Phase-8.7 the
 * server no longer emits `pendingChecklist` — only the `actions[]` tape carries
 * the checklist gate. So the synced cache row ends up with an EMPTY
 * `pendingChecklist`, and `loadLocalContextFromCache` → `synthesizeEvents`
 * Tier 2 reads "empty pendingChecklist + profile has a CHECKLIST node after the
 * current stage" as "operator already submitted" → synthesizes a fake
 * CHECKLIST_COMPLETED → the LOCAL tape recompute (the path the offline
 * interlock exemption + any stale/absent cached tape take) drops the
 * SUBMIT_CHECKLIST action → the checklist dialog never appears offline and a
 * required checklist is silently skipped (21 CFR §11). See local-context.test
 * cases #13/#14 for the exact executor behaviour this feeds.
 *
 * This mirrors the derivation `cacheServerStateResponse` already applies for
 * the online operations page. Every other field is preserved untouched; only a
 * missing/empty `pendingChecklist` is filled from the tape.
 */
export function withDerivedPendingChecklist<
  T extends { actions?: Action[] | null; pendingChecklist?: any[] },
>(state: T): T {
  if (Array.isArray(state?.pendingChecklist) && state.pendingChecklist.length > 0) {
    return state;
  }
  const derived = pendingChecklistFromActions(state?.actions);
  if (derived.length === 0) return state;
  return { ...state, pendingChecklist: derived };
}

/**
 * Read the cached pending-checklist payload that the ChecklistDialog expects.
 * Returns the raw cache row's `pendingChecklist` array (already in dialog
 * shape — see PendingChecklist interface on filter-operations.tsx).
 *
 * Used by the offline-batch-advance dialog-pop site that previously inlined
 * `cs.pendingChecklist` against a cache row. Returns [] when the row or the
 * field is missing — caller treats empty as "no checklist gate".
 */
export async function getCachedPendingChecklists(filterId: string): Promise<any[]> {
  const row = await getCachedData<CachedFilterState>(`filter-state-${filterId}`);
  if (!Array.isArray(row?.pendingChecklist)) return [];
  // Normalize `questions` to an array on every row. Older app builds cached
  // pendingChecklist rows in a shape without a `questions` key; when the
  // resolver falls back to this cache (empty inline tape questions), such a
  // row would reach the checklist dialog which does `cl.questions.map(...)`
  // and crash the whole page. Guarantee the invariant at the source.
  return row!.pendingChecklist!.map((r: any) => ({
    ...r,
    questions: Array.isArray(r?.questions) ? r.questions : [],
  }));
}

/**
 * Convert the `actions[]` tape's SUBMIT_CHECKLIST entries into the
 * `PendingChecklist[]` shape the ChecklistDialog component expects.
 *
 * Mapping:
 *   - `pipelineNodeId`: synthetic `${afterStage}-${profileId}` (matches the
 *     offline-cache fallback shape; only used as a React key in the dialog)
 *   - `checklistProfileId`: from `params.checklistProfileId`
 *   - `checklistProfileName`: stripped from the action's label
 *     (`"Submit Checklist: <name>"` → `<name>`); falls back to label as-is
 *   - `profileVersion`: from `params.versionPin` (used by submit handler for
 *     SCHEMA_DRIFT detection — `expectedProfileVersions` payload field)
 *   - `questions`: from `params.questions` (TapeQuestion shape mirrors
 *     ChecklistQuestion exactly — same id/question/questionType/required/
 *     section/description/options/sortOrder fields)
 *
 * The legacy server `pendingChecklist[]` and this derived array are
 * structurally compatible — the ChecklistDialog reads the same fields from
 * either source.
 */
const SUBMIT_CHECKLIST_LABEL_PREFIX = 'Submit Checklist: ';
export function dialogChecklistsFromActions(actions: Action[]): Array<{
  pipelineNodeId: string;
  checklistProfileId: string;
  checklistProfileName: string;
  profileVersion?: number;
  questions: any[];
}> {
  return actions
    .filter((a): a is Extract<Action, { type: 'SUBMIT_CHECKLIST' }> => a.type === 'SUBMIT_CHECKLIST')
    .map((a) => {
      const name = a.label.startsWith(SUBMIT_CHECKLIST_LABEL_PREFIX)
        ? a.label.slice(SUBMIT_CHECKLIST_LABEL_PREFIX.length)
        : a.label;
      return {
        pipelineNodeId: `${a.params.afterStage}-${a.params.checklistProfileId}`,
        checklistProfileId: a.params.checklistProfileId,
        checklistProfileName: name,
        profileVersion: a.params.versionPin,
        questions: (a.params.questions ?? []).map((q, i) => ({
          id: q.id,
          question: q.question,
          questionType: q.questionType,
          required: q.required,
          section: q.section,
          description: q.description,
          options: q.options,
          sortOrder: q.sortOrder ?? i,
        })),
      };
    });
}
