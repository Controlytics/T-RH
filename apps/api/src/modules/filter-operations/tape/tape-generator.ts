/**
 * Decision-tape generator — Phase 8.5 Commit 2 thin wrapper.
 *
 * Body moved to `packages/shared/src/pipeline-executor/actions.ts`. This file
 * is now an adapter that converts the legacy `TapeInput` shape into a
 * `LocalContext` projection and delegates to `computeNextActions(ctx)`.
 *
 * Why keep this file at all:
 *   - The existing service (filter-operations.service.ts:756-800) already
 *     builds a fully-resolved TapeInput. Converting it to LocalContext on
 *     every getCurrentState() call is cheap; rewiring the service in this
 *     commit would mix Commit 2 + Commit 3 concerns.
 *   - The existing tape-generator + tape-parity tests assert against
 *     `generateTape()` directly. Keeping the function name preserves those
 *     tests unchanged — pure refactor, zero behavior change.
 *   - `computeTapeVersion` is re-exported for callers (filter-operations.service.ts
 *     `assertTapeVersionFresh`) that compute the version without going through
 *     the tape generator.
 *
 * Phase 8.5 Commit 3 rewrites the service to call the shared executor
 * directly via `loadLocalContext(filterId)`; at that point this wrapper can
 * be deleted.
 */
import {
  computeNextActions,
  computeTapeVersion,
  type ChecklistProfileSlice,
  type CycleSlice,
  type EquipmentGroupSlice,
  type FilterEventSlice,
  type FilterSlice,
  type LocalContext,
  type ProfileSlice,
} from '@digilog/shared';
import type { ActionTape, TapeInput } from './types.js';

/**
 * Adapt the legacy TapeInput to a LocalContext + per-call options the shared
 * executor consumes. Pure projection — no I/O.
 */
function inputToLocalContext(input: TapeInput): {
  ctx: LocalContext;
  checklistProfilesById: Map<string, ChecklistProfileSlice>;
} {
  const profile: ProfileSlice = input.pinnedProfile
    ? {
        id: input.pinnedProfile.id,
        lineageId: '', // not surfaced on TapeInput; not read by computeNextActions
        name: input.pinnedProfile.name,
        flowMode: input.pinnedProfile.flowMode,
        version: input.cycle?.profileVersion ?? 0,
        status: 'ACTIVE',
        cleaningReasons: {},
        nodes: input.pinnedProfile.stages,
        edges: input.pinnedProfile.connections,
      }
    : ({
        // Sentinel "no profile" — computeNextActions short-circuits to
        // [TERMINATE] when status !== 'ACTIVE' triggers the no-cycle / no-profile
        // branch. We pass an explicitly-empty profile so the type-check holds;
        // the ctx.profile null-check inside computeNextActions handles emission.
        id: '',
        lineageId: '',
        name: '',
        flowMode: 'SEQUENTIAL',
        version: 0,
        status: 'INACTIVE',
        cleaningReasons: {},
        nodes: [],
        edges: [],
      } as ProfileSlice);

  const cycle: CycleSlice = input.cycle
    ? {
        id: input.cycle.id,
        cycleCode: '',
        filterId: input.filter.id,
        profileId: input.cycle.profileId,
        profileVersion: input.cycle.profileVersion,
        status: input.cycle.status,
        cleaningAreaId: input.cycle.cleaningAreaId,
        equipmentGroupId: input.cycle.equipmentGroupId,
        equipmentGroupVersionPin: input.cycle.equipmentGroupVersionPin,
        checklistVersionPins: input.cycle.checklistVersionPins,
        dryerStartedAt: input.cycle.dryerStartedAt,
        dryerDurationMinutes: input.cycle.dryerDurationMinutes,
        dryerReadingsSubmitted: input.cycle.dryerReadingsSubmitted,
        cleaningReasonKey: '',
        cleaningReasonLabel: '',
        startedAt: new Date(0),
        completedAt: null,
        terminatedAt: null,
      }
    : ({
        // Sentinel "no cycle" — status='NONE' so the in-progress check
        // short-circuits to empty actions[] in the executor.
        id: '',
        cycleCode: '',
        filterId: input.filter.id,
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
      } as CycleSlice);

  const filter: FilterSlice = {
    id: input.filter.id,
    name: '',
    parentId: null,
    filterProfileId: null,
    currentLifecycleState: input.filter.currentLifecycleState,
    currentCycleId: input.cycle?.id ?? null,
    filterSet: null,
    block: null,
    area: null,
    ahu: null,
  };

  const equipmentGroup: EquipmentGroupSlice | null = input.pinnedEquipmentGroup
    ? {
        id: input.pinnedEquipmentGroup.id,
        name: '',
        blockId: '',
        isActive: true,
        version: input.pinnedEquipmentGroup.version,
        instruments: input.pinnedEquipmentGroup.instruments,
      }
    : null;

  // Synthesize CHECKLIST_COMPLETED events from recentChecklistEvents — the
  // executor reads from ctx.events.
  const events: FilterEventSlice[] = input.recentChecklistEvents.map((e, i) => ({
    id: `synthetic-${i}`,
    cycleId: input.cycle?.id ?? null,
    eventType: e.eventType,
    fromState: null,
    toState: null,
    performedAt: input.now,
    attributes: e.attributes as Record<string, unknown>,
  }));

  // Pad events array length to match TapeInput.filterEventCount so the
  // computed tapeVersion stays exactly aligned with the legacy formula.
  while (events.length < input.filterEventCount) {
    events.push({
      id: `synthetic-pad-${events.length}`,
      cycleId: input.cycle?.id ?? null,
      eventType: 'STATE_TRANSITION',
      fromState: null,
      toState: null,
      performedAt: input.now,
      attributes: {},
    });
  }

  const checklistProfilesById = new Map<string, ChecklistProfileSlice>();
  for (const [id, p] of input.pinnedChecklistProfiles) {
    checklistProfilesById.set(id, {
      id,
      name: p.name ?? '(unnamed)',
      isActive: true,
      version: p.versionPin,
      questions: p.questions,
    });
  }

  const ctx: LocalContext = {
    profile,
    cycle,
    events,
    stageLookup: {}, // not read by computeNextActions
    filter,
    equipmentGroup,
    checklistProfile: null,
    assetTemplate: null,
    user: { id: '', role: '', permissions: [] },
    now: input.now.getTime(),
  };

  return { ctx, checklistProfilesById };
}

/**
 * Pure-function tape generator — adapter to the shared executor.
 *
 * Output shape + ordering + tapeVersion formula identical to the Phase 8.0
 * implementation. Existing tape-generator + tape-parity tests pass unchanged.
 */
export function generateTape(input: TapeInput): ActionTape {
  const { ctx, checklistProfilesById } = inputToLocalContext(input);
  return computeNextActions(ctx, { checklistProfilesById });
}

export { computeTapeVersion };
