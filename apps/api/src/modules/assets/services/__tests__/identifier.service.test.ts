import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockIdentRepo, mockInstanceRepo, mockAuditLog } = vi.hoisted(() => ({
  mockIdentRepo: {
    findMany: vi.fn(),
    findByValue: vi.fn(),
    findById: vi.fn(),
    findByIdentifierValue: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  mockInstanceRepo: { findByIdSimple: vi.fn() },
  mockAuditLog: vi.fn(),
}));

vi.mock('../../repositories/identifier.repository.js', () => ({ identifierRepository: mockIdentRepo }));
vi.mock('../../repositories/instance.repository.js', () => ({ instanceRepository: mockInstanceRepo }));
vi.mock('../../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));

import { identifierService } from '../identifier.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

describe('identifierService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
  });

  describe('list', () => {
    it('returns identifiers', async () => {
      mockIdentRepo.findMany.mockResolvedValue([{ id: 'i1' }]);
      const result = await identifierService.list({ assetId: 'a1' });
      expect(result).toHaveLength(1);
    });
  });

  describe('lookupByValue', () => {
    it('returns identifier with asset', async () => {
      mockIdentRepo.findByValue.mockResolvedValue({ id: 'i1', identifierValue: 'QR-001' });
      const result = await identifierService.lookupByValue('QR-001');
      expect(result.identifierValue).toBe('QR-001');
    });

    it('throws NotFoundError', async () => {
      mockIdentRepo.findByValue.mockResolvedValue(null);
      await expect(identifierService.lookupByValue('MISSING')).rejects.toThrow('not found');
    });
  });

  describe('create', () => {
    it('creates identifier', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'a1', name: 'Filter-42' });
      // The service enforces "one identifier per entity" via findMany before
      // findByIdentifierValue. Both must return empty for the create to
      // proceed.
      mockIdentRepo.findMany.mockResolvedValue([]);
      mockIdentRepo.findByIdentifierValue.mockResolvedValue(null);
      mockIdentRepo.create.mockResolvedValue({ id: 'i1', assetId: 'a1', identifierType: 'RFID', identifierValue: 'RFID-001' });

      const result = await identifierService.create({ assetId: 'a1', identifierType: 'RFID', identifierValue: 'RFID-001' }, ctx);
      expect(result.identifierValue).toBe('RFID-001');
      // Audit row must be self-describing: it stores the filter name (targetId is
      // the identifier UUID) and the tag value so the audit UI can render both.
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'ASSET_IDENTIFIER_CREATED',
        afterValue: expect.objectContaining({ filterName: 'Filter-42', identifierValue: 'RFID-001' }),
      }));
    });

    it('rejects when asset not found', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue(null);
      await expect(identifierService.create({ assetId: 'bad', identifierType: 'QR', identifierValue: 'x' }, ctx))
        .rejects.toThrow('not found');
    });

    it('rejects duplicate identifier value (collision against another entity)', async () => {
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'a1' });
      // Pass the "one-per-entity" check; trip on the cross-entity dup check.
      mockIdentRepo.findMany.mockResolvedValue([]);
      mockIdentRepo.findByIdentifierValue.mockResolvedValue({ id: 'existing' });

      await expect(identifierService.create({ assetId: 'a1', identifierType: 'QR', identifierValue: 'DUP' }, ctx))
        .rejects.toThrow('already exists');
    });
  });

  describe('delete', () => {
    it('deletes identifier and logs audit', async () => {
      mockIdentRepo.findById.mockResolvedValue({ id: 'i1', assetId: 'a1', identifierType: 'RFID', identifierValue: 'RFID-001' });
      mockInstanceRepo.findByIdSimple.mockResolvedValue({ id: 'a1', name: 'Filter-42' });
      mockIdentRepo.delete.mockResolvedValue({});

      await identifierService.delete('i1', ctx);
      expect(mockIdentRepo.delete).toHaveBeenCalledWith('i1');
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'ASSET_IDENTIFIER_DELETED',
        beforeValue: expect.objectContaining({ filterName: 'Filter-42', identifierValue: 'RFID-001' }),
      }));
    });

    it('throws NotFoundError', async () => {
      mockIdentRepo.findById.mockResolvedValue(null);
      await expect(identifierService.delete('bad', ctx)).rejects.toThrow('not found');
    });
  });
});
