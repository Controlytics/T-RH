/**
 * Phase 8.5 — transitions.ts unit tests.
 *
 * Per-guard pass/fail coverage for the transition guards. Source error codes
 * + messages are mirrored exactly so cross-runtime parity holds.
 */
import { describe, expect, it } from 'vitest';
import {
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
  buildStageLookup,
  collectChecklistsAfterStage,
  findReachable,
  prettyStageLabel,
} from '../index.js';
import type {
  CycleSlice,
  FilterEventSlice,
  FilterSlice,
  LocalContext,
  ProfileSlice,
  StageInfo,
} from '../index.js';

// ── Fixture builders ─────────────────────────────────────────────────────

function profile(): ProfileSlice {
  return {
    id: 'p1',
    lineageId: 'l1',
    name: 'Test profile',
    flowMode: 'SEQUENTIAL',
    version: 2,
    status: 'ACTIVE',
    cleaningReasons: {},
    nodes: [
      { id: 'start', stateKey: null, nodeType: 'START', configuration: {}, sortOrder: 0 },
      { id: 's-wash-in', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
      { id: 's-wash-out', stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 2 },
      { id: 's-dry-in', stateKey: 'DRY_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 3 },
      { id: 'end', stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 4 },
    ],
    edges: [
      { fromStageId: 'start', toStageId: 's-wash-in' },
      { fromStageId: 's-wash-in', toStageId: 's-wash-out' },
      { fromStageId: 's-wash-out', toStageId: 's-dry-in' },
      { fromStageId: 's-dry-in', toStageId: 'end' },
    ],
  };
}

function profileWithChecklist(): ProfileSlice {
  const p = profile();
  p.nodes.splice(2, 0, {
    id: 'cl-after-wash-in',
    stateKey: null,
    nodeType: 'CHECKLIST',
    configuration: { checklistProfileId: 'cl-1' },
    sortOrder: 1.5,
  });
  p.edges = [
    { fromStageId: 'start', toStageId: 's-wash-in' },
    { fromStageId: 's-wash-in', toStageId: 'cl-after-wash-in' },
    { fromStageId: 'cl-after-wash-in', toStageId: 's-wash-out' },
    { fromStageId: 's-wash-out', toStageId: 's-dry-in' },
    { fromStageId: 's-dry-in', toStageId: 'end' },
  ];
  return p;
}

function cycle(overrides: Partial<CycleSlice> = {}): CycleSlice {
  return {
    id: 'c1',
    cycleCode: 'CC-1',
    filterId: 'f1',
    profileId: 'p1',
    profileVersion: 2,
    status: 'IN_PROGRESS',
    cleaningAreaId: 'block-1',
    equipmentGroupId: null,
    equipmentGroupVersionPin: null,
    checklistVersionPins: null,
    dryerStartedAt: null,
    dryerDurationMinutes: null,
    dryerReadingsSubmitted: false,
    cleaningReasonKey: 'ROUTINE',
    cleaningReasonLabel: 'Routine',
    startedAt: new Date('2026-05-02T00:00:00Z'),
    completedAt: null,
    terminatedAt: null,
    ...overrides,
  };
}

function filter(overrides: Partial<FilterSlice> = {}): FilterSlice {
  return {
    id: 'f1',
    name: 'F-1',
    parentId: null,
    filterProfileId: 'fp-1',
    currentLifecycleState: 'WASH_IN',
    currentCycleId: 'c1',
    filterSet: null,
    block: null,
    area: null,
    ahu: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<LocalContext> = {}): LocalContext {
  const p = overrides.profile ?? profile();
  return {
    profile: p,
    cycle: overrides.cycle ?? cycle(),
    events: overrides.events ?? [],
    stageLookup: overrides.stageLookup ?? buildStageLookup(p),
    filter: overrides.filter ?? filter(),
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: null,
    user: { id: 'u-1', role: 'OPERATOR', permissions: [] },
    now: Date.UTC(2026, 4, 2, 12, 0, 0),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('assertCycleActive', () => {
  it('passes when filter has currentCycleId', () => {
    const ctx = makeCtx();
    expect(assertCycleActive(ctx)).toEqual({ ok: true });
  });
  it('rejects with NO_CYCLE when currentCycleId is null', () => {
    const ctx = makeCtx({ filter: filter({ currentCycleId: null }) });
    const r = assertCycleActive(ctx);
    expect(r).toEqual({
      ok: false,
      code: 'NO_CYCLE',
      message: 'No active cleaning cycle',
    });
  });
});

describe('assertNoCycleActive', () => {
  it('rejects with CYCLE_ACTIVE when cycle is IN_PROGRESS', () => {
    const ctx = makeCtx();
    const r = assertNoCycleActive(ctx, ctx.filter);
    expect(r).toEqual({
      ok: false,
      code: 'CYCLE_ACTIVE',
      message: 'Filter already has an active cleaning cycle',
    });
  });
  it('passes when filter has no currentCycleId', () => {
    const ctx = makeCtx({ filter: filter({ currentCycleId: null }) });
    expect(assertNoCycleActive(ctx, ctx.filter)).toEqual({ ok: true });
  });
});

describe('assertProfileAssigned', () => {
  it('passes when profile id present', () => {
    expect(assertProfileAssigned(makeCtx(), 'p1')).toEqual({ ok: true });
  });
  it('rejects with NO_PROFILE when null', () => {
    const r = assertProfileAssigned(makeCtx(), null);
    expect(r).toMatchObject({ ok: false, code: 'NO_PROFILE' });
  });
});

describe('assertProfileActive', () => {
  it('passes when cp is non-null and status is ACTIVE', () => {
    expect(assertProfileActive(makeCtx(), profile())).toEqual({ ok: true });
  });
  it('rejects with PROFILE_DISABLED when null', () => {
    const r = assertProfileActive(makeCtx(), null);
    expect(r).toMatchObject({ ok: false, code: 'PROFILE_DISABLED' });
  });
  // Phase 8.6 fix — guard now also enforces status === 'ACTIVE'.
  it('rejects with PROFILE_DISABLED when status is DRAFT', () => {
    const p = profile();
    p.status = 'DRAFT';
    const r = assertProfileActive(makeCtx(), p);
    expect(r).toMatchObject({
      ok: false,
      code: 'PROFILE_DISABLED',
      message: 'Cleaning profile is disabled or not found. Contact admin to activate it.',
    });
  });
  it('rejects with PROFILE_DISABLED when status is INACTIVE', () => {
    const p = profile();
    p.status = 'INACTIVE';
    const r = assertProfileActive(makeCtx(), p);
    expect(r).toMatchObject({ ok: false, code: 'PROFILE_DISABLED' });
  });
});

describe('assertProfileEnabled (startCycle)', () => {
  it('passes when cp.status === ACTIVE', () => {
    const r = assertProfileEnabled(makeCtx(), { name: 'P', status: 'ACTIVE' });
    expect(r).toEqual({ ok: true });
  });
  it('rejects with PROFILE_DISABLED when status is not ACTIVE', () => {
    const r = assertProfileEnabled(makeCtx(), { name: 'P', status: 'DRAFT' });
    expect(r).toMatchObject({
      ok: false,
      code: 'PROFILE_DISABLED',
      message: 'Cleaning profile "P" is disabled. Contact admin to activate it.',
    });
  });
});

describe('assertChecklistGatePassed', () => {
  it('passes when no CHECKLIST nodes follow current stage', () => {
    const ctx = makeCtx();
    const r = assertChecklistGatePassed(ctx, ctx.profile, 'WASH_IN');
    expect(r).toEqual({ ok: true });
  });
  it('rejects with CHECKLIST_PENDING when checklist not answered', () => {
    const p = profileWithChecklist();
    const ctx = makeCtx({ profile: p });
    const r = assertChecklistGatePassed(ctx, p, 'WASH_IN');
    expect(r).toMatchObject({ ok: false, code: 'CHECKLIST_PENDING' });
  });
  it('passes when CHECKLIST_COMPLETED event is in events', () => {
    const p = profileWithChecklist();
    const events: FilterEventSlice[] = [
      {
        id: 'e1',
        cycleId: 'c1',
        eventType: 'CHECKLIST_COMPLETED',
        fromState: null,
        toState: null,
        performedAt: new Date(),
        attributes: { afterStage: 'WASH_IN' },
      },
    ];
    const ctx = makeCtx({ profile: p, events });
    expect(assertChecklistGatePassed(ctx, p, 'WASH_IN')).toEqual({ ok: true });
  });
  it('passes when currentState is null (pre-cycle)', () => {
    const ctx = makeCtx({ filter: filter({ currentLifecycleState: null }) });
    expect(assertChecklistGatePassed(ctx, ctx.profile, null)).toEqual({ ok: true });
  });
});

describe('assertNotCycleComplete', () => {
  it('rejects with CYCLE_COMPLETE when no reachable + END next', () => {
    const r = assertNotCycleComplete(makeCtx(), [], true);
    expect(r).toMatchObject({ ok: false, code: 'CYCLE_COMPLETE' });
  });
  it('passes when reachableStages is non-empty', () => {
    expect(assertNotCycleComplete(makeCtx(), ['DRY_IN'], true)).toEqual({ ok: true });
  });
  it('passes when no END next', () => {
    expect(assertNotCycleComplete(makeCtx(), [], false)).toEqual({ ok: true });
  });
});

describe('assertTargetStateReachable', () => {
  it('passes when target in reachable set', () => {
    const r = assertTargetStateReachable(
      makeCtx(),
      'DRY_IN',
      ['DRY_IN', 'WASH_OUT'],
      'SEQUENTIAL',
      false,
      'WASH_IN',
    );
    expect(r).toEqual({ ok: true });
  });
  it('passes when flowMode is BYPASS_ENABLED even if target out of sequence', () => {
    const r = assertTargetStateReachable(
      makeCtx(),
      'DRY_OUT',
      ['DRY_IN'],
      'BYPASS_ENABLED',
      false,
      'WASH_IN',
    );
    expect(r).toEqual({ ok: true });
  });
  it('passes when isDryerInPlace = true (DRY_IN -> DRY_IN)', () => {
    expect(
      assertTargetStateReachable(makeCtx(), 'DRY_IN', [], 'SEQUENTIAL', true, 'DRY_IN'),
    ).toEqual({ ok: true });
  });
  it('rejects with OUT_OF_SEQUENCE in normal SEQUENTIAL flow', () => {
    const r = assertTargetStateReachable(
      makeCtx(),
      'DRY_OUT',
      ['DRY_IN', 'WASH_OUT'],
      'SEQUENTIAL',
      false,
      'WASH_IN',
    );
    expect(r).toMatchObject({
      ok: false,
      code: 'OUT_OF_SEQUENCE',
      message: 'Cannot move to DRY_OUT from WASH_IN. Next allowed: DRY_IN, WASH_OUT',
    });
  });
});

describe('assertTargetStateExists', () => {
  it('passes when targetState is a STAGE node in pipeline', () => {
    const ctx = makeCtx();
    expect(assertTargetStateExists(ctx, 'WASH_IN', ctx.profile)).toEqual({ ok: true });
  });
  it('rejects with INVALID_TARGET when targetState absent', () => {
    const ctx = makeCtx();
    const r = assertTargetStateExists(ctx, 'NONEXISTENT', ctx.profile);
    expect(r).toMatchObject({
      ok: false,
      code: 'INVALID_TARGET',
      message: 'Invalid target state: NONEXISTENT',
    });
  });
});

describe('assertTapeVersionFresh', () => {
  it('passes when submittedTapeVersion is undefined (backwards compat)', () => {
    expect(assertTapeVersionFresh(makeCtx(), undefined)).toEqual({ ok: true });
  });
  it('passes when submittedTapeVersion matches profile*1M + events.length', () => {
    const ctx = makeCtx({
      cycle: cycle({ profileVersion: 2 }),
      events: [
        { id: 'e1', cycleId: 'c1', eventType: 'STATE_TRANSITION', fromState: null, toState: 'WASH_IN', performedAt: new Date(), attributes: {} },
        { id: 'e2', cycleId: 'c1', eventType: 'STATE_TRANSITION', fromState: 'WASH_IN', toState: 'DRY_IN', performedAt: new Date(), attributes: {} },
      ],
    });
    expect(assertTapeVersionFresh(ctx, 2_000_002)).toEqual({ ok: true });
  });
  it('rejects with STALE_TAPE + currentTapeVersion in details on mismatch', () => {
    const ctx = makeCtx({
      cycle: cycle({ profileVersion: 2 }),
      events: [
        { id: 'e1', cycleId: 'c1', eventType: 'STATE_TRANSITION', fromState: null, toState: 'WASH_IN', performedAt: new Date(), attributes: {} },
      ],
    });
    const r = assertTapeVersionFresh(ctx, 1_999_999);
    expect(r).toMatchObject({
      ok: false,
      code: 'STALE_TAPE',
      details: { currentTapeVersion: 2_000_001 },
    });
  });
});

describe('assertCanTransition (tape-friendly wrapper)', () => {
  it('passes when target is reachable', () => {
    const p = profile();
    const ctx = makeCtx({ profile: p });
    expect(assertCanTransition(ctx, 'WASH_OUT')).toEqual({ ok: true });
  });
  it('rejects when target not reachable from current state', () => {
    const ctx = makeCtx();
    const r = assertCanTransition(ctx, 'NONEXISTENT');
    expect(r).toMatchObject({ ok: false, code: 'OUT_OF_SEQUENCE' });
  });
});

describe('reachability helpers', () => {
  it('getReachableStages walks from current state', () => {
    const ctx = makeCtx();
    expect(getReachableStages(ctx)).toEqual(['WASH_OUT']);
  });
  it('leadsToEnd: false when forward node is STAGE', () => {
    const ctx = makeCtx();
    expect(leadsToEnd(ctx)).toBe(false);
  });
  it('leadsToEnd: true when forward node is END', () => {
    const ctx = makeCtx({ filter: filter({ currentLifecycleState: 'DRY_IN' }) });
    expect(leadsToEnd(ctx)).toBe(true);
  });
});

describe('helpers', () => {
  it('prettyStageLabel converts WASH_IN -> Wash In', () => {
    expect(prettyStageLabel('WASH_IN')).toBe('Wash In');
    expect(prettyStageLabel(null)).toBe('this stage');
  });
  it('collectChecklistsAfterStage finds CHECKLIST nodes between stages', () => {
    const p = profileWithChecklist();
    const stage = p.nodes.find(n => n.stateKey === 'WASH_IN')!;
    const checklists = collectChecklistsAfterStage(stage, p.nodes, p.edges);
    expect(checklists).toHaveLength(1);
    expect(checklists[0].id).toBe('cl-after-wash-in');
  });
  it('findReachable walks past CHECKLIST nodes', () => {
    const p = profileWithChecklist();
    const r = findReachable('s-wash-in', p.nodes, p.edges);
    expect(r.reachableStages).toEqual(['WASH_OUT']);
    expect(r.hasEndNext).toBe(false);
  });
  it('buildStageLookup builds per-stage lookup table', () => {
    const p = profile();
    const sl = buildStageLookup(p);
    expect(sl['WASH_IN']).toEqual<StageInfo>({
      nextStages: ['WASH_OUT'],
      pendingChecklistProfileIds: [],
      leadsToEnd: false,
    });
    expect(sl['DRY_IN']).toEqual<StageInfo>({
      nextStages: [],
      pendingChecklistProfileIds: [],
      leadsToEnd: true,
    });
  });
  it('buildStageLookup includes checklistProfileIds when CHECKLIST follows', () => {
    const p = profileWithChecklist();
    const sl = buildStageLookup(p);
    expect(sl['WASH_IN'].pendingChecklistProfileIds).toEqual(['cl-1']);
  });
});
