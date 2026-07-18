import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    assetIdentifier: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { identifierRepository } from '../identifier.repository.js';

describe('identifier.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findMany', () => {
    it('returns identifiers with included asset', async () => {
      mockPrisma.assetIdentifier.findMany.mockResolvedValue([
        { id: 'id1', identifierValue: 'QR-001', asset: { id: 'a1', name: 'Pump' } },
      ]);
      const result = await identifierRepository.findMany({ assetId: 'a1' });
      expect(result).toHaveLength(1);
      expect(result[0].asset.name).toBe('Pump');
    });
  });

  describe('findByValue', () => {
    it('returns identifier with full asset details', async () => {
      mockPrisma.assetIdentifier.findUnique.mockResolvedValue({
        id: 'id1',
        identifierValue: 'QR-001',
        asset: {
          id: 'a1', name: 'Pump',
          template: { id: 't1', name: 'Pump Template' },
          parent: { id: 'p1', name: 'Plant' },
          identifiers: [],
        },
      });
      const result = await identifierRepository.findByValue('QR-001');
      expect(result?.asset.template.name).toBe('Pump Template');
    });
  });

  describe('findById', () => {
    it('returns identifier by id', async () => {
      mockPrisma.assetIdentifier.findUnique.mockResolvedValue({ id: 'id1', identifierType: 'QR' });
      const result = await identifierRepository.findById('id1');
      expect(result?.identifierType).toBe('QR');
    });
  });

  describe('findByIdentifierValue', () => {
    it('returns identifier by unique value', async () => {
      mockPrisma.assetIdentifier.findUnique.mockResolvedValue({ id: 'id1', identifierValue: 'RFID-001' });
      const result = await identifierRepository.findByIdentifierValue('RFID-001');
      expect(result?.identifierValue).toBe('RFID-001');
    });
  });

  describe('create', () => {
    it('creates a new identifier', async () => {
      const data = {
        assetId: 'a1',
        identifierType: 'QR',
        identifierValue: 'QR-002',
        label: 'Main QR',
        isPrimary: true,
        createdBy: 'admin',
      };
      mockPrisma.assetIdentifier.create.mockResolvedValue({ id: 'id2', ...data });
      const result = await identifierRepository.create(data);
      expect(result.identifierValue).toBe('QR-002');
    });
  });

  describe('delete', () => {
    it('deletes identifier by id', async () => {
      mockPrisma.assetIdentifier.delete.mockResolvedValue({ id: 'id1' });
      const result = await identifierRepository.delete('id1');
      expect(result.id).toBe('id1');
    });
  });

  describe('deleteByAssetIds', () => {
    it('deletes identifiers for multiple asset ids', async () => {
      mockPrisma.assetIdentifier.deleteMany.mockResolvedValue({ count: 3 });
      const result = await identifierRepository.deleteByAssetIds(['a1', 'a2']);
      expect(result.count).toBe(3);
    });
  });
});
