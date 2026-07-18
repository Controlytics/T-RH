import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockInstanceRepo, mockRelRepo, mockIdentRepo, mockTemplateRepo,
  mockValidateAttributes, mockHasCycle, mockCollectDescendants, mockAuditLog,
  mockPrisma,
} = vi.hoisted(() => ({
  mockInstanceRepo: {
    findMany: vi.fn(), findTree: vi.fn(), findById: vi.fn(), findByIdSimple: vi.fn(),
    findByIdWithName: vi.fn(), create: vi.fn(), update: vi.fn(),
    softDeleteMany: vi.fn(), findChildren: vi.fn(),
  },
  mockRelRepo: {
    createPairWithParent: vi.fn(), deleteOldContains: vi.fn(), deleteByAssetIds: vi.fn(),
    countBySourceAsset: vi.fn(), countContainsChildren: vi.fn(), countContainsParents: vi.fn(),
  },
  mockIdentRepo: { deleteByAssetIds: vi.fn() },
  mockTemplateRepo: { findById: vi.fn() },
  mockValidateAttributes: vi.fn(),
  mockHasCycle: vi.fn(),
  mockCollectDescendants: vi.fn(),
  mockAuditLog: vi.fn(),
  // Top-level prisma surface used by instance.service.ts. The service runs
  // create / update / delete inside `prisma.$transaction(async tx => ...)`,
  // so we route the $transaction callback to the same tx-shaped object.
  // Both `prisma.x.method(...)` and `tx.x.method(...)` therefore record on
  // the same vi.fn() instance.
  mockPrisma: (() => {
    const tx = {
      assetInstance: {
        create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
          id: 'inst-1',
          ...args.data,
        })),
        update: vi.fn().mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: args.where.id,
          ...args.data,
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        // delete() resolves cascaded assets' names so each identifier audit row
        // is self-describing.
        findMany: vi.fn().mockResolvedValue([]),
      },
      assetRelationship: {
        create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
          id: 'rel-1',
          ...args.data,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      assetIdentifier: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        // Identifiers are captured before the cascade destroys them.
        findMany: vi.fn().mockResolvedValue([]),
      },
      // deviceCredential / connectivityStatus / unsMapping / dataStream models
      // removed with data-ingestion removal — no longer in Prisma client.
      // qrCode / latestTelemetry models dropped 2026-07-01 (orphaned tables).
      // zipLastCleaned (called by list()) needs filterEvent + cleaningCycle groupBy.
      // zipFilterAttributes (called by list()) needs filter.findMany.
      filterEvent: { groupBy: vi.fn().mockResolvedValue([]) },
      cleaningCycle: { groupBy: vi.fn().mockResolvedValue([]) },
      filter: { findMany: vi.fn().mockResolvedValue([]) },
    };
    type Tx = typeof tx;
    return {
      ...tx,
      $transaction: vi.fn().mockImplementation(async (cb: (txArg: typeof tx) => unknown) => cb(tx)),
    };
  })(),
}));

vi.mock('../../repositories/instance.repository.js', () => ({ instanceRepository: mockInstanceRepo }));
vi.mock('../../repositories/relationship.repository.js', () => ({ relationshipRepository: mockRelRepo }));
vi.mock('../../repositories/identifier.repository.js', () => ({ identifierRepository: mockIdentRepo }));
vi.mock('../../repositories/template.repository.js', () => ({ templateRepository: mockTemplateRepo }));
vi.mock('../../helpers/attribute-validator.js', () => ({ validateAttributeValues: mockValidateAttributes }));
vi.mock('../../helpers/cycle-detection.js', () => ({ hasContainsCycle: mockHasCycle }));
vi.mock('../../helpers/descendant-collector.js', () => ({ collectDescendantIds: mockCollectDescendants }));
vi.mock('../../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { instanceService } from '../instance.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

describe('instanceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
    mockValidateAttributes.mockReturnValue([]);
  });

  describe('list', () => {
    it('returns paginated instances', async () => {
      mockInstanceRepo.findMany.mockResolvedValue({ instances: [{ id: 'i1' }], total: 1 });
      const result = await instanceService.list({ page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe('getTree', () => {
    it('returns flat tree array', async () => {
      mockInstanceRepo.findTree.mockResolvedValue([{ id: 'i1' }, { id: 'i2' }]);
      const result = await instanceService.getTree();
      expect(result).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns instance', async () => {
      mockInstanceRepo.findById.mockResolvedValue({ id: 'i1', name: 'Pump-1' });
      const result = await instanceService.getById('i1');
      expect(result.name).toBe('Pump-1');
    });

    it('throws NotFoundError', async () => {
      mockInstanceRepo.findById.mockResolvedValue(null);
      await expect(instanceService.getById('bad')).rejects.toThrow('not found');
    });
  });

  describe('create', () => {
    it('creates instance without parent', async () => {
      mockTemplateRepo.findById.mockResolvedValue({ id: 't1', version: 1, attributeSchema: [] });
      mockInstanceRepo.create.mockResolvedValue({ id: 'new-1', name: 'P1' });

      const result = await instanceService.create({ name: 'P1', templateId: 't1' }, ctx);
      expect(result.name).toBe('P1');
    });

    it('creates instance with parent and CONTAINS + CONTAINED_IN relationships in one transaction', async () => {
      mockTemplateRepo.findById.mockResolvedValue({ id: 't1', version: 1, attributeSchema: [], maxParentConnections: 1, maxConnections: 10 });
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'parent', templateId: 't1' });
      mockRelRepo.countContainsChildren.mockResolvedValue(2); // connection-limit now counts CONTAINS children only (#assets-1)
      mockInstanceRepo.findByIdWithName.mockResolvedValue({ name: 'Parent' });
      mockHasCycle.mockResolvedValue(false);

      // Make assetInstance.create return the deterministic 'child' id our
      // assertions check for. Cast through unknown because vi.fn typed via
      // mockImplementation in hoisted block keeps a generic Mock signature.
      (mockPrisma.assetInstance.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'child',
        name: 'Child',
      });

      const result = await instanceService.create({ name: 'Child', templateId: 't1', parentId: 'parent' }, ctx);
      expect(result.name).toBe('Child');

      // Service inlines the relationship pair inside prisma.$transaction
      // using tx.assetRelationship.create. We aliased `tx` to `mockPrisma`,
      // so the spy records both calls.
      expect(mockPrisma.assetRelationship.create).toHaveBeenCalledTimes(2);
      const calls = (mockPrisma.assetRelationship.create as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data.relationshipType);
      expect(calls).toEqual(expect.arrayContaining(['CONTAINS', 'CONTAINED_IN']));
    });

    it('rejects invalid attributes', async () => {
      mockTemplateRepo.findById.mockResolvedValue({ id: 't1', version: 1, attributeSchema: [{ name: 'temp', dataType: 'INTEGER', required: true }] });
      mockValidateAttributes.mockReturnValue(['temp is required']);

      await expect(instanceService.create({ name: 'P1', templateId: 't1', attributes: {} }, ctx))
        .rejects.toThrow('ATTRIBUTE_VALIDATION_ERROR');
    });

    it('rejects when template not found', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);
      await expect(instanceService.create({ name: 'P', templateId: 'bad' }, ctx))
        .rejects.toThrow('Template not found');
    });
  });

  describe('changeStatus', () => {
    it('changes status and logs audit', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'i1', status: 'ACTIVE', name: 'P1' });
      mockInstanceRepo.update.mockResolvedValue({ id: 'i1', status: 'MAINTENANCE', name: 'P1' });

      const result = await instanceService.changeStatus('i1', 'MAINTENANCE', ctx);
      expect(result.status).toBe('MAINTENANCE');
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ASSET_STATUS_CHANGED' }));
    });

    it('rejects empty status', async () => {
      await expect(instanceService.changeStatus('i1', '', ctx)).rejects.toThrow('required');
    });
  });

  describe('delete', () => {
    it('cascade soft-deletes with descendants in a single transaction', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'i1', name: 'P1', status: 'ACTIVE', isActive: true });
      mockCollectDescendants.mockResolvedValue(['child-1', 'child-2']);

      const count = await instanceService.delete('i1', ctx);
      expect(count).toBe(3); // i1 + 2 descendants

      // Service runs everything via prisma.$transaction(tx) using direct tx
      // table calls (not the repository). Verify the assetInstance soft-delete
      // updateMany covers all three IDs (unsPath cleared by Phase 7 column drop).

      expect(mockPrisma.assetInstance.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['i1', 'child-1', 'child-2'] } },
        data: { isActive: false, updatedBy: 'admin' },
      });
      // ...and the FK-dependent rows are deleted with the same id set.
      expect(mockPrisma.assetRelationship.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { sourceAssetId: { in: ['i1', 'child-1', 'child-2'] } },
            { targetAssetId: { in: ['i1', 'child-1', 'child-2'] } },
          ],
        },
      });
      expect(mockPrisma.assetIdentifier.deleteMany).toHaveBeenCalledWith({
        where: { assetId: { in: ['i1', 'child-1', 'child-2'] } },
      });
    });

    /**
     * 21 CFR §11.10(e) + RFID Track Record integrity. The identifier cascade is a
     * PHYSICAL delete but emitted only one ASSET_DELETED row. identifier.service
     * .getRfidTrackRecord() builds the report EXCLUSIVELY from
     * ASSET_IDENTIFIER_CREATED / _DELETED rows, so deleting an AHU with tagged
     * filters left a dangling ASSIGN with no REMOVE — and re-assigning the freed
     * tag produced two consecutive ASSIGNs. Emit one _DELETED per identifier,
     * inside the tx that destroys them.
     */
    it('emits one ASSET_IDENTIFIER_DELETED per cascaded identifier, inside the delete tx', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'ahu-1', name: 'AHU-01', status: 'ACTIVE', isActive: true });
      mockCollectDescendants.mockResolvedValue(['filter-1', 'filter-2']);
      mockTemplateRepo.findById.mockResolvedValue({ templateKind: 'AHU' });
      mockPrisma.assetInstance.findMany.mockResolvedValue([
        { id: 'ahu-1', name: 'AHU-01' },
        { id: 'filter-1', name: 'FLT-001' },
        { id: 'filter-2', name: 'FLT-002' },
      ]);
      mockPrisma.assetIdentifier.findMany.mockResolvedValue([
        { id: 'ident-1', assetId: 'filter-1', identifierType: 'RFID', identifierValue: 'RFID-AAA' },
        { id: 'ident-2', assetId: 'filter-2', identifierType: 'RFID', identifierValue: 'RFID-BBB' },
      ]);

      await instanceService.delete('ahu-1', ctx);

      const identCalls = mockAuditLog.mock.calls.filter(([e]) => e.action === 'ASSET_IDENTIFIER_DELETED');
      expect(identCalls).toHaveLength(2);

      // beforeValue shape is load-bearing: getRfidTrackRecord reads
      // identifierType + identifierValue + assetId off it and drops any row
      // missing them. Must match identifier.service.delete()'s shape exactly.
      expect(identCalls[0][0].beforeValue).toEqual({
        assetId: 'filter-1', identifierType: 'RFID',
        identifierValue: 'RFID-AAA', filterName: 'FLT-001',
      });
      expect(identCalls[1][0].beforeValue).toMatchObject({
        identifierValue: 'RFID-BBB', filterName: 'FLT-002',
      });
      // Audited inside the tx that destroys the rows (2nd auditLog arg = tx).
      expect(identCalls[0][1]).toBeDefined();
      // Identifiers are read BEFORE deleteMany, else they're already gone.
      const readOrder = mockPrisma.assetIdentifier.findMany.mock.invocationCallOrder[0];
      const delOrder = mockPrisma.assetIdentifier.deleteMany.mock.invocationCallOrder[0];
      expect(readOrder).toBeLessThan(delOrder);

      // The single ASSET_DELETED summary row still fires, after the tx.
      expect(mockAuditLog.mock.calls.filter(([e]) => e.action === 'ASSET_DELETED')).toHaveLength(1);
    });

    it('emits no identifier audit rows when nothing was tagged', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'i1', name: 'P1', status: 'ACTIVE', isActive: true });
      mockCollectDescendants.mockResolvedValue([]);
      mockPrisma.assetIdentifier.findMany.mockResolvedValue([]);

      await instanceService.delete('i1', ctx);

      expect(mockAuditLog.mock.calls.filter(([e]) => e.action === 'ASSET_IDENTIFIER_DELETED')).toHaveLength(0);
    });
  });

  describe('getChildren', () => {
    it('returns children of parent', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'p1' });
      mockInstanceRepo.findChildren.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

      const result = await instanceService.getChildren('p1');
      expect(result).toHaveLength(2);
    });
  });
});
