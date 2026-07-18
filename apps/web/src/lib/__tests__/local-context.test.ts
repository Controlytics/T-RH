/**
 * Tests for FE local-context loader (Phase 8.6 — Option D).
 *
 * Mocks the IDB readers so we can exercise the projection logic without a
 * real IndexedDB. The shape contract is what we're protecting: each entity
 * either projects cleanly, falls back to a sentinel, or surfaces null.
 *
 * Events synthesis is the novel piece — three scenarios:
 *   1. No pending checklist + no CHECKLIST node in profile → events: []
 *   2. Non-empty pending checklist → events: [] (gate must remain blocked)
 *   3. Empty pending checklist + CHECKLIST node after currentState → events
 *      contains synthesized CHECKLIST_COMPLETED (gate clears)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the IDB readers — must be hoisted before the import that uses them.
vi.mock('../offline-store', () => ({
  getCachedData: vi.fn(),
  getCachedEntity: vi.fn(),
  getCachedFilters: vi.fn(),
}));

import { loadLocalContextFromCache } from '../local-context';
import { getCachedData, getCachedEntity, getCachedFilters } from '../offline-store';
import { computeNextActions } from '@digilog/shared';

const mockGetCachedData = vi.mocked(getCachedData);
const mockGetCachedEntity = vi.mocked(getCachedEntity);
const mockGetCachedFilters = vi.mocked(getCachedFilters);

// Reusable profile graphs for the synthesis branch tests.
const profileWithChecklistAfterWashIn = {
  id: 'cp-1',
  lineageId: 'lin-1',
  name: 'Standard',
  flowMode: 'SEQUENTIAL',
  version: 3,
  status: 'ACTIVE',
  cleaningReasons: { keys: ['ROUTINE'] },
  stages: [
    { id: 'n-start', stateKey: null, nodeType: 'START', configuration: {}, sortOrder: 0 },
    { id: 'n-wash-in', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
    {
      id: 'n-cl',
      stateKey: null,
      nodeType: 'CHECKLIST',
      configuration: { checklistProfileId: 'cl-prof-1' },
      sortOrder: 2,
    },
    { id: 'n-wash-out', stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 3 },
    { id: 'n-end', stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 4 },
  ],
  connections: [
    { fromStageId: 'n-start', toStageId: 'n-wash-in' },
    { fromStageId: 'n-wash-in', toStageId: 'n-cl' },
    { fromStageId: 'n-cl', toStageId: 'n-wash-out' },
    { fromStageId: 'n-wash-out', toStageId: 'n-end' },
  ],
};

const profileNoChecklist = {
  id: 'cp-2',
  lineageId: 'lin-2',
  name: 'Plain',
  flowMode: 'SEQUENTIAL',
  version: 2,
  status: 'ACTIVE',
  cleaningReasons: {},
  stages: [
    { id: 'n-start', stateKey: null, nodeType: 'START', configuration: {}, sortOrder: 0 },
    { id: 'n-wash-in', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
    { id: 'n-wash-out', stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 2 },
    { id: 'n-end', stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 3 },
  ],
  connections: [
    { fromStageId: 'n-start', toStageId: 'n-wash-in' },
    { fromStageId: 'n-wash-in', toStageId: 'n-wash-out' },
    { fromStageId: 'n-wash-out', toStageId: 'n-end' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // localStorage is provided by jsdom; clear cached user.
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('digilog_cached_user');
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadLocalContextFromCache — Phase 8.6 FE loader', () => {
  it('1. returns sentinel context when no cache exists for filter', async () => {
    mockGetCachedData.mockResolvedValueOnce(null);
    mockGetCachedFilters.mockResolvedValueOnce([]);

    const ctx = await loadLocalContextFromCache('filter-x');

    expect(ctx.profile.status).toBe('INACTIVE');
    expect(ctx.profile.nodes).toEqual([]);
    expect(ctx.profile.edges).toEqual([]);
    expect(ctx.cycle.status).toBe('NONE');
    expect(ctx.filter.id).toBe('filter-x');
    expect(ctx.filter.currentLifecycleState).toBeNull();
    expect(ctx.equipmentGroup).toBeNull();
    expect(ctx.checklistProfile).toBeNull();
    expect(ctx.events).toEqual([]);
    // stageLookup empty when no profile present.
    expect(ctx.stageLookup).toEqual({});
  });

  it('2. projects pipelineGraph from legacy filter-state cache into ProfileSlice', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileNoChecklist,
      currentState: 'WASH_IN',
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([
      { id: 'filter-1', name: 'F-1' } as any,
    ]);

    const ctx = await loadLocalContextFromCache('filter-1');

    expect(ctx.profile.id).toBe('cp-2');
    expect(ctx.profile.flowMode).toBe('SEQUENTIAL');
    expect(ctx.profile.version).toBe(2);
    expect(ctx.profile.nodes).toHaveLength(4);
    expect(ctx.profile.edges).toHaveLength(3);
    // stageLookup falls back to buildStageLookup since cachedState had none.
    expect(ctx.stageLookup.WASH_IN).toBeDefined();
    expect(ctx.stageLookup.WASH_IN.nextStages).toEqual(['WASH_OUT']);
    expect(ctx.filter.currentLifecycleState).toBe('WASH_IN');
  });

  it('3. falls back to syncFilterCleaningProfiles store when graph not in cache', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      currentCycle: { id: 'cyc-1', profileId: 'cp-2', status: 'IN_PROGRESS' },
      currentState: 'WASH_IN',
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([
      { id: 'filter-1', name: 'F-1' } as any,
    ]);
    mockGetCachedEntity.mockResolvedValueOnce(profileNoChecklist as any);

    const ctx = await loadLocalContextFromCache('filter-1');

    expect(mockGetCachedEntity).toHaveBeenCalledWith(
      'syncFilterCleaningProfiles',
      'cp-2',
    );
    expect(ctx.profile.id).toBe('cp-2');
    expect(ctx.profile.nodes).toHaveLength(4);
  });

  it('4. handles missing equipment group → null (graceful degrade)', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileNoChecklist,
      currentState: 'WASH_IN',
      equipmentGroup: null,
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.equipmentGroup).toBeNull();
  });

  it('5. uses server-supplied stageLookup when present (B.7 priority)', async () => {
    const serverStageLookup = {
      WASH_IN: { nextStages: ['WASH_OUT'], pendingChecklistProfileIds: [], leadsToEnd: false },
      WASH_OUT: { nextStages: [], pendingChecklistProfileIds: [], leadsToEnd: true },
    };
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileNoChecklist,
      currentState: 'WASH_IN',
      stageLookup: serverStageLookup,
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.stageLookup).toBe(serverStageLookup);
  });

  it('6. events stays empty when no pending checklist + no checklist nodes', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileNoChecklist,
      currentState: 'WASH_IN',
      pendingChecklist: [],
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.events).toEqual([]);
  });

  it('7. events stays empty when pendingChecklist is non-empty (gate fires)', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileWithChecklistAfterWashIn,
      currentState: 'WASH_IN',
      pendingChecklist: [
        { checklistProfileId: 'cl-prof-1', questions: [{ id: 'q1', question: 'Q?', questionType: 'YES_NO', required: true }] },
      ],
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.events).toEqual([]);
    // ChecklistProfile resolved from inline questions.
    expect(ctx.checklistProfile?.id).toBe('cl-prof-1');
  });

  it('8. synthesizes CHECKLIST_COMPLETED when pending=[] AND profile has checklist after current', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileWithChecklistAfterWashIn,
      currentState: 'WASH_IN',
      pendingChecklist: [],
      currentCycle: { id: 'cyc-1', status: 'IN_PROGRESS', profileId: 'cp-1', profileVersion: 3 },
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0].eventType).toBe('CHECKLIST_COMPLETED');
    expect((ctx.events[0].attributes as any).afterStage).toBe('WASH_IN');
    expect((ctx.events[0].attributes as any).synthesizedByLoader).toBe(true);
  });

  it('9. cycle projection captures dryer fields from cached currentCycle', async () => {
    const dryerStarted = new Date('2026-05-02T10:00:00Z');
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileNoChecklist,
      currentState: 'DRY_IN',
      currentCycle: {
        id: 'cyc-1',
        status: 'IN_PROGRESS',
        profileId: 'cp-2',
        profileVersion: 2,
        dryerStartedAt: dryerStarted.toISOString(),
        dryerDurationMinutes: 60,
        dryerReadingsSubmitted: false,
        cleaningReasonKey: 'ROUTINE',
      },
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.cycle.status).toBe('IN_PROGRESS');
    expect(ctx.cycle.dryerStartedAt).toBe(dryerStarted.toISOString());
    expect(ctx.cycle.dryerDurationMinutes).toBe(60);
    expect(ctx.cycle.dryerReadingsSubmitted).toBe(false);
    expect(ctx.cycle.cleaningReasonKey).toBe('ROUTINE');
  });

  it('10. reads cached user permissions from localStorage', async () => {
    localStorage.setItem(
      'digilog_cached_user',
      JSON.stringify({ id: 'u-1', role: 'OPERATOR', permissions: ['FILTER_OPERATE'] }),
    );
    mockGetCachedData.mockResolvedValueOnce(null);
    mockGetCachedFilters.mockResolvedValueOnce([]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.user.id).toBe('u-1');
    expect(ctx.user.role).toBe('OPERATOR');
    expect(ctx.user.permissions).toEqual(['FILTER_OPERATE']);
  });

  it('11. falls back to empty user when localStorage is missing', async () => {
    mockGetCachedData.mockResolvedValueOnce(null);
    mockGetCachedFilters.mockResolvedValueOnce([]);

    const ctx = await loadLocalContextFromCache('f-1');

    expect(ctx.user.id).toBe('');
    expect(ctx.user.permissions).toEqual([]);
  });

  it('12. computeNextActions consumes the loaded context end-to-end', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileNoChecklist,
      currentState: 'WASH_IN',
      currentCycle: {
        id: 'cyc-1',
        status: 'IN_PROGRESS',
        profileId: 'cp-2',
        profileVersion: 2,
      },
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');
    const tape = computeNextActions(ctx);

    // Profile has WASH_IN -> WASH_OUT. Expect ADVANCE_TO_STAGE for WASH_OUT.
    const advance = tape.actions.find(
      (a: any) => a.type === 'ADVANCE_TO_STAGE' && a.params?.targetState === 'WASH_OUT',
    );
    expect(advance).toBeDefined();
    // Always emits a TERMINATE_CYCLE last.
    expect(tape.actions[tape.actions.length - 1].type).toBe('TERMINATE_CYCLE');
  });

  it('13. synthesized event satisfies executor checklist gate (advance unblocks)', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileWithChecklistAfterWashIn,
      currentState: 'WASH_IN',
      pendingChecklist: [], // operator submitted offline; cache cleared
      currentCycle: { id: 'cyc-1', status: 'IN_PROGRESS', profileId: 'cp-1', profileVersion: 3 },
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');
    const tape = computeNextActions(ctx);

    // No SUBMIT_CHECKLIST in tape — gate is cleared by synthesized event.
    const submitCheck = tape.actions.find((a: any) => a.type === 'SUBMIT_CHECKLIST');
    expect(submitCheck).toBeUndefined();
    // ADVANCE_TO_STAGE should be present.
    const advance = tape.actions.find((a: any) => a.type === 'ADVANCE_TO_STAGE');
    expect(advance).toBeDefined();
  });

  it('14. when pendingChecklist non-empty, executor emits SUBMIT_CHECKLIST first', async () => {
    mockGetCachedData.mockResolvedValueOnce({
      pipelineGraph: profileWithChecklistAfterWashIn,
      currentState: 'WASH_IN',
      pendingChecklist: [
        {
          checklistProfileId: 'cl-prof-1',
          checklistProfileName: 'Post-Wash',
          profileVersion: 2,
          questions: [{ id: 'q1', question: 'OK?', questionType: 'YES_NO', required: true }],
        },
      ],
      currentCycle: { id: 'cyc-1', status: 'IN_PROGRESS', profileId: 'cp-1', profileVersion: 3 },
    } as any);
    mockGetCachedFilters.mockResolvedValueOnce([{ id: 'f-1' } as any]);

    const ctx = await loadLocalContextFromCache('f-1');
    const tape = computeNextActions(ctx);

    const submit = tape.actions.find((a: any) => a.type === 'SUBMIT_CHECKLIST');
    expect(submit).toBeDefined();
    // ADVANCE_TO_STAGE must NOT appear when checklist is pending.
    const advance = tape.actions.find((a: any) => a.type === 'ADVANCE_TO_STAGE');
    expect(advance).toBeUndefined();
  });
});
