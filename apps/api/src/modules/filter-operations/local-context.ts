/**
 * Server-side LocalContext loader (Phase 8.5 Commit 3).
 *
 * Builds a `LocalContext` from prisma reads — the input shape every shared
 * pure-guard takes. The four write methods in `filter-operations.service.ts`
 * call this once at the top, then drop in shared guard calls instead of the
 * inline checks they used to carry.
 *
 * Scope: this loads the **base** context — the slices every guard touches.
 * Method-specific resolution (resolveChecklistQuestions for submitChecklist;
 * EquipmentGroupVersion sidecar lookup for advance) stays in the service
 * BETWEEN the base load and the transaction. Trying to make this loader
 * universal would do wasted I/O for terminateCycle and produce a 500-line
 * builder.
 *
 * Slices NOT loaded here (the methods don't read them, or load them
 * conditionally):
 *   - assetTemplate: writes don't read it.
 *   - checklistProfile: resolved per-method (live vs pinned versions diverge).
 *   - equipmentGroup: resolved per-method (sidecar version pin path is
 *     advance()-specific and skips the rest of getCurrentState's fallback
 *     resolution).
 */
import type {
  LocalContext,
  CycleSlice,
  FilterEventSlice,
  FilterSlice,
  ProfileSlice,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import type { RequestContext } from '../../types/context.js';

/**
 * Output of the loader. The bundled `cp` (raw Prisma profile row, with
 * `stages`/`connections` named matching the schema) is what the service used
 * to read directly — surfaced here so methods can keep using the same
 * variable shape inside transactions.
 */
export interface LoadedLocalContext {
  /** The pure shared executor input. */
  ctx: LocalContext;
  /**
   * The raw `FilterCleaningProfile` row Prisma returned (with
   * `stages` + `connections` arrays). Methods need this for txn writes that
   * key off the live row (e.g. equipment-group sidecar lookup).
   *
   * `null` when the filter has no resolved profile (writes that require a
   * profile must guard on this before proceeding).
   */
  cp: Awaited<ReturnType<typeof loadCleaningProfile>>;
  /** The raw `CleaningCycle` row from prisma — used for txn writes. */
  rawCycle: Awaited<ReturnType<typeof loadCycle>>;
  /** Convenience: `filter.currentCycleId` (matching service's existing local var). */
  filterCurrentCycleId: string | null;
}

async function loadCleaningProfile(profileId: string | null) {
  if (!profileId) return null;
  // Resolve FilterProfile -> cleaningProfileId, OR direct CleaningProfile.
  const fp = await prisma.filterProfile.findUnique({ where: { id: profileId } });
  const cleaningProfileId = fp ? fp.cleaningProfileId : profileId;
  return prisma.filterCleaningProfile.findUnique({
    where: { id: cleaningProfileId },
    include: { stages: { orderBy: { sortOrder: 'asc' } }, connections: true },
  });
}

async function loadCycle(currentCycleId: string | null) {
  if (!currentCycleId) return null;
  return prisma.cleaningCycle.findUnique({ where: { id: currentCycleId } });
}

/**
 * Load + project the prisma rows into LocalContext slices.
 *
 * - `events` is loaded via `findMany` (not `count`) so `ctx.events.length`
 *   carries the real cycle event count for shared `assertTapeVersionFresh`,
 *   AND so guards that walk events (`assertChecklistGatePassed`) see the
 *   real per-event attributes.
 * - When the filter has no active cycle, a `status='NONE'` sentinel cycle
 *   is returned (LocalContext.cycle is non-optional). Shared
 *   `assertCycleActive` fail-closes against a missing currentCycleId so
 *   the sentinel is consumed safely.
 */
export async function loadLocalContext(
  filterId: string,
  ctx: RequestContext,
): Promise<LoadedLocalContext> {
  // ─── Filter (with FilterDetails sidecar) ─────────────────────────────────
  const inst = await prisma.assetInstance.findFirst({
    where: { id: filterId },
    select: {
      id: true,
      name: true,
      parentId: true,
      filterDetails: {
        select: {
          filterProfileId: true,
          currentLifecycleState: true,
          currentCycleId: true,
          filterSet: true,
        },
      },
    },
  });
  if (!inst) {
    // Mirror the existing service.getFilter() behaviour.
    throw new AppError(404, 'NOT_FOUND', 'Filter not found');
  }

  const filterCurrentCycleId = inst.filterDetails?.currentCycleId ?? null;

  // ─── Cycle + events (parallel) ────────────────────────────────────────────
  const [rawCycle, rawEvents] = await Promise.all([
    loadCycle(filterCurrentCycleId),
    filterCurrentCycleId
      ? prisma.filterEvent.findMany({
          where: { filterId, cycleId: filterCurrentCycleId },
          orderBy: { performedAt: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  // ─── Profile resolution (matches resolveFilterProfile + getProfilePipeline) ─
  // Direct assignment first; falls back to config-driven assignment when
  // available (mirrors service.resolveFilterProfile()). For writes the cycle
  // is the source of truth — pin to cycle.profileId once a cycle exists.
  let resolvedProfileId: string | null = null;
  if (rawCycle?.profileId) {
    resolvedProfileId = rawCycle.profileId;
  } else if (inst.filterDetails?.filterProfileId) {
    resolvedProfileId = inst.filterDetails.filterProfileId;
  }
  // If neither, the caller's guard `assertProfileAssigned` will reject; we
  // don't fall through to the config-rule path here because writes that
  // need the config path (only startCycle does) handle it themselves.

  const cp = await loadCleaningProfile(resolvedProfileId);

  // ─── Project to slices ────────────────────────────────────────────────────
  const profileSlice: ProfileSlice = cp
    ? {
        id: cp.id,
        lineageId: (cp as { lineageId?: string }).lineageId ?? '',
        name: cp.name,
        flowMode: cp.flowMode,
        version: cp.version ?? 0,
        status: cp.status,
        cleaningReasons: cp.cleaningReasons ?? {},
        nodes: cp.stages.map(s => ({
          id: s.id,
          stateKey: s.stateKey ?? null,
          nodeType: s.nodeType,
          configuration: (s.configuration as Record<string, unknown>) ?? {},
          sortOrder: s.sortOrder,
        })),
        edges: cp.connections.map(c => ({
          fromStageId: c.fromStageId,
          toStageId: c.toStageId,
        })),
      }
    : {
        // Sentinel — `assertProfileActive` / `assertProfileAssigned` reject
        // before any guard tries to walk these arrays.
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

  const cycleSlice: CycleSlice = rawCycle
    ? {
        id: rawCycle.id,
        cycleCode: rawCycle.cycleCode ?? '',
        filterId: rawCycle.filterId,
        profileId: rawCycle.profileId,
        profileVersion: rawCycle.profileVersion ?? 0,
        status: rawCycle.status,
        cleaningAreaId: rawCycle.cleaningAreaId ?? null,
        equipmentGroupId: rawCycle.equipmentGroupId ?? null,
        equipmentGroupVersionPin: rawCycle.equipmentGroupVersionPin ?? null,
        checklistVersionPins:
          (rawCycle.checklistVersionPins as Record<string, number> | null) ?? null,
        dryerStartedAt: rawCycle.dryerStartedAt ?? null,
        dryerDurationMinutes: rawCycle.dryerDurationMinutes ?? null,
        dryerReadingsSubmitted: !!rawCycle.dryerReadingsSubmitted,
        cleaningReasonKey: rawCycle.cleaningReasonKey ?? '',
        cleaningReasonLabel: rawCycle.cleaningReasonLabel ?? '',
        startedAt: rawCycle.startedAt,
        completedAt: rawCycle.completedAt ?? null,
        terminatedAt: (rawCycle as { terminatedAt?: Date | null }).terminatedAt ?? null,
      }
    : {
        // Sentinel "no cycle" — status='NONE' so guards short-circuit.
        id: '',
        cycleCode: '',
        filterId,
        profileId: '',
        profileVersion: 0,
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

  const events: FilterEventSlice[] = rawEvents.map(e => ({
    id: e.id,
    cycleId: e.cycleId,
    eventType: e.eventType,
    fromState: e.fromState ?? null,
    toState: e.toState ?? null,
    performedAt: e.performedAt,
    attributes: (e.attributes as Record<string, unknown>) ?? {},
  }));

  const filterSlice: FilterSlice = {
    id: inst.id,
    name: inst.name ?? '',
    parentId: inst.parentId ?? null,
    filterProfileId: inst.filterDetails?.filterProfileId ?? null,
    currentLifecycleState: inst.filterDetails?.currentLifecycleState ?? null,
    currentCycleId: filterCurrentCycleId,
    filterSet: inst.filterDetails?.filterSet ?? null,
    block: null,
    area: null,
    ahu: null,
  };

  const localCtx: LocalContext = {
    profile: profileSlice,
    cycle: cycleSlice,
    events,
    stageLookup: {}, // not read by write-method guards; built by getCurrentState
    filter: filterSlice,
    equipmentGroup: null, // resolved per-method when needed
    checklistProfile: null, // resolved per-method when needed
    assetTemplate: null, // not read by write-method guards
    user: {
      id: ctx.userSub ?? ctx.userId ?? '',
      role: ctx.userRole ?? '',
      permissions: [],
    },
    now: Date.now(),
  };

  return {
    ctx: localCtx,
    cp,
    rawCycle,
    filterCurrentCycleId,
  };
}

/**
 * Maps a shared GuardResult error code to the HTTP status code the existing
 * service uses. Mirrors the literal `throw new AppError(STATUS, CODE, ...)`
 * pairs in filter-operations.service.ts so the existing API surface stays
 * byte-identical.
 *
 * Codes not in the map default to 400 — that's what every unmapped Phase-8.5
 * inventory code resolves to in the original throws.
 */
export function deriveStatusCode(code: string): number {
  switch (code) {
    case 'STALE_TAPE':
    case 'SCHEMA_DRIFT':
    case 'ALREADY_SUBMITTED':
    case 'STATE_CHANGED':
    case 'CYCLE_CHANGED':
    case 'CYCLE_ACTIVE':
    case 'GROUP_VERSION_MISSING':
      return 409;
    case 'BYPASS_FORBIDDEN':
      return 403;
    default:
      return 400;
  }
}

/**
 * Helper: convert a shared `GuardResult` into a thrown `AppError` (only when
 * `ok === false`). Lets each method body do `throwIfFailed(executor.assertX(...))`
 * inline without repeating the same five-line block.
 */
export function throwIfFailed(
  result: { ok: true } | { ok: false; code: string; message: string; details?: Record<string, unknown> },
): void {
  if (result.ok) return;
  throw new AppError(
    deriveStatusCode(result.code),
    result.code,
    result.message,
    result.details,
  );
}
