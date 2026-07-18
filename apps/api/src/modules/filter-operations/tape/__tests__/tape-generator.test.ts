import { describe, it, expect, beforeEach } from 'vitest';
import { generateTape, computeTapeVersion } from '../tape-generator.js';
import type {
  TapeCycle,
  TapeChecklistEvent,
  TapeChecklistProfile,
  TapeInput,
  TapeInstrument,
  TapePinnedProfile,
  TapeStage,
} from '../types.js';

/**
 * Phase 8.0 — pure-function unit tests for generateTape().
 *
 * No mocks. No prisma. Hand-built TapeInput. The test cases mirror the
 * action-emission rules documented in tape-generator.ts and enforced by
 * filter-operations.service.ts (getCurrentState + advance).
 */

// ── fixture helpers ────────────────────────────────────────────────────────

let nextId = 0;
const id = () => `node-${++nextId}`;

function stage(stateKey: string | null, nodeType: string, configuration: Record<string, unknown> = {}): TapeStage {
  return { id: id(), stateKey, nodeType, configuration };
}

/** Build a minimal SEQUENTIAL pipeline: START → WASH_IN → DRY_IN → END. */
function simpleProfile(): TapePinnedProfile {
  nextId = 0;
  const start = stage(null, 'START');
  const washIn = stage('WASH_IN', 'STAGE');
  const dryIn = stage('DRY_IN', 'STAGE');
  const end = stage(null, 'END');
  return {
    id: 'profile-1',
    name: 'Simple',
    flowMode: 'SEQUENTIAL',
    stages: [start, washIn, dryIn, end],
    connections: [
      { fromStageId: start.id, toStageId: washIn.id },
      { fromStageId: washIn.id, toStageId: dryIn.id },
      { fromStageId: dryIn.id, toStageId: end.id },
    ],
  };
}

/** Pipeline with a checklist between WASH_IN and WASH_OUT. */
function checklistProfile(checklistProfileId = 'cl-prof-1'): TapePinnedProfile {
  nextId = 0;
  const start = stage(null, 'START');
  const washIn = stage('WASH_IN', 'STAGE');
  const cl = stage(null, 'CHECKLIST', { checklistProfileId });
  const washOut = stage('WASH_OUT', 'STAGE');
  const end = stage(null, 'END');
  return {
    id: 'profile-cl',
    name: 'CL',
    flowMode: 'SEQUENTIAL',
    stages: [start, washIn, cl, washOut, end],
    connections: [
      { fromStageId: start.id, toStageId: washIn.id },
      { fromStageId: washIn.id, toStageId: cl.id },
      { fromStageId: cl.id, toStageId: washOut.id },
      { fromStageId: washOut.id, toStageId: end.id },
    ],
  };
}

function cycleFx(overrides: Partial<TapeCycle> = {}): TapeCycle {
  return {
    id: 'cyc-1',
    profileId: 'profile-1',
    profileVersion: 1,
    status: 'IN_PROGRESS',
    cleaningAreaId: 'block-1',
    equipmentGroupId: 'grp-1',
    equipmentGroupVersionPin: 1,
    checklistVersionPins: null,
    dryerStartedAt: null,
    dryerDurationMinutes: null,
    dryerReadingsSubmitted: false,
    ...overrides,
  };
}

function instr(stageKey: string, idStr: string, opts: Partial<TapeInstrument> = {}): TapeInstrument {
  return { id: idStr, stageKey, operatingMin: 0, operatingMax: 100, sortOrder: 0, ...opts };
}

function inputFx(overrides: Partial<TapeInput> = {}): TapeInput {
  return {
    cycle: cycleFx(),
    filter: { id: 'f-1', currentLifecycleState: null },
    pinnedProfile: simpleProfile(),
    pinnedEquipmentGroup: null,
    pinnedChecklistProfiles: new Map(),
    recentChecklistEvents: [],
    filterEventCount: 0,
    now: new Date('2026-05-02T10:00:00Z'),
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('generateTape() — pure-function action emission', () => {
  // M4 (Phase 8.0 review follow-up): reset module-level `nextId` between tests
  // so the file is concurrency-safe under `test.concurrent` and so test order
  // changes don't leak ids between cases. Defense-in-depth — the fixture
  // helpers (`simpleProfile`, `checklistProfile`) already reset on entry.
  beforeEach(() => {
    nextId = 0;
  });

  // ── 1. No-cycle / not-in-progress paths ─────────────────────────────────
  it('1. no cycle → empty actions[] (cycle-start is via /start-cycle, not the tape)', () => {
    const tape = generateTape(inputFx({ cycle: null }));
    expect(tape.actions).toEqual([]);
    expect(tape.state).toBeNull();
  });

  it('2. cycle.status !== IN_PROGRESS → empty actions[]', () => {
    const tape = generateTape(inputFx({ cycle: cycleFx({ status: 'COMPLETED' }) }));
    expect(tape.actions).toEqual([]);
  });

  // ── 2. TERMINATE_CYCLE always available while in-progress ──────────────
  it('3. cycle in progress, no profile → only TERMINATE_CYCLE emitted', () => {
    const tape = generateTape(inputFx({ pinnedProfile: null }));
    expect(tape.actions).toHaveLength(1);
    expect(tape.actions[0]).toMatchObject({ type: 'TERMINATE_CYCLE', requiresJustification: { minLength: 10 } });
  });

  it('4. TERMINATE_CYCLE always present when cycle in progress (regardless of state)', () => {
    const profile = simpleProfile();
    const tape = generateTape(inputFx({
      pinnedProfile: profile,
      filter: { id: 'f-1', currentLifecycleState: 'WASH_IN' },
    }));
    expect(tape.actions.some(a => a.type === 'TERMINATE_CYCLE')).toBe(true);
  });

  // ── 3. ADVANCE_TO_STAGE emission ───────────────────────────────────────
  it('5. fresh cycle (no current state) → ADVANCE_TO_STAGE for first STAGE after START', () => {
    const tape = generateTape(inputFx());
    const advances = tape.actions.filter(a => a.type === 'ADVANCE_TO_STAGE') as any[];
    expect(advances).toHaveLength(1);
    expect(advances[0].params.targetState).toBe('WASH_IN');
    expect(advances[0].label).toBe('Advance to Wash In');
  });

  it('6. ADVANCE_TO_STAGE includes requiresInstrumentReadings when target stage has instruments', () => {
    const tape = generateTape(inputFx({
      pinnedEquipmentGroup: { id: 'grp-1', version: 1, instruments: [
        instr('WASH_IN', 'inst-A', { operatingMin: 5, operatingMax: 15, sortOrder: 0 }),
        instr('WASH_IN', 'inst-B', { operatingMin: 60, operatingMax: 80, sortOrder: 1 }),
      ] },
    }));
    const adv = tape.actions.find(a => a.type === 'ADVANCE_TO_STAGE') as any;
    expect(adv.params.requiresInstrumentReadings).toEqual(['inst-A', 'inst-B']);
    expect(adv.validations.operatingRanges).toEqual({
      'inst-A': { min: 5, max: 15 },
      'inst-B': { min: 60, max: 80 },
    });
  });

  it('7. ADVANCE_TO_STAGE has NO requiresInstrumentReadings when target stage has none', () => {
    const tape = generateTape(inputFx({
      pinnedEquipmentGroup: { id: 'grp-1', version: 1, instruments: [
        instr('DRY_IN', 'd1'), // wrong stage
      ] },
    }));
    const adv = tape.actions.find(a => a.type === 'ADVANCE_TO_STAGE') as any;
    expect(adv.params.requiresInstrumentReadings).toBeUndefined();
    expect(adv.validations).toBeUndefined();
  });

  // ── 4. SUBMIT_CHECKLIST blocking gate ──────────────────────────────────
  it('8. pending checklist after current stage → SUBMIT_CHECKLIST emitted, no ADVANCE_TO_STAGE', () => {
    const checklist: TapeChecklistProfile = {
      profileId: 'cl-prof-1',
      versionPin: 7,
      name: 'Wash QA',
      questions: [{ id: 'q1', question: 'Tank empty?', questionType: 'YES_NO', required: true, section: null, description: null, options: [], validation: {}, sortOrder: 0 }],
    };
    const tape = generateTape(inputFx({
      pinnedProfile: checklistProfile('cl-prof-1'),
      filter: { id: 'f-1', currentLifecycleState: 'WASH_IN' },
      pinnedChecklistProfiles: new Map([['cl-prof-1', checklist]]),
    }));
    const submits = tape.actions.filter(a => a.type === 'SUBMIT_CHECKLIST') as any[];
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({
      type: 'SUBMIT_CHECKLIST',
      blocking: true,
      params: { checklistProfileId: 'cl-prof-1', versionPin: 7, afterStage: 'WASH_IN' },
    });
    expect(submits[0].params.questions).toHaveLength(1);
    // Blocking: no ADVANCE_TO_STAGE while checklist pending.
    expect(tape.actions.some(a => a.type === 'ADVANCE_TO_STAGE')).toBe(false);
    // TERMINATE remains.
    expect(tape.actions.some(a => a.type === 'TERMINATE_CYCLE')).toBe(true);
  });

  it('9. checklist already answered (matching afterStage event) → ADVANCE_TO_STAGE flows past it', () => {
    const checklist: TapeChecklistProfile = {
      profileId: 'cl-prof-1', versionPin: 7, name: 'Wash QA',
      questions: [{ id: 'q1', question: 'q', questionType: 'YES_NO', required: true, section: null, description: null, options: [], validation: {}, sortOrder: 0 }],
    };
    const events: TapeChecklistEvent[] = [
      { eventType: 'CHECKLIST_COMPLETED', attributes: { afterStage: 'WASH_IN' } },
    ];
    const tape = generateTape(inputFx({
      pinnedProfile: checklistProfile('cl-prof-1'),
      filter: { id: 'f-1', currentLifecycleState: 'WASH_IN' },
      pinnedChecklistProfiles: new Map([['cl-prof-1', checklist]]),
      recentChecklistEvents: events,
    }));
    expect(tape.actions.some(a => a.type === 'SUBMIT_CHECKLIST')).toBe(false);
    const adv = tape.actions.find(a => a.type === 'ADVANCE_TO_STAGE') as any;
    expect(adv.params.targetState).toBe('WASH_OUT');
  });

  it('10. checklist node present but profile not in pinnedChecklistProfiles → falls through to advance', () => {
    // Mirror getCurrentState():450-456: when all checklist profiles are unresolved
    // (e.g. all disabled / deleted), skip the gate and emit advance actions.
    const tape = generateTape(inputFx({
      pinnedProfile: checklistProfile('cl-prof-missing'),
      filter: { id: 'f-1', currentLifecycleState: 'WASH_IN' },
      pinnedChecklistProfiles: new Map(),
    }));
    expect(tape.actions.some(a => a.type === 'SUBMIT_CHECKLIST')).toBe(false);
    expect(tape.actions.some(a => a.type === 'ADVANCE_TO_STAGE' && (a as any).params.targetState === 'WASH_OUT')).toBe(true);
  });

  // ── 5. SET_DRYER_DURATION ──────────────────────────────────────────────
  it('11. next stage is DRY_IN, dryer not started → SET_DRYER_DURATION (not ADVANCE_TO_STAGE)', () => {
    // Move filter to WASH_IN so DRY_IN is reachable next.
    const profile = simpleProfile();
    const tape = generateTape(inputFx({
      pinnedProfile: profile,
      filter: { id: 'f-1', currentLifecycleState: 'WASH_IN' },
    }));
    expect(tape.actions.some(a => a.type === 'SET_DRYER_DURATION')).toBe(true);
    const setDur = tape.actions.find(a => a.type === 'SET_DRYER_DURATION') as any;
    expect(setDur.params).toMatchObject({ targetState: 'DRY_IN', minMinutes: 1, maxMinutes: 1440 });
    // No plain ADVANCE_TO_STAGE(DRY_IN) when SET_DRYER_DURATION is the entry path.
    expect(tape.actions.some(a => a.type === 'ADVANCE_TO_STAGE' && (a as any).params.targetState === 'DRY_IN')).toBe(false);
  });

  // ── 6. SUBMIT_DRYER_READINGS ───────────────────────────────────────────
  it('12. in DRY_IN, dryer started + half-time elapsed + readings not submitted → SUBMIT_DRYER_READINGS', () => {
    const startedAt = new Date('2026-05-02T09:00:00Z'); // 60 min ago
    const tape = generateTape(inputFx({
      cycle: cycleFx({ dryerStartedAt: startedAt, dryerDurationMinutes: 60 }), // half = 30min, elapsed = 60min
      filter: { id: 'f-1', currentLifecycleState: 'DRY_IN' },
      pinnedEquipmentGroup: { id: 'grp-1', version: 1, instruments: [
        instr('DRY_IN', 'temp', { operatingMin: 60, operatingMax: 80 }),
      ] },
      now: new Date('2026-05-02T10:00:00Z'),
    }));
    const sub = tape.actions.find(a => a.type === 'SUBMIT_DRYER_READINGS') as any;
    expect(sub).toBeDefined();
    expect(sub.params.instrumentIds).toEqual(['temp']);
    expect(sub.validations.halfDurationMs).toBe(30 * 60_000);
    expect(sub.validations.operatingRanges).toEqual({ temp: { min: 60, max: 80 } });
  });

  it('13. in DRY_IN, half-time NOT elapsed → no SUBMIT_DRYER_READINGS, no ADVANCE_TO_STAGE (only TERMINATE)', () => {
    const startedAt = new Date('2026-05-02T09:55:00Z'); // 5 min ago
    const tape = generateTape(inputFx({
      cycle: cycleFx({ dryerStartedAt: startedAt, dryerDurationMinutes: 60 }), // half = 30min, elapsed = 5min
      filter: { id: 'f-1', currentLifecycleState: 'DRY_IN' },
      pinnedEquipmentGroup: { id: 'grp-1', version: 1, instruments: [instr('DRY_IN', 'temp')] },
      now: new Date('2026-05-02T10:00:00Z'),
    }));
    expect(tape.actions.some(a => a.type === 'SUBMIT_DRYER_READINGS')).toBe(false);
    expect(tape.actions.some(a => a.type === 'ADVANCE_TO_STAGE')).toBe(false);
    // Only TERMINATE.
    expect(tape.actions.filter(a => a.type === 'TERMINATE_CYCLE')).toHaveLength(1);
  });

  it('14. in DRY_IN, half-time elapsed, readings already submitted → no SUBMIT_DRYER_READINGS but ADVANCE allowed', () => {
    // Pipeline needs a stage past DRY_IN for ADVANCE to be visible.
    nextId = 0;
    const start = stage(null, 'START');
    const washIn = stage('WASH_IN', 'STAGE');
    const dryIn = stage('DRY_IN', 'STAGE');
    const dryOut = stage('DRY_OUT', 'STAGE');
    const end = stage(null, 'END');
    const profile: TapePinnedProfile = {
      id: 'p2', name: 'P2', flowMode: 'SEQUENTIAL',
      stages: [start, washIn, dryIn, dryOut, end],
      connections: [
        { fromStageId: start.id, toStageId: washIn.id },
        { fromStageId: washIn.id, toStageId: dryIn.id },
        { fromStageId: dryIn.id, toStageId: dryOut.id },
        { fromStageId: dryOut.id, toStageId: end.id },
      ],
    };
    const startedAt = new Date('2026-05-02T09:00:00Z');
    const tape = generateTape(inputFx({
      pinnedProfile: profile,
      cycle: cycleFx({ dryerStartedAt: startedAt, dryerDurationMinutes: 60, dryerReadingsSubmitted: true }),
      filter: { id: 'f-1', currentLifecycleState: 'DRY_IN' },
      pinnedEquipmentGroup: { id: 'grp-1', version: 1, instruments: [instr('DRY_IN', 'temp')] },
    }));
    expect(tape.actions.some(a => a.type === 'SUBMIT_DRYER_READINGS')).toBe(false);
    expect(tape.actions.some(a => a.type === 'ADVANCE_TO_STAGE' && (a as any).params.targetState === 'DRY_OUT')).toBe(true);
  });

  // ── 7. COMPLETE_CYCLE ──────────────────────────────────────────────────
  it('15. last STAGE → END, no more reachable stages → COMPLETE_CYCLE', () => {
    nextId = 0;
    const start = stage(null, 'START');
    const last = stage('LAST', 'STAGE');
    const end = stage(null, 'END');
    const profile: TapePinnedProfile = {
      id: 'p3', name: 'P3', flowMode: 'SEQUENTIAL',
      stages: [start, last, end],
      connections: [
        { fromStageId: start.id, toStageId: last.id },
        { fromStageId: last.id, toStageId: end.id },
      ],
    };
    const tape = generateTape(inputFx({
      pinnedProfile: profile,
      filter: { id: 'f-1', currentLifecycleState: 'LAST' },
    }));
    expect(tape.actions.some(a => a.type === 'COMPLETE_CYCLE')).toBe(true);
    // No reachable STAGE means no ADVANCE_TO_STAGE.
    expect(tape.actions.some(a => a.type === 'ADVANCE_TO_STAGE')).toBe(false);
  });

  // ── 8. BYPASS_STAGE ────────────────────────────────────────────────────
  it('16. flowMode=BYPASS_ENABLED → BYPASS_STAGE emitted alongside ADVANCE_TO_STAGE', () => {
    const profile = simpleProfile();
    profile.flowMode = 'BYPASS_ENABLED';
    const tape = generateTape(inputFx({ pinnedProfile: profile }));
    expect(tape.actions.some(a => a.type === 'BYPASS_STAGE')).toBe(true);
    const byp = tape.actions.find(a => a.type === 'BYPASS_STAGE') as any;
    expect(byp.requiresJustification).toEqual({ minLength: 10 });
    // Both bypass and advance for the same target.
    expect(tape.actions.some(a => a.type === 'ADVANCE_TO_STAGE' && (a as any).params.targetState === 'WASH_IN')).toBe(true);
  });

  it('17. flowMode=SEQUENTIAL → no BYPASS_STAGE actions emitted', () => {
    const tape = generateTape(inputFx());
    expect(tape.actions.some(a => a.type === 'BYPASS_STAGE')).toBe(false);
  });

  // M1 (Phase 8.2 fix — 2026-05-02): BYPASS_STAGE emit-set expansion.
  // The existing in-app UI lets the operator bypass to ANY pipeline STAGE
  // when flowMode=BYPASS_ENABLED — including step-back (an earlier stage).
  // The Phase 8.0 generator emitted only reachable stages, which strictly
  // under-reported the operator's surface. M1 fixes that: emit a BYPASS for
  // every STAGE node in the pipeline EXCEPT the current state.
  it('21. M1 BYPASS expansion: in WASH_IN with 4-stage profile → bypass to the OTHER 3 stages, not 4', () => {
    nextId = 0;
    const start = stage(null, 'START');
    const washIn = stage('WASH_IN', 'STAGE');
    const washOut = stage('WASH_OUT', 'STAGE');
    const dryIn = stage('DRY_IN', 'STAGE');
    const dryOut = stage('DRY_OUT', 'STAGE');
    const end = stage(null, 'END');
    const profile: TapePinnedProfile = {
      id: 'p-bypass-1',
      name: '4-stage bypass',
      flowMode: 'BYPASS_ENABLED',
      stages: [start, washIn, washOut, dryIn, dryOut, end],
      connections: [
        { fromStageId: start.id, toStageId: washIn.id },
        { fromStageId: washIn.id, toStageId: washOut.id },
        { fromStageId: washOut.id, toStageId: dryIn.id },
        { fromStageId: dryIn.id, toStageId: dryOut.id },
        { fromStageId: dryOut.id, toStageId: end.id },
      ],
    };
    const tape = generateTape(inputFx({
      pinnedProfile: profile,
      filter: { id: 'f-1', currentLifecycleState: 'WASH_IN' },
    }));
    const bypasses = tape.actions.filter(a => a.type === 'BYPASS_STAGE') as any[];
    const bypassTargets = bypasses.map(b => b.params.targetState).sort();
    expect(bypassTargets).toEqual(['DRY_IN', 'DRY_OUT', 'WASH_OUT']);
    // Crucially WASH_IN (the current state) is NOT in the emit set.
    expect(bypassTargets).not.toContain('WASH_IN');
  });

  it('22. M1 BYPASS expansion: includes step-back targets (earlier stages), not just forward-reachable', () => {
    // 5-stage profile: filter is at DRY_OUT. Operator must be able to bypass
    // BACK to WASH_IN (step-back) — that's the surface advance() exposes
    // server-side via cp.stages.filter(s => nodeType === 'STAGE' && stateKey).
    nextId = 0;
    const start = stage(null, 'START');
    const washIn = stage('WASH_IN', 'STAGE');
    const washOut = stage('WASH_OUT', 'STAGE');
    const dryIn = stage('DRY_IN', 'STAGE');
    const dryOut = stage('DRY_OUT', 'STAGE');
    const end = stage(null, 'END');
    const profile: TapePinnedProfile = {
      id: 'p-bypass-2',
      name: 'step-back bypass',
      flowMode: 'BYPASS_ENABLED',
      stages: [start, washIn, washOut, dryIn, dryOut, end],
      connections: [
        { fromStageId: start.id, toStageId: washIn.id },
        { fromStageId: washIn.id, toStageId: washOut.id },
        { fromStageId: washOut.id, toStageId: dryIn.id },
        { fromStageId: dryIn.id, toStageId: dryOut.id },
        { fromStageId: dryOut.id, toStageId: end.id },
      ],
    };
    const tape = generateTape(inputFx({
      pinnedProfile: profile,
      filter: { id: 'f-1', currentLifecycleState: 'DRY_OUT' },
    }));
    const bypassTargets = (tape.actions.filter(a => a.type === 'BYPASS_STAGE') as any[])
      .map(b => b.params.targetState)
      .sort();
    expect(bypassTargets).toEqual(['DRY_IN', 'WASH_IN', 'WASH_OUT']);
    // Step-back specifically: WASH_IN (earlier than current DRY_OUT) IS emitted.
    expect(bypassTargets).toContain('WASH_IN');
  });

  it('23. M1 BYPASS expansion: with no current state (fresh cycle) → bypass to ALL STAGE nodes', () => {
    // currentLifecycleState=null → no exclusion → emit one BYPASS per STAGE.
    const profile = simpleProfile();
    profile.flowMode = 'BYPASS_ENABLED';
    const tape = generateTape(inputFx({ pinnedProfile: profile }));
    const bypassTargets = (tape.actions.filter(a => a.type === 'BYPASS_STAGE') as any[])
      .map(b => b.params.targetState)
      .sort();
    expect(bypassTargets).toEqual(['DRY_IN', 'WASH_IN']);
  });

  // ── 9. tapeVersion ─────────────────────────────────────────────────────
  it('18. tapeVersion = profileVersion * 1_000_000 + filterEventCount (changes on EVERY filter event)', () => {
    // Phase 8.4 M3 (2026-05-02): formula changed from *1000 to *1_000_000 to
    // eliminate aliasing when filterEventCount approaches 1000. New cap is
    // 1M events per cycle, far above any realistic operating range.
    // Zero events.
    const tape0 = generateTape(inputFx({ cycle: cycleFx({ profileVersion: 5 }), filterEventCount: 0 }));
    expect(tape0.tapeVersion).toBe(5_000_000);

    // Single event (e.g. STATE_TRANSITION) — must change tapeVersion even though
    // checklist events list is unchanged. This is the contract that lets the FE
    // safely use tapeVersion as a cache/dedupe key across stage transitions.
    const tape1 = generateTape(inputFx({
      cycle: cycleFx({ profileVersion: 5 }),
      filterEventCount: 1,
      recentChecklistEvents: [],
    }));
    expect(tape1.tapeVersion).toBe(5_000_001);

    // Multiple events.
    const tape5 = generateTape(inputFx({ cycle: cycleFx({ profileVersion: 5 }), filterEventCount: 5 }));
    expect(tape5.tapeVersion).toBe(5_000_005);
  });

  it('19. tapeVersion is stable for the same input (determinism check)', () => {
    const fixed = inputFx({ cycle: cycleFx({ profileVersion: 2 }), filterEventCount: 3 });
    const a = generateTape(fixed);
    const b = generateTape(fixed);
    expect(a.tapeVersion).toBe(b.tapeVersion);
  });

  // ── 10. state field ────────────────────────────────────────────────────
  it('20. tape.state mirrors filter.currentLifecycleState', () => {
    const tape = generateTape(inputFx({ filter: { id: 'f-1', currentLifecycleState: 'WASH_IN' } }));
    expect(tape.state).toBe('WASH_IN');
  });

  // ── 11. computeTapeVersion direct unit (Phase 8.3) ─────────────────────
  // The exported helper is the single source of truth for the tapeVersion
  // formula — generator + write-path concurrency check both call it. If the
  // formula changes, this test fails first.
  describe('computeTapeVersion() direct unit (Phase 8.3, 8.4 M3)', () => {
    it('21. profileVersion * 1_000_000 + filterEventCount, stable for fixed inputs', () => {
      expect(computeTapeVersion(0, 0)).toBe(0);
      expect(computeTapeVersion(1, 0)).toBe(1_000_000);
      expect(computeTapeVersion(1, 5)).toBe(1_000_005);
      expect(computeTapeVersion(7, 23)).toBe(7_000_023);
    });
    it('22. nullish args coerce to 0', () => {
      expect(computeTapeVersion(undefined as any, undefined as any)).toBe(0);
      expect(computeTapeVersion(2, undefined as any)).toBe(2_000_000);
      expect(computeTapeVersion(undefined as any, 4)).toBe(4);
    });
    it('23. tape generator and direct helper agree on the same inputs', () => {
      const tape = generateTape(inputFx({ cycle: cycleFx({ profileVersion: 9 }), filterEventCount: 17 }));
      expect(tape.tapeVersion).toBe(computeTapeVersion(9, 17));
    });
    it('24. M3 (Phase 8.4): no aliasing across the old 1e3 boundary', () => {
      // Pre-fix this pair collided: 1*1000 + 1000 == 2*1000 + 0 == 2000.
      // Post-fix the cap is 1e6, so these are distinct.
      expect(computeTapeVersion(1, 1000)).not.toBe(computeTapeVersion(2, 0));
      expect(computeTapeVersion(1, 1000)).toBe(1_001_000);
      expect(computeTapeVersion(2, 0)).toBe(2_000_000);
    });
    it('25. M3: result stays within Number.MAX_SAFE_INTEGER for realistic inputs', () => {
      // 100k profile edits + 1M events per cycle cap ⇒ 1.001e11, well below 9.007e15.
      const big = computeTapeVersion(100_000, 1_000_000 - 1);
      expect(Number.isSafeInteger(big)).toBe(true);
      expect(big).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });
  });
});
