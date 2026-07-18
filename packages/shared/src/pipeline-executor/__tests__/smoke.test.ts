/**
 * Pipeline-executor smoke tests (Phase 8.5).
 *
 * Scope: barrel-export verification + LocalContext type compile.
 *   1. LocalContext fixture compiles against the type (catches shape
 *      regressions across runtimes).
 *   2. The barrel re-exports each guard the inventory promised — accidental
 *      drops in `index.ts` fail compile.
 *   3. `computeNextActions` is the only remaining stub (Commit 2 territory).
 *
 * Per-module unit tests live in sibling files (transitions.test.ts,
 * checklist.test.ts, dryer.test.ts, …).
 */
import { describe, it, expect } from 'vitest';
import {
  // Transitions
  assertCycleActive,
  assertNoCycleActive,
  assertProfileAssigned,
  assertProfileActive,
  assertProfileEnabled,
  assertChecklistGatePassed,
  assertNotCycleComplete,
  assertTargetStateReachable,
  assertTargetStateExists,
  assertTapeVersionFresh,
  assertCanTransition,
  getReachableStages,
  leadsToEnd,
  collectChecklistsAfterStage,
  findReachable,
  buildStageLookup,
  prettyStageLabel,
  // Checklist
  assertChecklistSchemaFresh,
  assertRequiredChecklistAnswered,
  assertChecklistAnswerKeysValid,
  // Dryer
  assertDryerActionValid,
  assertDryerDurationValid,
  assertInDryInForReadings,
  assertDryerStarted,
  assertDryerHalfTimeElapsed,
  assertDryerHalfTimeBeforeLeavingDryIn,
  // Instruments
  assertEquipmentGroupValid,
  assertInstrumentReadingRequired,
  assertInstrumentReadingValid,
  assertInstrumentReadingInRange,
  assertAllInstrumentReadings,
  assertSingleEquipmentGroupPerBlock,
  assertEquipmentGroupSelected,
  assertEquipmentGroupVersionExists,
  // Bypass
  assertBypassAllowed,
  assertBypassTargetStateValid,
  assertCanBypassTo,
  // Justification
  assertJustificationValid,
  // Parameters
  assertParametersRequired,
  assertParametersInRange,
  extractParameterDefs,
  // Tape
  computeNextActions,
  computeTapeVersion,
  // Context
  loadLocalContext,
  loadLocalContextFromCache,
} from '../index.js';
import type {
  LocalContext,
  GuardResult,
  ValidationResult,
  StageInfo,
  ProfileSlice,
  CycleSlice,
  FilterSlice,
} from '../index.js';

// ── Type-compile fixture ─────────────────────────────────────────────────

function makeFixture(): LocalContext {
  const profile: ProfileSlice = {
    id: 'profile-1',
    lineageId: 'lineage-1',
    name: 'Standard Cleaning',
    flowMode: 'BYPASS_ENABLED',
    version: 3,
    status: 'ACTIVE',
    cleaningReasons: { keys: ['ROUTINE', 'PM'] },
    nodes: [
      { id: 'n1', stateKey: null, nodeType: 'START', configuration: {}, sortOrder: 0 },
      { id: 'n2', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
      { id: 'n3', stateKey: 'DRY_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 2 },
      { id: 'n4', stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 3 },
    ],
    edges: [
      { fromStageId: 'n1', toStageId: 'n2' },
      { fromStageId: 'n2', toStageId: 'n3' },
      { fromStageId: 'n3', toStageId: 'n4' },
    ],
  };
  const cycle: CycleSlice = {
    id: 'cycle-1',
    cycleCode: 'C-2026-001',
    filterId: 'filter-1',
    profileId: profile.id,
    profileVersion: profile.version,
    status: 'IN_PROGRESS',
    cleaningAreaId: 'block-1',
    equipmentGroupId: 'eg-1',
    equipmentGroupVersionPin: 4,
    checklistVersionPins: { 'cl-1': 2 },
    dryerStartedAt: null,
    dryerDurationMinutes: null,
    dryerReadingsSubmitted: false,
    cleaningReasonKey: 'ROUTINE',
    cleaningReasonLabel: 'Routine cleaning',
    startedAt: new Date('2026-05-02T10:00:00Z'),
    completedAt: null,
    terminatedAt: null,
  };
  const filter: FilterSlice = {
    id: 'filter-1',
    name: 'F-Block-A-1',
    parentId: 'ahu-1',
    filterProfileId: 'fp-1',
    currentLifecycleState: 'WASH_IN',
    currentCycleId: cycle.id,
    filterSet: 'PRIMARY',
    block: { id: 'block-1', name: 'Block A', templateKind: 'BLOCK' },
    area: { id: 'area-1', name: 'Area 1', templateKind: 'AREA' },
    ahu: { id: 'ahu-1', name: 'AHU-1', templateKind: 'AHU' },
  };
  const stageLookup: Record<string, StageInfo> = {
    WASH_IN: { nextStages: ['DRY_IN'], pendingChecklistProfileIds: [], leadsToEnd: false },
    DRY_IN: { nextStages: [], pendingChecklistProfileIds: [], leadsToEnd: true },
  };
  return {
    profile,
    cycle,
    events: [],
    stageLookup,
    filter,
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: null,
    user: { id: 'u-1', role: 'OPERATOR', permissions: ['FILTER_OPERATE'] },
    now: Date.UTC(2026, 4, 2, 11, 0, 0),
  };
}

describe('pipeline-executor scaffold (Phase 8.5)', () => {
  it('LocalContext fixture compiles against the type', () => {
    const ctx = makeFixture();
    expect(ctx.profile.nodes).toHaveLength(4);
    expect(ctx.cycle.status).toBe('IN_PROGRESS');
    expect(ctx.filter.currentLifecycleState).toBe('WASH_IN');
    expect(ctx.stageLookup['DRY_IN']?.leadsToEnd).toBe(true);
    expect(typeof ctx.now).toBe('number');
  });

  it('GuardResult / ValidationResult discriminated unions narrow correctly', () => {
    const ok: GuardResult = { ok: true };
    if (ok.ok) {
      expect(ok.ok).toBe(true);
    }
    const fail: GuardResult = { ok: false, code: 'X', message: 'y' };
    if (!fail.ok) {
      expect(fail.code).toBe('X');
      expect(fail.message).toBe('y');
    }
    const vfail: ValidationResult = {
      ok: false,
      failures: [{ field: 'foo', code: 'BAD', message: 'no' }],
    };
    if (!vfail.ok) {
      expect(vfail.failures).toHaveLength(1);
    }
  });
});

describe('pipeline-executor barrel exports the expected names', () => {
  it('all guard symbols are functions', () => {
    const fns = [
      // transitions
      assertCycleActive,
      assertNoCycleActive,
      assertProfileAssigned,
      assertProfileActive,
      assertProfileEnabled,
      assertChecklistGatePassed,
      assertNotCycleComplete,
      assertTargetStateReachable,
      assertTargetStateExists,
      assertTapeVersionFresh,
      assertCanTransition,
      getReachableStages,
      leadsToEnd,
      collectChecklistsAfterStage,
      findReachable,
      buildStageLookup,
      prettyStageLabel,
      // checklist
      assertChecklistSchemaFresh,
      assertRequiredChecklistAnswered,
      assertChecklistAnswerKeysValid,
      // dryer
      assertDryerActionValid,
      assertDryerDurationValid,
      assertInDryInForReadings,
      assertDryerStarted,
      assertDryerHalfTimeElapsed,
      assertDryerHalfTimeBeforeLeavingDryIn,
      // instruments
      assertEquipmentGroupValid,
      assertInstrumentReadingRequired,
      assertInstrumentReadingValid,
      assertInstrumentReadingInRange,
      assertAllInstrumentReadings,
      assertSingleEquipmentGroupPerBlock,
      assertEquipmentGroupSelected,
      assertEquipmentGroupVersionExists,
      // bypass
      assertBypassAllowed,
      assertBypassTargetStateValid,
      assertCanBypassTo,
      // justification
      assertJustificationValid,
      // parameters
      assertParametersRequired,
      assertParametersInRange,
      extractParameterDefs,
      // tape
      computeNextActions,
      computeTapeVersion,
      // context
      loadLocalContext,
      loadLocalContextFromCache,
    ];
    for (const fn of fns) {
      expect(typeof fn).toBe('function');
    }
  });
});

describe('pipeline-executor — context-loaders deliberately remain stubs', () => {
  it('computeNextActions returns a tape with actions[] + tapeVersion (Phase 8.5 Commit 2 filled this in)', () => {
    const ctx = makeFixture();
    const result = computeNextActions(ctx);
    expect(result).toHaveProperty('actions');
    expect(Array.isArray(result.actions)).toBe(true);
    expect(typeof result.tapeVersion).toBe('number');
  });
  it('loadLocalContext still rejects (real impl lives in apps/api)', async () => {
    await expect(loadLocalContext('filter-1')).rejects.toThrow(/^NOT_IMPLEMENTED/);
  });
  it('loadLocalContextFromCache still rejects (real impl lives in apps/web)', async () => {
    await expect(loadLocalContextFromCache('filter-1')).rejects.toThrow(/^NOT_IMPLEMENTED/);
  });
});
