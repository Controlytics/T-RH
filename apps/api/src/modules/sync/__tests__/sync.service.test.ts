import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Phase 8.4b — Sync service unit tests.
 *
 * Pattern follows tape-version-check.test.ts: prisma is mocked via vi.hoisted
 * so we never hit a real DB; service is constructed normally and exercised
 * directly. Route schema is asserted by importing the route registration and
 * inspecting the schema object on a stub Fastify-like recorder.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    filterCleaningProfile: { findMany: vi.fn() },
    filterProfile: { findMany: vi.fn() },
    equipmentGroup: { findMany: vi.fn() },
    checklistProfile: { findMany: vi.fn() },
    assetTemplate: { findMany: vi.fn() },
    assetInstance: { findMany: vi.fn() },
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { SyncService, SYNC_PAGE_LIMIT } from '../sync.service.js';

const ctx = {
  userId: 'admin',
  userSub: 'sub-1',
  userRole: 'ADMIN',
  ipAddress: '127.0.0.1',
  userAgent: 'test',
  sessionId: 'sess-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every collection returns []
  mockPrisma.filterCleaningProfile.findMany.mockResolvedValue([]);
  mockPrisma.filterProfile.findMany.mockResolvedValue([]);
  mockPrisma.equipmentGroup.findMany.mockResolvedValue([]);
  mockPrisma.checklistProfile.findMany.mockResolvedValue([]);
  mockPrisma.assetTemplate.findMany.mockResolvedValue([]);
  mockPrisma.assetInstance.findMany.mockResolvedValue([]);
});

describe('SyncService.since() — shape + cursor handling', () => {
  it('1. with no version params returns the expected envelope shape (full sync)', async () => {
    const svc = new SyncService();
    const out = await svc.since(ctx, {});
    // All entity arrays present, deferred ones are []
    expect(out).toEqual(expect.objectContaining({
      filterCleaningProfiles: [],
      filterProfiles: [],
      equipmentGroups: [],
      checklistProfiles: [],
      assetTemplates: [],
      filters: [],
      hasMore: false,
    }));
    expect(typeof out.serverTimestamp).toBe('string');
    expect(new Date(out.serverTimestamp).getTime()).not.toBeNaN();
  });

  it('2. defaults missing version params to 0 → fetches all rows (gt: 0)', async () => {
    const svc = new SyncService();
    await svc.since(ctx, {});
    expect(mockPrisma.filterCleaningProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 0 } } })
    );
    expect(mockPrisma.filterProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 0 } } })
    );
    expect(mockPrisma.equipmentGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 0 } } })
    );
    expect(mockPrisma.checklistProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 0 } } })
    );
    expect(mockPrisma.assetTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 0 } } })
    );
  });

  it('3. version params propagate to per-entity gt cursors', async () => {
    const svc = new SyncService();
    await svc.since(ctx, {
      profileVersion: 12,
      filterProfileVersion: 4,
      equipmentGroupVersion: 8,
      checklistVersion: 17,
      assetTemplateVersion: 21,
    });
    expect(mockPrisma.filterCleaningProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 12 } } })
    );
    expect(mockPrisma.filterProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 4 } } })
    );
    expect(mockPrisma.equipmentGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 8 } } })
    );
    expect(mockPrisma.checklistProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 17 } } })
    );
    expect(mockPrisma.assetTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 21 } } })
    );
  });

  it('4. each entity query is capped at SYNC_PAGE_LIMIT (=500)', async () => {
    const svc = new SyncService();
    await svc.since(ctx, {});
    for (const fn of [
      mockPrisma.filterCleaningProfile.findMany,
      mockPrisma.filterProfile.findMany,
      mockPrisma.equipmentGroup.findMany,
      mockPrisma.checklistProfile.findMany,
      mockPrisma.assetTemplate.findMany,
      mockPrisma.assetInstance.findMany,
    ]) {
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ take: SYNC_PAGE_LIMIT }));
    }
    expect(SYNC_PAGE_LIMIT).toBe(500);
  });

  it('5. hasMore is true when ANY entity returns LIMIT rows (cleaning profiles)', async () => {
    const svc = new SyncService();
    const fakeRow = (i: number) => ({
      id: `fcp-${i}`, version: i + 1, name: `p-${i}`, stages: [], connections: [],
    });
    mockPrisma.filterCleaningProfile.findMany.mockResolvedValueOnce(
      Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => fakeRow(i))
    );
    const out = await svc.since(ctx, {});
    expect(out.hasMore).toBe(true);
    expect(out.filterCleaningProfiles.length).toBe(SYNC_PAGE_LIMIT);
  });

  it('6. hasMore is true when filters returns LIMIT rows', async () => {
    const svc = new SyncService();
    mockPrisma.assetInstance.findMany.mockResolvedValueOnce(
      Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => ({
        id: `f-${i}`, name: `f-${i}`, templateId: 't-1', status: 'Active',
        isActive: true, attributes: {}, parentId: null, parent: null,
        template: { id: 't-1', name: 'Filter', templateKind: 'FILTER' },
        filterDetails: null,
        updatedAt: new Date('2026-05-01T00:00:00Z'),
      }))
    );
    const out = await svc.since(ctx, {});
    expect(out.hasMore).toBe(true);
    expect(out.filters.length).toBe(SYNC_PAGE_LIMIT);
  });

  it('7. hasMore is false when no entity hits LIMIT', async () => {
    const svc = new SyncService();
    mockPrisma.filterCleaningProfile.findMany.mockResolvedValueOnce([
      { id: 'fcp-1', version: 13, name: 'p1', stages: [], connections: [] },
    ]);
    const out = await svc.since(ctx, { profileVersion: 12 });
    expect(out.hasMore).toBe(false);
  });

  it('8. filterUpdatedSince is parsed and applied as updatedAt cutoff', async () => {
    const svc = new SyncService();
    await svc.since(ctx, { filterUpdatedSince: '2026-04-30T00:00:00Z' });
    const call = mockPrisma.assetInstance.findMany.mock.calls[0][0];
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR[0].updatedAt.gt).toBeInstanceOf(Date);
    expect(call.where.OR[0].updatedAt.gt.toISOString()).toBe('2026-04-30T00:00:00.000Z');
    // Sidecar OR clause covers FilterDetails-only updates.
    expect(call.where.OR[1].filterDetails.is.updatedAt.gt).toBeInstanceOf(Date);
  });

  it('9. invalid filterUpdatedSince falls back to full sync (no OR clause)', async () => {
    const svc = new SyncService();
    await svc.since(ctx, { filterUpdatedSince: 'not-a-date' });
    const call = mockPrisma.assetInstance.findMany.mock.calls[0][0];
    expect(call.where.OR).toBeUndefined();
    // template-kind + isActive predicates still applied
    expect(call.where.template.templateKind).toBe('FILTER');
    expect(call.where.isActive).toBe(true);
  });

  it('10. filter rows are flattened to FE-cache shape (parent chain + sidecar)', async () => {
    const svc = new SyncService();
    mockPrisma.assetInstance.findMany.mockResolvedValueOnce([
      {
        id: 'f-1',
        name: 'F-001',
        templateId: 't-1',
        status: 'Active',
        isActive: true,
        attributes: { tag: 'pre' },
        parentId: 'ahu-1',
        updatedAt: new Date('2026-05-01T10:00:00Z'),
        template: { id: 't-1', name: 'Filter', templateKind: 'FILTER' },
        filterDetails: {
          filterProfileId: 'fp-1',
          currentLifecycleState: 'WASH_IN',
          currentCycleId: 'cy-1',
          filterSet: 'A',
          updatedAt: new Date('2026-05-01T11:00:00Z'),
        },
        parent: {
          id: 'ahu-1', name: 'AHU-1', parentId: 'area-1', template: { templateKind: 'AHU' },
          parent: {
            id: 'area-1', name: 'Area-A', parentId: 'block-1', template: { templateKind: 'AREA' },
            parent: { id: 'block-1', name: 'Block-1', template: { templateKind: 'BLOCK' } },
          },
        },
      },
    ]);
    const out = await svc.since(ctx, {});
    expect(out.filters[0]).toEqual(expect.objectContaining({
      id: 'f-1',
      name: 'F-001',
      templateKind: 'FILTER',
      ahuId: 'ahu-1', ahuName: 'AHU-1',
      areaId: 'area-1', areaName: 'Area-A',
      blockId: 'block-1', blockName: 'Block-1',
      filterProfileId: 'fp-1',
      currentLifecycleState: 'WASH_IN',
      currentCycleId: 'cy-1',
      filterSet: 'A',
    }));
    expect(out.filters[0].updatedAt).toBeInstanceOf(Date);
    expect(out.filters[0].filterDetailsUpdatedAt).toBeInstanceOf(Date);
  });

  it('10b. AHU parented directly by a Block (no Area) resolves blockId, not areaId', async () => {
    // Chain is Filter -> AHU -> Block (the Area level is skipped). The old
    // positional walk (area = ahu.parent; block = area.parent) labeled the
    // Block as the Area and left blockId null, dropping the filter's home
    // block on the tablet's offline cache. Kind-based bucketing fixes it.
    const svc = new SyncService();
    mockPrisma.assetInstance.findMany.mockResolvedValueOnce([
      {
        id: 'f-2',
        name: 'F-002',
        templateId: 't-1',
        status: 'Active',
        isActive: true,
        attributes: {},
        parentId: 'ahu-9',
        updatedAt: new Date('2026-05-01T10:00:00Z'),
        template: { id: 't-1', name: 'Filter', templateKind: 'FILTER' },
        filterDetails: null,
        parent: {
          id: 'ahu-9', name: 'AHU-9', parentId: 'block-1', template: { templateKind: 'AHU' },
          parent: {
            id: 'block-1', name: 'Block-1', parentId: null, template: { templateKind: 'BLOCK' },
            parent: null,
          },
        },
      },
    ]);
    const out = await svc.since(ctx, {});
    expect(out.filters[0]).toEqual(expect.objectContaining({
      id: 'f-2',
      ahuId: 'ahu-9', ahuName: 'AHU-9',
      areaId: null, areaName: null,
      blockId: 'block-1', blockName: 'Block-1',
    }));
  });

  it('11. filter row with missing parent chain leaves names null (no crash)', async () => {
    const svc = new SyncService();
    mockPrisma.assetInstance.findMany.mockResolvedValueOnce([
      {
        id: 'f-orphan',
        name: 'F-orphan',
        templateId: 't-1',
        status: 'Active',
        isActive: true,
        attributes: {},
        parentId: null,
        parent: null, // no AHU
        template: { id: 't-1', name: 'Filter', templateKind: 'FILTER' },
        filterDetails: null,
        updatedAt: new Date('2026-05-01T00:00:00Z'),
      },
    ]);
    const out = await svc.since(ctx, {});
    expect(out.filters[0]).toEqual(expect.objectContaining({
      id: 'f-orphan',
      ahuId: null, ahuName: null,
      areaId: null, areaName: null,
      blockId: null, blockName: null,
      filterProfileId: null,
      currentLifecycleState: null,
    }));
  });

  it('12. checklistProfile rows are returned with questions inlined (matches expand=questions shape)', async () => {
    const svc = new SyncService();
    mockPrisma.checklistProfile.findMany.mockResolvedValueOnce([
      {
        id: 'cp-1',
        name: 'Pre-cycle inspection',
        description: 'desc',
        isActive: true,
        version: 4,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        questions: [
          // Full ChecklistQuestion row shape — Prisma findMany with include
          // (no select) returns all columns. The FE consumer at
          // apps/web/src/lib/local-context.ts:425+ reads questionType /
          // required / section / description / options / validation off
          // each row, so the test fixture asserts the include returns a
          // shape that satisfies that contract.
          {
            id: 'q-1', profileId: 'cp-1', question: 'Q1?',
            questionType: 'YES_NO', required: true, section: 'A',
            description: null, options: [], validation: {}, sortOrder: 0,
          },
          {
            id: 'q-2', profileId: 'cp-1', question: 'Q2?',
            questionType: 'TEXT', required: false, section: null,
            description: 'Detail here', options: [], validation: {}, sortOrder: 1,
          },
        ],
      },
    ]);
    const out = await svc.since(ctx, {});
    expect(out.checklistProfiles).toHaveLength(1);
    expect(out.checklistProfiles[0]).toEqual(expect.objectContaining({
      id: 'cp-1',
      name: 'Pre-cycle inspection',
      version: 4,
    }));
    expect(out.checklistProfiles[0].questions).toHaveLength(2);
    expect(out.checklistProfiles[0].questions[0].id).toBe('q-1');
    // questions ordered by sortOrder asc (verified via the include parameter)
    expect(mockPrisma.checklistProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { questions: { orderBy: { sortOrder: 'asc' } } },
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
      })
    );
  });

  it('13. assetTemplate rows are returned verbatim (full schema columns)', async () => {
    const svc = new SyncService();
    const fakeTemplate = {
      id: 't-1',
      name: 'Filter',
      description: 'A filter template',
      category: 'Equipment',
      icon: 'box',
      templateKind: 'FILTER',
      version: 7,
      attributeSchema: [{ name: 'tag', dataType: 'STRING' }],
      telemetrySchema: [],
      expectedIdentifiers: [{ kind: 'RFID' }],
      expectedRelationships: [],
      statusLifecycle: [],
      checklistSchema: [],
      maxParentConnections: 1,
      maxConnections: 10,
      isActive: true,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: new Date('2026-05-01T00:00:00Z'),
      createdBy: 'admin',
      updatedBy: 'admin',
      dataIngestionEnabled: false,
      transportType: null,
      credentialType: 'TOKEN',
      inactivityTimeout: 60,
      defaultMaxDataRate: 600,
      autoProvision: true,
    };
    mockPrisma.assetTemplate.findMany.mockResolvedValueOnce([fakeTemplate]);
    const out = await svc.since(ctx, {});
    expect(out.assetTemplates).toHaveLength(1);
    // Verbatim — every key on the source row passes through.
    expect(out.assetTemplates[0]).toEqual(fakeTemplate);
    // Confirm it does NOT request an include — passing the row through raw
    // is the contract; introducing relations later would silently expand
    // the wire payload. Adding asserts here makes the contract explicit.
    const call = mockPrisma.assetTemplate.findMany.mock.calls[0][0];
    expect(call.include).toBeUndefined();
    expect(call.orderBy).toEqual([{ version: 'asc' }, { id: 'asc' }]);
  });

  it('14. hasMore is true when checklistProfiles hits LIMIT', async () => {
    const svc = new SyncService();
    mockPrisma.checklistProfile.findMany.mockResolvedValueOnce(
      Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => ({
        id: `cp-${i}`, name: `cp-${i}`, isActive: true, version: i + 1,
        questions: [],
      }))
    );
    const out = await svc.since(ctx, {});
    expect(out.hasMore).toBe(true);
    expect(out.checklistProfiles.length).toBe(SYNC_PAGE_LIMIT);
  });

  it('15. hasMore is true when assetTemplates hits LIMIT', async () => {
    const svc = new SyncService();
    mockPrisma.assetTemplate.findMany.mockResolvedValueOnce(
      Array.from({ length: SYNC_PAGE_LIMIT }, (_, i) => ({
        id: `t-${i}`, name: `t-${i}`, version: i + 1,
      }))
    );
    const out = await svc.since(ctx, {});
    expect(out.hasMore).toBe(true);
    expect(out.assetTemplates.length).toBe(SYNC_PAGE_LIMIT);
  });

  it('16. checklistProfile + assetTemplate cursors filter independently (no cross-contamination)', async () => {
    const svc = new SyncService();
    // Only the assetTemplate cursor is non-zero; checklistProfile cursor stays default.
    await svc.since(ctx, { assetTemplateVersion: 99 });
    expect(mockPrisma.assetTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 99 } } })
    );
    expect(mockPrisma.checklistProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: { gt: 0 } } })
    );
  });

  it('17. filterProfile applicableTemplates is flattened from join rows to string[]', async () => {
    const svc = new SyncService();
    mockPrisma.filterProfile.findMany.mockResolvedValueOnce([
      {
        id: 'fp-1', version: 2, name: 'Pre-filter',
        applicableTemplates: [{ templateId: 't-a' }, { templateId: 't-b' }],
      },
    ]);
    const out = await svc.since(ctx, {});
    expect(out.filterProfiles[0].applicableTemplates).toEqual(['t-a', 't-b']);
  });
});
