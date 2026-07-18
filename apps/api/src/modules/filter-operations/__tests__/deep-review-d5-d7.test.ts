import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Deep-review verification tests (2026-05-17).
 *
 * D5 — /api/filters/batch-states must return per-filter objects identical to
 *      /api/filters/:id/current-state. The earlier deep review worried about
 *      shape divergence; the implementation at current-state.ts:58 actually
 *      delegates to service.getCurrentState() in a chunked loop, so the
 *      shapes ARE guaranteed equal. This test locks that contract — if
 *      anyone re-implements batch-states with its own serializer, this
 *      breaks.
 *
 * D7 — When a cleaning profile has CHECKLIST nodes between the operator's
 *      target stage and END (e.g. WASH_IN → CHECKLIST → END), advance.ts
 *      MUST defer cycle completion until the checklist is submitted. The
 *      fix lives at advance.ts:250-267 (`hasPendingChecklistAfterTarget`)
 *      and the canonical helper that collects post-stage checklists is
 *      `collectChecklistsAfterStage` in filter-operations/helpers.ts.
 */

// ── prisma mock ───────────────────────────────────────────────────────────
const { mockPrisma, mockAuditLog } = vi.hoisted(() => ({
  mockPrisma: {
    assetInstance: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    cleaningCycle: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), groupBy: vi.fn(), update: vi.fn() },
    equipmentGroup: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    equipmentGroupVersion: { findUnique: vi.fn() },
    filterCleaningProfile: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    filterProfile: { findUnique: vi.fn() },
    filterEvent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    checklistProfile: { findMany: vi.fn() },
    checklistProfileVersion: { findMany: vi.fn() },
    pmScheduleEntry: { findFirst: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));

import { FilterOperationsService } from '../filter-operations.service.js';
import { collectChecklistsAfterStage } from '../helpers.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN' as const, ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

const FILTER_ID = 'filter-d5';

function filterFixture() {
  return {
    id: FILTER_ID,
    name: 'F-D5',
    parentId: 'parent-1',
    template: { templateKind: 'FILTER' },
    filterDetails: {
      filterProfileId: null,
      currentLifecycleState: null,
      currentCycleId: null,
      filterSet: 'A',
    },
  };
}

describe('D5 — batch-states and current-state shape contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No cycle, no profile → both endpoints take the early-return path
    // (filter exists but is not in a cycle). This isolates the shape contract
    // from the cycle-pinning logic and is the simplest stable fixture.
    mockPrisma.assetInstance.findFirst.mockResolvedValue(filterFixture());
    mockPrisma.assetInstance.findUnique.mockResolvedValue(filterFixture());
    mockPrisma.cleaningCycle.findUnique.mockResolvedValue(null);
    mockPrisma.cleaningCycle.findFirst.mockResolvedValue(null);
    mockPrisma.filterProfile.findUnique.mockResolvedValue(null);
    mockPrisma.assetInstance.findMany.mockResolvedValue([{ id: FILTER_ID }]);
    mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
    mockPrisma.pmScheduleEntry.findFirst.mockResolvedValue(null);
    // totalCycles (M39): the single path counts per filter; the batch path loads
    // every filter's count in ONE groupBy. These two mocks are the SAME fact
    // stated both ways, so the parity assertion below genuinely proves the two
    // code paths agree on a non-zero count — rather than agreeing on `undefined`,
    // which is what an unstubbed count() would have returned (and which Prisma
    // never returns in production).
    mockPrisma.cleaningCycle.count.mockResolvedValue(2);
    mockPrisma.cleaningCycle.groupBy.mockResolvedValue([{ filterId: FILTER_ID, _count: { _all: 2 } }]);
  });

  it('getBatchStates returns the same per-filter object that getCurrentState returns', async () => {
    const service = new FilterOperationsService();
    const direct = await service.getCurrentState(ctx, FILTER_ID, undefined);
    const batched = await service.getBatchStates(ctx, undefined);

    expect(batched).toHaveProperty('states');
    expect(batched).toHaveProperty('cachedAt');
    expect(batched.states).toHaveProperty(FILTER_ID);

    // The contract: per-filter object in batch must deep-equal what
    // current-state would return for the same filter. This locks in the
    // delegation pattern at current-state.ts:58.
    expect(batched.states[FILTER_ID]).toEqual(direct);
  });

  it('getBatchStates skips filters whose getCurrentState rejects (silent skip per current-state.ts:64)', async () => {
    // Add a second filter that will throw inside getCurrentState
    mockPrisma.assetInstance.findMany.mockResolvedValueOnce([
      { id: FILTER_ID },
      { id: 'filter-rejected' },
    ]);
    mockPrisma.assetInstance.findFirst.mockImplementation(({ where }: any) => {
      if (where?.id === 'filter-rejected') {
        return Promise.reject(new Error('Filter not found'));
      }
      return Promise.resolve(filterFixture());
    });
    mockPrisma.assetInstance.findUnique.mockImplementation(({ where }: any) => {
      if (where?.id === 'filter-rejected') {
        return Promise.reject(new Error('Filter not found'));
      }
      return Promise.resolve(filterFixture());
    });

    const service = new FilterOperationsService();
    const batched = await service.getBatchStates(ctx, undefined);

    expect(batched.states).toHaveProperty(FILTER_ID);
    expect(batched.states).not.toHaveProperty('filter-rejected');
  });
});

describe('D7 — CHECKLIST → END defers cycle completion', () => {
  it('collectChecklistsAfterStage returns the CHECKLIST node when the graph is STAGE → CHECKLIST → END', () => {
    // Minimal profile graph: WASH_IN → CHECKLIST(cl-1) → END
    const stages = [
      { id: 'node-wash-in', nodeType: 'STAGE', stateKey: 'WASH_IN', configuration: {} },
      { id: 'node-checklist', nodeType: 'CHECKLIST', stateKey: null, configuration: { checklistProfileId: 'cl-1' } },
      { id: 'node-end', nodeType: 'END', stateKey: null, configuration: {} },
    ];
    const connections = [
      { fromStageId: 'node-wash-in', toStageId: 'node-checklist' },
      { fromStageId: 'node-checklist', toStageId: 'node-end' },
    ];

    const targetStage = stages[0];
    const afterTarget = collectChecklistsAfterStage(targetStage as any, stages as any, connections as any);

    // The checklist sitting between WASH_IN and END must be returned —
    // advance.ts then checks if the checklist profile is active, and if so,
    // defers cycle COMPLETED status until the operator submits it. Without
    // this, the cycle auto-completes on WASH_IN and the operator can never
    // answer the post-stage checklist.
    expect(afterTarget.length).toBeGreaterThan(0);
    expect(afterTarget[0]).toMatchObject({
      id: 'node-checklist',
      nodeType: 'CHECKLIST',
      configuration: expect.objectContaining({ checklistProfileId: 'cl-1' }),
    });
  });

  it('collectChecklistsAfterStage returns empty when the graph is STAGE → END (no checklist gate)', () => {
    const stages = [
      { id: 'node-wash-in', nodeType: 'STAGE', stateKey: 'WASH_IN', configuration: {} },
      { id: 'node-end', nodeType: 'END', stateKey: null, configuration: {} },
    ];
    const connections = [
      { fromStageId: 'node-wash-in', toStageId: 'node-end' },
    ];

    const afterTarget = collectChecklistsAfterStage(stages[0] as any, stages as any, connections as any);

    // No checklist between WASH_IN and END → advance.ts safely auto-completes
    // the cycle. This is the legacy fast path the D7 fix must NOT have broken.
    expect(afterTarget).toHaveLength(0);
  });

  it('collectChecklistsAfterStage returns multiple checklists if the graph has STAGE → CHECKLIST → CHECKLIST → END', () => {
    const stages = [
      { id: 'node-wash-in', nodeType: 'STAGE', stateKey: 'WASH_IN', configuration: {} },
      { id: 'node-cl-1', nodeType: 'CHECKLIST', stateKey: null, configuration: { checklistProfileId: 'cl-1' } },
      { id: 'node-cl-2', nodeType: 'CHECKLIST', stateKey: null, configuration: { checklistProfileId: 'cl-2' } },
      { id: 'node-end', nodeType: 'END', stateKey: null, configuration: {} },
    ];
    const connections = [
      { fromStageId: 'node-wash-in', toStageId: 'node-cl-1' },
      { fromStageId: 'node-cl-1', toStageId: 'node-cl-2' },
      { fromStageId: 'node-cl-2', toStageId: 'node-end' },
    ];

    const afterTarget = collectChecklistsAfterStage(stages[0] as any, stages as any, connections as any);

    expect(afterTarget.length).toBe(2);
    expect(afterTarget.map((n: any) => n.configuration.checklistProfileId).sort()).toEqual(['cl-1', 'cl-2']);
  });
});
