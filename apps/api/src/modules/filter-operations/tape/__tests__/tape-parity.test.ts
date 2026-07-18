import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Phase 8.0 — tape contract harness (post-Phase-8.7 cutover).
 *
 * Originally a parity gate that compared `actions[]` against the deprecated
 * `nextAllowedStages` + `pendingChecklist` fields. After Phase 8.7 those
 * fields were dropped from the response — the FE consumes `actions[]` +
 * `tapeVersion` directly, so the assertions here now cover the tape
 * contract in isolation: every shape the FE depends on at runtime.
 *
 * Mocking pattern follows B7.3's get-current-state.test.ts: prisma is mocked
 * directly via vi.hoisted; getProfilePipeline is replaced on the instance.
 */

const { mockPrisma, mockAuditLog } = vi.hoisted(() => ({
  mockPrisma: {
    assetInstance: { findFirst: vi.fn(), findUnique: vi.fn() },
    cleaningCycle: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), update: vi.fn() },
    equipmentGroup: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    equipmentGroupVersion: { findUnique: vi.fn() },
    filterCleaningProfile: { findUnique: vi.fn() },
    filterProfile: { findUnique: vi.fn() },
    filterEvent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    checklistProfile: { findMany: vi.fn() },
    checklistProfileVersion: { findMany: vi.fn() },
    pmScheduleEntry: { findFirst: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));

import { FilterOperationsService } from '../../filter-operations.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

const FILTER_ID = 'filter-1';
const CYCLE_ID = 'cycle-1';
const GROUP_ID = 'group-1';
const PROFILE_ID = 'profile-1';

// ── pipeline-graph fixture builders ───────────────────────────────────────

let nextId = 0;
const id = () => `node-${++nextId}`;

interface FxStage { id: string; stateKey: string | null; nodeType: string; sortOrder: number; configuration: any; profileId: string }
interface FxConn { fromStageId: string; toStageId: string; profileId: string }

function pipeline(name: 'simple' | 'with-checklist' | 'last-stage') {
  nextId = 0;
  if (name === 'simple') {
    // START → WASH_IN → DRY_IN → END
    const start: FxStage = { id: id(), stateKey: null, nodeType: 'START', sortOrder: 0, configuration: {}, profileId: PROFILE_ID };
    const wash: FxStage = { id: id(), stateKey: 'WASH_IN', nodeType: 'STAGE', sortOrder: 1, configuration: {}, profileId: PROFILE_ID };
    const dry: FxStage = { id: id(), stateKey: 'DRY_IN', nodeType: 'STAGE', sortOrder: 2, configuration: {}, profileId: PROFILE_ID };
    const end: FxStage = { id: id(), stateKey: null, nodeType: 'END', sortOrder: 3, configuration: {}, profileId: PROFILE_ID };
    const stages = [start, wash, dry, end];
    const connections: FxConn[] = [
      { fromStageId: start.id, toStageId: wash.id, profileId: PROFILE_ID },
      { fromStageId: wash.id, toStageId: dry.id, profileId: PROFILE_ID },
      { fromStageId: dry.id, toStageId: end.id, profileId: PROFILE_ID },
    ];
    return { stages, connections };
  }
  if (name === 'with-checklist') {
    // START → WASH_IN → CHECKLIST → WASH_OUT → END
    const start: FxStage = { id: id(), stateKey: null, nodeType: 'START', sortOrder: 0, configuration: {}, profileId: PROFILE_ID };
    const wash: FxStage = { id: id(), stateKey: 'WASH_IN', nodeType: 'STAGE', sortOrder: 1, configuration: {}, profileId: PROFILE_ID };
    const cl: FxStage = { id: id(), stateKey: null, nodeType: 'CHECKLIST', sortOrder: 2, configuration: { checklistProfileId: 'cl-1' }, profileId: PROFILE_ID };
    const out: FxStage = { id: id(), stateKey: 'WASH_OUT', nodeType: 'STAGE', sortOrder: 3, configuration: {}, profileId: PROFILE_ID };
    const end: FxStage = { id: id(), stateKey: null, nodeType: 'END', sortOrder: 4, configuration: {}, profileId: PROFILE_ID };
    const stages = [start, wash, cl, out, end];
    const connections: FxConn[] = [
      { fromStageId: start.id, toStageId: wash.id, profileId: PROFILE_ID },
      { fromStageId: wash.id, toStageId: cl.id, profileId: PROFILE_ID },
      { fromStageId: cl.id, toStageId: out.id, profileId: PROFILE_ID },
      { fromStageId: out.id, toStageId: end.id, profileId: PROFILE_ID },
    ];
    return { stages, connections };
  }
  // last-stage: START → ONLY → END (in ONLY → next is END)
  const start: FxStage = { id: id(), stateKey: null, nodeType: 'START', sortOrder: 0, configuration: {}, profileId: PROFILE_ID };
  const only: FxStage = { id: id(), stateKey: 'ONLY', nodeType: 'STAGE', sortOrder: 1, configuration: {}, profileId: PROFILE_ID };
  const end: FxStage = { id: id(), stateKey: null, nodeType: 'END', sortOrder: 2, configuration: {}, profileId: PROFILE_ID };
  return {
    stages: [start, only, end],
    connections: [
      { fromStageId: start.id, toStageId: only.id, profileId: PROFILE_ID },
      { fromStageId: only.id, toStageId: end.id, profileId: PROFILE_ID },
    ],
  };
}

function filter(currentState: string | null) {
  return {
    id: FILTER_ID, name: 'F-001', parentId: 'parent-1',
    template: { templateKind: 'FILTER' },
    filterDetails: {
      filterProfileId: PROFILE_ID, currentLifecycleState: currentState,
      currentCycleId: CYCLE_ID, filterSet: 'A',
    },
  };
}

function cycle(overrides: any = {}) {
  return {
    id: CYCLE_ID,
    filterId: FILTER_ID,
    profileId: PROFILE_ID,
    profileVersion: 3,
    status: 'IN_PROGRESS',
    cleaningAreaId: 'block-1',
    equipmentGroupId: GROUP_ID,
    equipmentGroupVersionPin: null,
    checklistVersionPins: null,
    dryerStartedAt: null,
    dryerDurationMinutes: null,
    dryerReadingsSubmitted: false,
    ...overrides,
  };
}

function setupReads(opts: { currentState: string | null; pipelineName: 'simple' | 'with-checklist' | 'last-stage'; cycleOverrides?: any; flowMode?: string; checklistAnswered?: boolean; equipmentInstruments?: any[]; resolvedChecklistProfile?: any }) {
  const { stages, connections } = pipeline(opts.pipelineName);
  mockPrisma.assetInstance.findFirst.mockResolvedValue(filter(opts.currentState));
  mockPrisma.assetInstance.findUnique.mockImplementation(async (args: any) => {
    if (args.where?.id === FILTER_ID) return { id: FILTER_ID, name: 'F-001', parentId: 'parent-1', template: { templateKind: 'FILTER' } };
    if (args.where?.id === 'parent-1') return { id: 'parent-1', name: 'AHU-1', parentId: null, template: { templateKind: 'AHU' } };
    return null;
  });
  mockPrisma.cleaningCycle.findUnique.mockResolvedValue(cycle(opts.cycleOverrides ?? {}));
  mockPrisma.cleaningCycle.count.mockResolvedValue(0);
  mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
  mockPrisma.pmScheduleEntry.findFirst.mockResolvedValue(null);
  mockPrisma.filterEvent.findFirst.mockResolvedValue(opts.checklistAnswered ? { id: 'evt-1' } : null);
  mockPrisma.filterEvent.findMany.mockResolvedValue(
    opts.checklistAnswered && opts.currentState
      ? [{ eventType: 'CHECKLIST_COMPLETED', attributes: { afterStage: opts.currentState } }]
      : [],
  );
  mockPrisma.filterEvent.count.mockResolvedValue(0);
  mockPrisma.filterProfile.findUnique.mockResolvedValue(null);
  mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue({
    id: PROFILE_ID, name: 'Test Profile', flowMode: opts.flowMode ?? 'SEQUENTIAL', status: 'ACTIVE',
    stages, connections,
  });
  mockPrisma.equipmentGroup.findUnique.mockResolvedValue({
    id: GROUP_ID, name: 'eq', blockId: 'block-1', isActive: true, version: 1,
    instruments: opts.equipmentInstruments ?? [],
  });
  mockPrisma.equipmentGroup.findFirst.mockResolvedValue(null);
  mockPrisma.equipmentGroup.findMany.mockResolvedValue([]);
  mockPrisma.equipmentGroupVersion.findUnique.mockResolvedValue(null);
  mockPrisma.checklistProfile.findMany.mockResolvedValue(
    opts.resolvedChecklistProfile
      ? [opts.resolvedChecklistProfile]
      : [],
  );
  mockPrisma.checklistProfileVersion.findMany.mockResolvedValue([]);
}

// ── tape contract tests ──────────────────────────────────────────────────

describe('Phase 8.0 — getCurrentState() emits a complete decision tape (post-8.7 cutover)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("p1. fresh cycle, no current state → tape emits ADVANCE_TO_STAGE for the first reachable STAGE", async () => {
    setupReads({ currentState: null, pipelineName: 'simple' });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);

    expect(state.actions).toBeDefined();
    expect(state.tapeVersion).toBeDefined();

    const advances = state.actions.filter((a: any) => a.type === 'ADVANCE_TO_STAGE');
    expect(advances.map((a: any) => a.params.targetState)).toEqual(['WASH_IN']);
  });

  it('p2. in WASH_IN with checklist pending → SUBMIT_CHECKLIST emitted, no ADVANCE_TO_STAGE', async () => {
    setupReads({
      currentState: 'WASH_IN',
      pipelineName: 'with-checklist',
      resolvedChecklistProfile: {
        id: 'cl-1', name: 'Wash QA', version: 4,
        questions: [{ id: 'q1', question: 'Tank empty?', questionType: 'YES_NO', required: true, section: null, description: null, options: [], validation: {}, sortOrder: 0 }],
      },
    });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);

    const submits = state.actions.filter((a: any) => a.type === 'SUBMIT_CHECKLIST');
    expect(submits.length).toBeGreaterThan(0);
    expect(submits[0].params.checklistProfileId).toBe('cl-1');
    expect(submits[0].params.afterStage).toBe('WASH_IN');
    expect(state.actions.some((a: any) => a.type === 'ADVANCE_TO_STAGE')).toBe(false);
  });

  it('p3. in WASH_IN, checklist already answered → tape emits ADVANCE_TO_STAGE for WASH_OUT', async () => {
    setupReads({
      currentState: 'WASH_IN',
      pipelineName: 'with-checklist',
      checklistAnswered: true,
    });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);

    const adv = state.actions.find((a: any) => a.type === 'ADVANCE_TO_STAGE');
    expect(adv).toBeDefined();
    expect(adv.params.targetState).toBe('WASH_OUT');
  });

  it('p4. ADVANCE_TO_STAGE flags requiresInstrumentReadings + operatingRanges when target stage has equipment instruments', async () => {
    setupReads({
      currentState: null,
      pipelineName: 'simple',
      equipmentInstruments: [
        { id: 'ins-1', description: 'Pressure', stageKey: 'WASH_IN', operatingMin: 5, operatingMax: 15, sortOrder: 0 },
      ],
    });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);
    const adv = state.actions.find((a: any) => a.type === 'ADVANCE_TO_STAGE' && a.params.targetState === 'WASH_IN');
    expect(adv.params.requiresInstrumentReadings).toEqual(['ins-1']);
    expect(adv.validations.operatingRanges).toEqual({ 'ins-1': { min: 5, max: 15 } });
  });

  it("p5. last STAGE → END → tape emits COMPLETE_CYCLE", async () => {
    setupReads({ currentState: 'ONLY', pipelineName: 'last-stage' });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);

    expect(state.actions.some((a: any) => a.type === 'COMPLETE_CYCLE')).toBe(true);
  });

  it('p6. tape + tapeVersion are always present in the response (no env flag)', async () => {
    setupReads({ currentState: null, pipelineName: 'simple' });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);

    expect(state.actions).toBeDefined();
    expect(Array.isArray(state.actions)).toBe(true);
    expect(state.tapeVersion).toBeDefined();
    expect(typeof state.tapeVersion).toBe('number');
    // stageLookup is the per-stage lookup table (offline-only consumer); still present.
    expect(state.stageLookup).toBeDefined();
  });

  it('p7. TERMINATE_CYCLE always present while cycle in progress', async () => {
    setupReads({ currentState: 'WASH_IN', pipelineName: 'simple' });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);
    expect(state.actions.some((a: any) => a.type === 'TERMINATE_CYCLE')).toBe(true);
    const term = state.actions.find((a: any) => a.type === 'TERMINATE_CYCLE');
    expect(term.requiresJustification).toEqual({ minLength: 10 });
  });

  it('p8. tapeVersion derives from cycle.profileVersion (smoke check)', async () => {
    setupReads({ currentState: null, pipelineName: 'simple', cycleOverrides: { profileVersion: 7 } });
    const state = await new FilterOperationsService().getCurrentState(ctx, FILTER_ID);
    // Phase 8.4 M3 (2026-05-02): formula = profileVersion * 1_000_000 +
    // filterEventCount. 7 * 1e6 + 0 = 7_000_000.
    expect(state.tapeVersion).toBe(7_000_000);
  });
});
