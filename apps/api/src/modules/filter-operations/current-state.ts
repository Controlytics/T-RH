/**
 * Filter Operations — getCurrentState() + getBatchStates() implementations.
 *
 * The read-side that the FE polls every cycle event. Returns the full server
 * snapshot: live cycle, pipeline graph, equipment group (frozen-snapshot
 * when pinned, else live), block-change status, PM-due flag,
 * profile/equipment-group sync warnings, stageLookup (offline cache feed),
 * and the action tape (Phase 8.7 cutover — `actions[]` + `tapeVersion`
 * always emitted; `nextAllowedStages` and `pendingChecklist` are NOT
 * returned — they remain locally computed only because the tape generator
 * needs `pendingChecklist` to seed `pinnedChecklistProfiles`).
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { generateTape } from './tape/tape-generator.js';
import type { TapeChecklistProfile } from './tape/types.js';
import {
  collectChecklistsAfterStage,
  resolveChecklistQuestions,
} from './helpers.js';
import {
  getFilter,
  getFilterHomeBlock,
  getNextStageKeys,
  extractBlocks,
  resolveFilterProfile,
} from './filter-resolver.js';
import {
  getInterlockConfig,
  isInterlockStage,
  getApproverRoleForStage,
  getLatestApproval,
  collectFilterApprovalDetails,
  requestStageApprovalTx,
  notifyStageApprovalRequested,
} from './stage-interlock.js';
import type { FilterOperationsService } from './filter-operations.service.js';
import { createBatchReadCache, type BatchReadCache } from './batch-cache.js';

/**
 * Resolve the operator who performed a gated stage, for attributing a lazily
 * self-healed stage approval (see getCurrentStateImpl). Prefers the
 * STATE_TRANSITION into the stage; falls back to the cycle starter. Returns an
 * empty sub when no event is found (caller skips the self-heal — we won't
 * fabricate an approval we can't attribute, since requestedBy must be a real
 * user for segregation-of-duties to mean anything).
 */
async function resolveStagePerformer(cycleId: string, stageKey: string): Promise<{ sub: string; name: string; enteredOffline: boolean }> {
  // Match the event that moved the filter INTO this stage via EITHER a normal
  // advance (STATE_TRANSITION) or a bypass (BYPASS_DEVIATION) — a filter can reach
  // a gated stage by either path, and both must be exemptable when offline.
  const entry = await prisma.filterEvent.findFirst({
    where: { cycleId, eventType: { in: ['STATE_TRANSITION', 'BYPASS_DEVIATION'] }, toState: stageKey },
    orderBy: { performedAt: 'desc' },
    select: { performedBy: true, attributes: true },
  });
  // Was the entry INTO this gated stage performed offline? (advance.ts / bypass.ts
  // stamp attributes.__offlineEntry=true on offline-performed entries.) Offline
  // work is never interlock-gated, so the self-heal must not create an approval.
  const enteredOffline = (entry?.attributes as any)?.__offlineEntry === true;
  const starter = entry
    ? null
    : await prisma.filterEvent.findFirst({
        where: { cycleId, eventType: 'CYCLE_STARTED' },
        orderBy: { performedAt: 'desc' },
        select: { performedBy: true },
      });
  const sub = entry?.performedBy ?? starter?.performedBy ?? '';
  if (!sub) return { sub: '', name: 'unknown', enteredOffline };
  const u = await prisma.user.findUnique({ where: { id: sub }, select: { username: true } });
  return { sub, name: u?.username ?? 'unknown', enteredOffline };
}

/**
 * Batch: get current-state for all active filters in the user's org.
 * Returns { states: { [filterId]: stateObject } } for offline caching.
 */
export async function getBatchStatesImpl(
  service: FilterOperationsService,
  ctx: RequestContext,
  cleaningAreaId?: string,
) {
  const filters = await prisma.assetInstance.findMany({
    where: {
      isActive: true,
      status: { not: 'Retired' },
      template: { templateKind: 'FILTER' },
    },
    select: { id: true },
  });

  // Audit 2026-05-05 fix #5: parallelize the per-filter getCurrentState calls
  // in bounded chunks. Pre-fix sequential loop was N+1: each getCurrentState
  // does ~10 sequential prisma reads. For a site with 500 filters that was
  // 5000+ queries serialized end-to-end — operators saw multi-second hangs
  // on offline-cache-warmup. Chunk size 10 keeps the prisma pool steady
  // (default 10 connections) while cutting total wall time ~10×.
  //
  // M39 (2026-07-15): that fix cut wall time but not query VOLUME — measured at
  // 3,099 Prisma reads for 199 active filters (15.6/filter) on the tablet's
  // offline-cache-warmup hot path. Most of those were the SAME rows read once per
  // filter: the interlock + profile-assignment + cleaning-reason configs, the ~51
  // shared cleaning-profile pipelines, each AHU's PM entry, and the shared
  // ancestors every home-block walk climbs. A batch-scoped read memo collapses
  // them to one apiece. The per-filter projection is untouched — getCurrentState
  // still produces byte-identical output (locked by the D5 parity test).
  const cache = createBatchReadCache();
  const CHUNK_SIZE = 10;
  const states: Record<string, any> = {};
  for (let i = 0; i < filters.length; i += CHUNK_SIZE) {
    const chunk = filters.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(
      chunk.map(f => service.getCurrentState(ctx, f.id, cleaningAreaId, cache)),
    );
    for (let j = 0; j < chunk.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled') states[chunk[j].id] = r.value;
      // rejected (no profile assigned, etc.) is silently skipped — same
      // semantics as the pre-fix try/catch loop.
    }
  }
  return { states, cachedAt: new Date().toISOString() };
}

export async function getCurrentStateImpl(
  service: FilterOperationsService,
  ctx: RequestContext,
  filterId: string,
  cleaningAreaId?: string,
  // M39: set ONLY by getBatchStates, which shares one memo across the whole fan-out.
  // Undefined on the single-filter path (the FE's per-event poll), which therefore
  // behaves exactly as before — no cross-request caching, no staleness window.
  cache?: BatchReadCache,
) {
  const filter = await getFilter(filterId, ctx);

  let currentCycle = null;
  if (filter.currentCycleId) {
    currentCycle = await prisma.cleaningCycle.findUnique({ where: { id: filter.currentCycleId } });
  }

  // Stage interlock state. `gatedStage` is STATIC (config-driven) so the offline
  // client can cache it and stop at a gated stage without knowing the dynamic
  // approval status. `blocksLeaving` is dynamic — true until the latest approval
  // for (cycle, stage) is APPROVED — and drives both the actions[] post-filter
  // below and the operator-facing banner. Computed once; reused for stageLookup.
  const interlockConfig = await getInterlockConfig(cache);
  const interlockStateKey = filter.currentLifecycleState;
  const interlockGatedHere = interlockConfig.enabled && isInterlockStage(interlockStateKey);
  let interlockLatest: { id: string; status: string } | null = null;
  if (interlockGatedHere && currentCycle) {
    const stageKey = interlockStateKey as string;
    const row = await getLatestApproval(currentCycle.id, stageKey);
    interlockLatest = row ? { id: row.id, status: row.status } : null;

    // Self-heal: a filter parked at a gated stage with NO approval means the
    // interlock was enabled AFTER it advanced into the stage (advance.ts never
    // created the approval). Lazily create the PENDING approval now so it shows
    // in the approver inbox instead of dead-ending the operator. Attributed to
    // the operator who actually performed the stage (from the event log), NOT the
    // poller — so segregation-of-duties (approver ≠ performer) still holds. Runs
    // under the same FOR UPDATE lock advance uses, so concurrent polls / an
    // in-flight advance can't create duplicate PENDINGs. Fires once: later polls
    // see the PENDING and skip. (Also runs during getBatchStates warmup.)
    //
    // OFFLINE EXEMPTION (2026-06-15, per user): never self-heal during an offline
    // replay. getCurrentState runs at the end of each replayed advance/bypass; if
    // it backfilled here it would re-create the exact PENDING approval that
    // advance.ts intentionally skipped for offline work, leaving a stuck request
    // after the filter has already moved past the gated stage.
    if (!interlockLatest && !ctx.isOfflineReplay) {
      const performer = await resolveStagePerformer(currentCycle.id, stageKey);
      // OFFLINE EXEMPTION (2026-07-10, per user): never self-heal an approval for a
      // filter that reached this gated stage OFFLINE. Closes the sync-window race
      // where an online poll catches a filter transiently parked at the gate
      // between two offline-op replays and manufactures a PENDING approval the
      // operator never needed. Online-reached stages (incl. interlock-enabled-
      // after-advance) still self-heal normally.
      if (performer.sub && !performer.enteredOffline) {
        const snapshot = await collectFilterApprovalDetails(filterId);
        const approverRole = getApproverRoleForStage(stageKey, interlockConfig);
        const created = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM filter_details WHERE asset_instance_id = ${filterId}::uuid FOR UPDATE`;
          return requestStageApprovalTx(tx, {
            cycleId: currentCycle!.id,
            filterId,
            stageKey,
            approverRole,
            detailsSnapshot: snapshot,
            ctx: { ...ctx, userSub: performer.sub, userId: performer.name },
          });
        });
        if (created) {
          interlockLatest = { id: created.id, status: 'PENDING' };
          await notifyStageApprovalRequested(
            { id: created.id, filterId, stageKey, approverRole },
            snapshot.filterName,
            ctx,
          );
        }
      }
    }
  }
  const interlockBlocksLeaving = interlockGatedHere && interlockLatest?.status !== 'APPROVED';
  const interlock = interlockGatedHere
    ? {
        gatedStage: true,
        stageKey: interlockStateKey,
        status: interlockLatest?.status ?? null,
        approvalId: interlockLatest?.id ?? null,
        approverRole: getApproverRoleForStage(interlockStateKey as string, interlockConfig),
        blocksLeaving: interlockBlocksLeaving,
      }
    : null;

  // Pre-compute block-change state so the mobile UI can show the request
  // popup BEFORE asking for a wash-in reason, not as a background error
  // after submission. This is purely informational — validateBlockChange()
  // remains the authoritative enforcement point inside startCycle.
  //
  // Audit 2026-05-05 fix #9: skip the homeBlock query mid-cycle. The
  // block-change popup is only useful pre-start; once a cycle is in
  // progress the operator can't change blocks. Pre-fix this query ran on
  // every /current-state poll regardless of cycle state — wasted DB
  // round-trip per poll per filter, and /current-state is the hot path
  // (FE polls it after every cycle write + on visibility change + every
  // 60s background sync).
  let homeBlock: { id: string; name: string } | null = null;
  // 2026-06-09: cross-block is CONFIGURABLE (config mode CONFIRM | APPROVAL), online-only.
  //   'MATCH'    = same block (nothing to do)
  //   'CONFIRM'  = CONFIRM mode, different block → FE shows "Continue with cleaning?"
  //   'REQUIRED' = APPROVAL mode, different block, no approval yet → FE shows request dialog
  //   'APPROVED' = APPROVAL mode, different block, an approval exists → proceed
  // Offline: the FE ignores this and just shows an informational notice (never gates).
  let blockChangeStatus: 'MATCH' | 'CONFIRM' | 'REQUIRED' | 'APPROVED' | null = null;
  let blockChangeMode: 'NONE' | 'CONFIRM' | 'APPROVAL' = 'CONFIRM';
  if (!filter.currentCycleId) {
    const homeBlockRaw = await getFilterHomeBlock(filterId, cache);
    homeBlock = homeBlockRaw ? { id: homeBlockRaw.blockId, name: homeBlockRaw.blockName } : null;
  }
  if (!filter.currentCycleId && cleaningAreaId && homeBlock) {
    if (homeBlock.id === cleaningAreaId) {
      blockChangeStatus = 'MATCH';
    } else {
      const { blockChangeService } = await import('../block-change-requests/block-change.service.js');
      // M39: one config-backed mode, shared by every filter in the batch.
      blockChangeMode = cache
        ? await cache.memo('block-change-mode', () => blockChangeService.getMode())
        : await blockChangeService.getMode();
      if (blockChangeMode === 'NONE') {
        // No cross-block check — treat a different block as a clean MATCH so the
        // FE never prompts (online or via cached state offline). This MATCH also
        // lets the offline client skip its own block-change force without needing
        // the config cached on-device.
        blockChangeStatus = 'MATCH';
      } else if (blockChangeMode === 'APPROVAL') {
        blockChangeStatus = (await blockChangeService.hasApproval(filterId, cleaningAreaId)) ? 'APPROVED' : 'REQUIRED';
      } else {
        blockChangeStatus = 'CONFIRM';
      }
    }
  }

  // PM auto-reason check: if this filter's AHU currently has a PM schedule
  // entry whose tolerance window contains `now`, the mobile/desktop UI can
  // skip the wash-in reason dialog and auto-fill "PM" as the cleaning reason.
  // Pure read — no writes. Only computed for new cycles (skipping when a
  // cycle is already in progress).
  let isPmDue = false;
  let pmReasonKey: string | null = null;
  if (!filter.currentCycleId) {
    // M39: `parent:` projection — shared with the BY_BLOCK walk in filter-resolver.
    const readParent = () => prisma.assetInstance.findUnique({
      where: { id: filterId },
      select: { parentId: true },
    });
    const filterRow = cache ? await cache.memo(`parent:${filterId}`, readParent) : await readParent();
    if (filterRow?.parentId) {
      const now = new Date();
      // M39: keyed by the AHU (parentId), not the filter — every filter under an
      // AHU asks the same question. `now` is not part of the key: a batch is a
      // point-in-time snapshot, and the sub-second spread across one fan-out
      // cannot straddle a PM tolerance window boundary in any meaningful way.
      const ahuId = filterRow.parentId;
      const readDueEntry = () => prisma.pmScheduleEntry.findFirst({
        where: {
          schedule: { entityId: ahuId, status: 'ACTIVE' },
          windowStart: { lte: now },
          windowEnd: { gte: now },
        },
        orderBy: { plannedDate: 'asc' },
        select: { id: true },
      });
      const dueEntry = cache ? await cache.memo(`pm-due:${ahuId}`, readDueEntry) : await readDueEntry();
      if (dueEntry) {
        isPmDue = true;
        // Look up the configured PM reason — must be active, and match
        // either key === 'PM' (exact), or name === 'PM', case-insensitive.
        const readReasons = () => prisma.systemConfig.findUnique({ where: { configKey: 'filter-cleaning-reasons' } });
        const reasonsCfg = cache ? await cache.memo('cfg:filter-cleaning-reasons', readReasons) : await readReasons();
        const raw = reasonsCfg?.configValue as any;
        const reasons: any[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
        const pmReason = reasons.find(r =>
          r && r.isActive !== false && (
            (typeof r.key === 'string' && r.key.toUpperCase() === 'PM') ||
            (typeof r.name === 'string' && r.name.toUpperCase() === 'PM')
          )
        );
        if (pmReason?.key) pmReasonKey = pmReason.key;
      }
    }
  }

  let profile = null;
  let nextAllowedStages: string[] = [];
  let nextBlocks: any[] = [];
  let pendingChecklist: any[] = [];

  // L2 (2026-05-02): when an in-progress cycle exists, render the pipeline
  // from the CYCLE's pinned profileId (FilterCleaningProfile.id, set at cycle
  // start and immutable post-A.2 rowful versioning). NOT from the live
  // FilterProfile binding — that may have been reassigned mid-cycle (via
  // admin block-assignment config edit) and produces a visual mismatch
  // between the rendered stages and what advance() actually enforces.
  //
  // The existing profileSyncWarning at :~553-577 detects the mismatch and
  // tells the operator to TERMINATE_AND_RESTART; with L2 the operator's
  // displayed pipeline now matches what they're actually being held to,
  // so the warning becomes "rules changed; terminate to use the new ones"
  // rather than "your view is wrong."
  //
  // Pre-cycle path (no currentCycle): use the live binding so the operator
  // sees what they'd start a cycle against.
  const resolvedProfileId = await resolveFilterProfile(filter, cache);
  const pinnedCycleProfileId = currentCycle?.profileId ?? null;
  const profileIdForRender = pinnedCycleProfileId ?? resolvedProfileId;
  // Goes through the service.getProfilePipeline indirection so tests that
  // monkey-patch the spy still intercept (get-current-state.test.ts:143).
  //
  // M39: memoised HERE rather than by threading `cache` into getProfilePipeline —
  // the spy is asserted with exact args (`toHaveBeenCalledWith(id, false)`), so a
  // third argument would break it. 199 filters resolve to ~51 distinct profiles,
  // and each call is 2 reads (FilterProfile + FilterCleaningProfile w/ stages +
  // connections), so this is the single biggest saving after the ancestor walks.
  const loadPipeline = () => (service as any).getProfilePipeline(profileIdForRender, false);
  const cp = profileIdForRender
    ? await (cache ? cache.memo(`pipeline:${profileIdForRender}`, loadPipeline) : loadPipeline())
    : null; // getCurrentState shows pipeline even if disabled

  if (cp) {
        profile = { name: cp.name, flowMode: cp.flowMode };

        if (currentCycle && filter.currentLifecycleState) {
          const currentStage = cp.stages.find((s: any) => s.stateKey === filter.currentLifecycleState);
          if (currentStage) {
            // Check for CHECKLIST nodes directly after current stage
            const checklistNodes = collectChecklistsAfterStage(currentStage, cp.stages, cp.connections);

            if (checklistNodes.length > 0) {
              // Check if checklists have already been answered for this stage in this cycle.
              //
              // Audit 2026-05-04 fix C3 parity (same shape that submit-checklist.ts:179
              // already mitigates): `equals: undefined` collapses to "no JSON filter at
              // all" in Prisma, which would match every CHECKLIST_COMPLETED for the
              // cycle — including ones for other stages — and falsely mark the gate as
              // satisfied. Use Prisma's explicit JSON-null match (`equals: null`) so a
              // stage-null event row is matched correctly and stage-other rows are not.
              const answeredEvent = await prisma.filterEvent.findFirst({
                where: {
                  filterId,
                  cycleId: currentCycle.id,
                  eventType: 'CHECKLIST_COMPLETED',
                  attributes: { path: ['afterStage'], equals: filter.currentLifecycleState ?? (null as any) },
                },
              });

              if (!answeredEvent) {
                // Checklists pending — resolve via cycle's pinned versions (Phase A.1).
                // currentCycle is in scope here.
                const pins = (currentCycle?.checklistVersionPins ?? null) as Record<string, number> | null;
                pendingChecklist = await resolveChecklistQuestions(checklistNodes, pins);
                if (pendingChecklist.length > 0) {
                  // Active checklists pending — block until completed
                  nextAllowedStages = [];
                } else {
                  // All checklist profiles disabled — skip checklists, show next stages
                  for (const cl of checklistNodes) {
                    nextAllowedStages.push(...getNextStageKeys(cl.id, cp.stages, cp.connections));
                  }
                  nextBlocks = extractBlocks(cp.stages.filter((s: any) => nextAllowedStages.some(key => cp.stages.find((st: any) => st.stateKey === key)?.id === s.id)));
                }
              } else {
                // Checklists done — walk past checklist nodes to find next STAGE nodes
                for (const cl of checklistNodes) {
                  nextAllowedStages.push(...getNextStageKeys(cl.id, cp.stages, cp.connections));
                }
                const reachableFromChecklists = new Set<string>();
                for (const cl of checklistNodes) {
                  const outConns = cp.connections.filter((c: any) => c.fromStageId === cl.id);
                  outConns.forEach((c: any) => reachableFromChecklists.add(c.toStageId));
                }
                const nextStages = cp.stages.filter((s: any) => reachableFromChecklists.has(s.id));
                nextBlocks = extractBlocks(nextStages);
              }
            } else {
              // No checklist — normal flow
              nextAllowedStages = getNextStageKeys(currentStage.id, cp.stages, cp.connections);
              const outConns = cp.connections.filter((c: any) => c.fromStageId === currentStage.id);
              const nextStageIds = outConns.map((c: any) => c.toStageId);
              const nextStages = cp.stages.filter((s: any) => nextStageIds.includes(s.id));
              nextBlocks = extractBlocks(nextStages);
            }
          }
        } else {
          const startNode = cp.stages.find((s: any) => s.nodeType === 'START');
          if (startNode) {
            nextAllowedStages = getNextStageKeys(startNode.id, cp.stages, cp.connections);
          }
        }
  }

  // M39: per-filter, so a plain memo can't dedupe it — but it IS batch-shaped.
  // Under getBatchStates, load every filter's cycle count in ONE groupBy the
  // first time any filter asks, then serve the rest from the map (199 → 1).
  // A filter with no cycles is absent from the groupBy, hence `?? 0` — which is
  // exactly what count() returns for it, so both paths agree.
  const totalCycles = cache
    ? (await cache.memo('cycle-counts-by-filter', async () => {
        const rows = await prisma.cleaningCycle.groupBy({
          by: ['filterId'],
          _count: { _all: true },
        });
        return new Map(rows.map(r => [r.filterId, r._count._all]));
      })).get(filterId) ?? 0
    : await prisma.cleaningCycle.count({ where: { filterId } });

  const pipelineStages = cp
    ? cp.stages.filter((s: any) => s.nodeType === "STAGE").map((s: any) => ({ stateKey: s.stateKey, nodeType: s.nodeType, sortOrder: s.sortOrder, configuration: s.configuration }))
    : [];

  // Full pipeline graph for offline nextAllowedStages computation
  const pipelineGraph = cp
    ? {
        stages: cp.stages.map((s: any) => ({ id: s.id, stateKey: s.stateKey, nodeType: s.nodeType, sortOrder: s.sortOrder, configuration: s.configuration })),
        connections: cp.connections.map((c: any) => ({ fromStageId: c.fromStageId, toStageId: c.toStageId })),
        flowMode: cp.flowMode,
      }
    : null;

  // Include equipment group info if cycle has one selected.
  //
  // L1 (2026-05-02): when the cycle pinned a version (cycle.equipmentGroupVersionPin
  // is set, P1), return the FROZEN SNAPSHOT from EquipmentGroupVersion instead of
  // the live row. Closes the operator-visible drift surface where the FE rendered
  // dropdowns from live operating ranges but server validation in advance() rejected
  // against the pinned ranges. Field shape preserved so the existing tablet/web
  // (and the deployed APK) consume the response unchanged.
  //
  // Resolution order, mirroring the canonical lazy-first-version logic from
  // advance() reading-validation (~:1101-1175):
  //   1. Pin set + snapshot row exists  -> reconstruct from snapshot.
  //   2. Pin set + snapshot row missing  -> fall back to live row IFF live.version === pin
  //      (the lazy first-version case — live row IS v1 until the first edit creates
  //      its archive). Mismatch is logged but not thrown here (this is a read
  //      endpoint; advance() is where the 409 GROUP_VERSION_MISSING fires).
  //   3. Pin null (legacy cycle started pre-P1) -> live row.
  //   4. No cycle group at all -> block-fallback below (unchanged).
  let equipmentGroup: any = null;
  if (currentCycle?.equipmentGroupId) {
    const pin = currentCycle.equipmentGroupVersionPin;
    if (pin !== null && pin !== undefined) {
      const versionRow = await prisma.equipmentGroupVersion.findUnique({
        where: { groupId_versionNumber: { groupId: currentCycle.equipmentGroupId, versionNumber: pin } },
      });
      if (versionRow) {
        const snap = versionRow.snapshot as { name?: string; blockId?: string; isActive?: boolean; instruments?: any[] };
        equipmentGroup = {
          id: currentCycle.equipmentGroupId,
          name: snap.name ?? null,
          blockId: snap.blockId ?? null,
          isActive: snap.isActive ?? true,
          version: pin,
          instruments: (snap.instruments ?? []).slice().sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
        };
      } else {
        // Lazy first-version: snapshot only exists after the first admin edit.
        // Live row IS the pinned version when versions match.
        const liveGroup = await prisma.equipmentGroup.findUnique({
          where: { id: currentCycle.equipmentGroupId },
          include: { instruments: { orderBy: { sortOrder: 'asc' } } },
        });
        if (liveGroup && liveGroup.version === pin) {
          equipmentGroup = liveGroup;
        } else {
          // Audit 2026-05-05 fix #6: pin and live diverge but no snapshot
          // row exists. Pre-fix returned the live row with just a console.warn
          // — operators saw the WRONG instrument operating ranges in the UI
          // dropdowns and only learned of the mismatch when advance() finally
          // threw 409 GROUP_VERSION_MISSING after they had typed values.
          //
          // Now: still return the live row so the UI doesn't break, BUT
          // surface a `equipmentGroupSnapshotMissing` flag in the response.
          // The dropdowns can disable submission until operator resolves
          // (terminate-and-restart on the new version, or admin re-saves
          // the live group to materialize the snapshot).
          console.warn(
            `[getCurrentState] equipmentGroupVersionPin=${pin} but neither snapshot row exists nor does live.version match for group ${currentCycle.equipmentGroupId} (cycle ${currentCycle.id}). Returning live row + snapshotMissing flag.`,
          );
          equipmentGroup = liveGroup
            ? { ...liveGroup, snapshotMissing: true, pinnedVersion: pin, liveVersion: liveGroup.version }
            : null;
        }
      }
    } else {
      // Legacy cycle (pre-P1, pin never written). Live row is correct here —
      // documented drift gap, kept only for backwards compatibility.
      equipmentGroup = await prisma.equipmentGroup.findUnique({
        where: { id: currentCycle.equipmentGroupId },
        include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      });
    }
  }
  // Fallback: if cycle has no equipment group but has a cleaning area (block),
  // return the first active equipment group for that block so the UI can surface
  // instrument operating ranges (e.g. dryer temperature dropdown). No cycle pin
  // applies here — the cycle hasn't bound a group yet.
  if (!equipmentGroup && currentCycle?.cleaningAreaId) {
    equipmentGroup = await prisma.equipmentGroup.findFirst({
      where: { blockId: currentCycle.cleaningAreaId, isActive: true },
      include: { instruments: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  // If no equipment group resolved but block is known, return all active groups
  // for that block so the frontend can offer a selector (or auto-pick the only one).
  let blockEquipmentGroups: any[] = [];
  if (!equipmentGroup && currentCycle?.cleaningAreaId) {
    blockEquipmentGroups = await prisma.equipmentGroup.findMany({
      where: { blockId: currentCycle.cleaningAreaId, isActive: true },
      include: { instruments: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  // B.7 — Per-stage lookup table the offline client uses without reconstructing
  // server logic. For every STAGE node in the pipeline, pre-compute:
  //   - nextStages: array of stateKey strings reachable next
  //   - pendingChecklistProfileIds: ids of CHECKLIST nodes that fire after this
  //     stage (client uses cached checklist-profiles to render questions offline)
  //   - leadsToEnd: true if no more stages follow
  // The client just looks this up after each successful offline advance instead
  // of walking the graph itself (which has historically drifted from server).
  const stageLookup: Record<string, { nextStages: string[]; pendingChecklistProfileIds: string[]; leadsToEnd: boolean; interlockGated: boolean }> = {};
  if (cp) {
    for (const s of cp.stages) {
      if (s.nodeType !== 'STAGE' || !s.stateKey) continue;
      const checklistNodes = collectChecklistsAfterStage(s, cp.stages, cp.connections);
      // NOTE: The canonical `executor.findReachable` helper would replace
      // this inline walker — but the helper takes shared TapeStage[]
      // / TapeConnection[] types, and `cp` here is the Prisma-shape
      // pipeline (loaded via `service.getProfilePipeline`), not the
      // projected `localCtx.profile` available in cycle-write impls. To
      // share the helper we'd need either an `as any` cast (anti-pattern,
      // defeats the cleanup) or a structural projection layer — both bigger
      // than this commit's scope. The duplicate-walker dedup landed in
      // advance.ts + submit-checklist.ts (both have `localCtx` in scope).
      const nextSet = new Set<string>();
      let leadsToEnd = false;
      const collectStagesPast = (nodeId: string, visited: Set<string>) => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        const outConns = cp!.connections.filter((c: any) => c.fromStageId === nodeId);
        for (const conn of outConns) {
          const next = cp!.stages.find((n: any) => n.id === conn.toStageId);
          if (!next) continue;
          if (next.nodeType === 'STAGE' && next.stateKey) nextSet.add(next.stateKey);
          else if (next.nodeType === 'END') leadsToEnd = true;
          else if (next.nodeType === 'CHECKLIST') collectStagesPast(next.id, visited);
        }
      };
      collectStagesPast(s.id, new Set());
      stageLookup[s.stateKey] = {
        nextStages: [...nextSet],
        pendingChecklistProfileIds: checklistNodes.map((n: any) => (n.configuration as any)?.checklistProfileId).filter(Boolean),
        leadsToEnd,
        // Static interlock flag — the OFFLINE client uses this to stop at a gated
        // stage (WASH_OUT/DRY_OUT) since it can't reach an approver offline.
        interlockGated: interlockConfig.enabled && isInterlockStage(s.stateKey),
      };
    }
  }

  // Stale-profile detection: if the in-progress cycle is bound to a profile
  // that no longer matches what the live block-assignment config says,
  // surface a warning so the operator can terminate-and-restart on the
  // current profile instead of silently continuing on the wrong pipeline.
  // L3 (2026-05-02): advisory warning when admin has edited the cycle's pinned
  // EquipmentGroup. Read-only — actual readings still validate against the
  // pinned snapshot (P1 + L1). Useful for transparency: operator sees that
  // the live config has moved on and can decide whether to terminate-and-
  // restart on the new operating ranges, or finish the cycle on the pinned
  // ones. Symmetric to profileSyncWarning but for the equipment group, not
  // the cleaning recipe.
  let equipmentGroupSyncWarning: { groupId: string; pinnedVersion: number; liveVersion: number; recommendation: 'CONTINUE_OR_TERMINATE_AND_RESTART' } | null = null;
  if (currentCycle?.equipmentGroupId && currentCycle.equipmentGroupVersionPin !== null && currentCycle.equipmentGroupVersionPin !== undefined) {
    const liveGroup = await prisma.equipmentGroup.findUnique({
      where: { id: currentCycle.equipmentGroupId },
      select: { version: true },
    });
    if (liveGroup && liveGroup.version > currentCycle.equipmentGroupVersionPin) {
      equipmentGroupSyncWarning = {
        groupId: currentCycle.equipmentGroupId,
        pinnedVersion: currentCycle.equipmentGroupVersionPin,
        liveVersion: liveGroup.version,
        recommendation: 'CONTINUE_OR_TERMINATE_AND_RESTART',
      };
    }
  }

  let profileSyncWarning: { cycleProfileId: string; cycleProfileName: string | null; expectedProfileId: string; expectedProfileName: string | null; recommendation: 'TERMINATE_AND_RESTART' } | null = null;
  if (currentCycle && resolvedProfileId) {
    const cycleProfileId: string = currentCycle.profileId;
    // resolvedProfileId is what the live config + filter assignment resolves to
    // (FilterProfile id OR CleaningProfile id directly). Normalize both sides.
    // M39: `norm:` projection — resolves a FilterProfile id to its CleaningProfile
    // id. Filters sharing a profile ask this the same way, so memoise per id.
    const normalize = async (id: string): Promise<string> => {
      const read = () => prisma.filterProfile.findUnique({ where: { id }, select: { cleaningProfileId: true } });
      const fp = cache ? await cache.memo(`norm:${id}`, read) : await read();
      return fp ? fp.cleaningProfileId : id;
    };
    const liveCpId = await normalize(resolvedProfileId);
    const cycleCpId = await normalize(cycleProfileId);
    if (liveCpId !== cycleCpId) {
      const [liveCp, cycleCp] = await Promise.all([
        prisma.filterCleaningProfile.findUnique({ where: { id: liveCpId }, select: { name: true } }),
        prisma.filterCleaningProfile.findUnique({ where: { id: cycleCpId }, select: { name: true } }),
      ]);
      profileSyncWarning = {
        cycleProfileId: cycleCpId,
        cycleProfileName: cycleCp?.name ?? null,
        expectedProfileId: liveCpId,
        expectedProfileName: liveCp?.name ?? null,
        recommendation: 'TERMINATE_AND_RESTART',
      };
    }
  }

  // Phase 8.7 (decision-tape cutover): tape generation is now unconditional.
  // The FE consumes `actions[]` + `tapeVersion` directly; the deprecated
  // `nextAllowedStages` and `pendingChecklist` fields are no longer emitted
  // (Wave 1 commits 1fa84b5 desktop + 2521aad mobile dropped FE reads).
  //
  // The tape is built from the data we already resolved above —
  // `pendingChecklist` (still computed locally as input to the tape, not
  // returned) carries the per-profile questions snapshot we need to feed
  // `pinnedChecklistProfiles` without an extra prisma round-trip.
  const pinnedChecklistProfiles = new Map<string, TapeChecklistProfile>();
  for (const pc of pendingChecklist) {
    if (typeof pc?.checklistProfileId !== 'string') continue;
    pinnedChecklistProfiles.set(pc.checklistProfileId, {
      profileId: pc.checklistProfileId,
      versionPin: typeof pc.profileVersion === 'number' ? pc.profileVersion : 1,
      name: pc.checklistProfileName ?? undefined,
      questions: Array.isArray(pc.questions) ? pc.questions : [],
    });
  }

  // Recent CHECKLIST_COMPLETED events for THIS cycle (used by the generator
  // to walk past every stage's checklist gate) AND total event count for
  // this cycle (used to derive a tapeVersion that changes on every cycle
  // event, STATE_TRANSITION included, not just checklist completions).
  //
  // M6 (Phase 8.0 review follow-up): run the two prisma reads in parallel
  // — they're independent, so the sequential await pair was an unnecessary
  // round-trip.
  const [recentChecklistEvents, filterEventCount] = currentCycle
    ? await Promise.all([
        prisma.filterEvent.findMany({
          where: { filterId: filter.id, cycleId: currentCycle.id, eventType: 'CHECKLIST_COMPLETED' },
          select: { eventType: true, attributes: true },
        }),
        prisma.filterEvent.count({ where: { filterId: filter.id, cycleId: currentCycle.id } }),
      ])
    : [[] as Array<{ eventType: string; attributes: unknown }>, 0];

  const tape = generateTape({
    cycle: currentCycle
      ? {
          id: currentCycle.id,
          profileId: currentCycle.profileId,
          profileVersion: currentCycle.profileVersion ?? 0,
          status: currentCycle.status,
          cleaningAreaId: currentCycle.cleaningAreaId ?? null,
          equipmentGroupId: currentCycle.equipmentGroupId ?? null,
          equipmentGroupVersionPin: currentCycle.equipmentGroupVersionPin ?? null,
          checklistVersionPins: (currentCycle.checklistVersionPins as Record<string, number> | null) ?? null,
          dryerStartedAt: currentCycle.dryerStartedAt ?? null,
          dryerDurationMinutes: currentCycle.dryerDurationMinutes ?? null,
          dryerReadingsSubmitted: !!currentCycle.dryerReadingsSubmitted,
        }
      : null,
    filter: { id: filter.id, currentLifecycleState: filter.currentLifecycleState },
    pinnedProfile: cp
      ? {
          id: cp.id,
          name: cp.name,
          flowMode: cp.flowMode,
          stages: cp.stages.map((s: any) => ({ id: s.id, stateKey: s.stateKey ?? null, nodeType: s.nodeType, configuration: (s.configuration as Record<string, unknown>) ?? {}, sortOrder: s.sortOrder })),
          connections: cp.connections.map((c: any) => ({ fromStageId: c.fromStageId, toStageId: c.toStageId })),
        }
      : null,
    pinnedEquipmentGroup: equipmentGroup
      ? {
          id: equipmentGroup.id,
          version: equipmentGroup.version ?? 1,
          instruments: (equipmentGroup.instruments ?? []).map((i: any) => ({
            id: i.id, description: i.description, instrumentId: i.instrumentId,
            stageKey: i.stageKey, uom: i.uom, operatingMin: i.operatingMin,
            operatingMax: i.operatingMax, leastCount: i.leastCount, sortOrder: i.sortOrder,
          })),
        }
      : null,
    pinnedChecklistProfiles,
    recentChecklistEvents: recentChecklistEvents.map((e: any) => ({
      eventType: 'CHECKLIST_COMPLETED' as const,
      attributes: (e.attributes ?? {}) as { afterStage?: string | null;[k: string]: unknown },
    })),
    filterEventCount,
    now: new Date(),
  });
  let actions = tape.actions;
  const tapeVersion = tape.tapeVersion;

  // Stage interlock — suppress the LEAVE actions out of a gated stage until the
  // latest approval is APPROVED. The online client renders actions[] directly, so
  // dropping these hides the advance/bypass buttons; the next poll re-enables them
  // the instant approval lands. The server gate (advance/bypass) is the backstop;
  // the offline client relies on stageLookup.interlockGated instead.
  if (interlockBlocksLeaving) {
    actions = actions.filter(
      (a: any) =>
        !(
          (a.type === 'ADVANCE_TO_STAGE' || a.type === 'BYPASS_STAGE') &&
          a.params?.targetState !== interlockStateKey
        ),
    );
  }

  return {
    filterId: filter.id,
    filterName: filter.name,
    currentState: filter.currentLifecycleState,
    currentCycle,
    nextBlocks,
    pipelineStages,
    pipelineGraph,
    profile,
    filterSet: filter.filterSet,
    totalCycles,
    equipmentGroup,
    blockEquipmentGroups,
    homeBlock,
    blockChangeStatus,
    blockChangeMode,
    isPmDue,
    pmReasonKey,
    profileSyncWarning,
    equipmentGroupSyncWarning, // L3 (2026-05-02)
    stageLookup,
    interlock, // stage interlock display state (null unless current stage is gated)
    actions,
    tapeVersion,
  };
}
