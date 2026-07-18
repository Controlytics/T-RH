import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 2026-07-16: a block may now have MULTIPLE active equipment groups. `create()`
 * always creates the group active — the old "create INACTIVE when the block
 * already has an active group" logic (and its block-count read) is gone along
 * with the Enable/Disable toggle.
 */
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    assetInstance: { findFirst: vi.fn() },
    equipmentGroup: { create: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    equipmentGroupInstrument: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));

import { EquipmentGroupsService } from '../equipment-groups.service.js';

const service = new EquipmentGroupsService();
const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' } as any;

const inst = (id: string) => ({
  instrumentId: id, serialNumber: 'SN', uom: 'Pa',
  instrumentMin: 0, instrumentMax: 100, operatingMin: 10, operatingMax: 90, leastCount: 1,
});
const validPayload = {
  name: 'Group B', blockId: 'blk-1',
  instruments: [inst('I1'), inst('I2'), inst('I3')],
};

describe('EquipmentGroupsService.create — always active', () => {
  let txCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.assetInstance.findFirst.mockResolvedValue({ id: 'blk-1', name: 'Block 1' });
    txCreate = vi.fn().mockResolvedValue({ id: 'new-group' });
    const tx = {
      equipmentGroup: { create: txCreate, findUnique: vi.fn().mockResolvedValue({ id: 'new-group', isActive: true, instruments: [] }), count: mockPrisma.equipmentGroup.count },
      equipmentGroupInstrument: { create: vi.fn().mockResolvedValue({}) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    // If the old logic were still present it would consult this to decide
    // isActive; it must NOT be consulted anymore.
    mockPrisma.equipmentGroup.count.mockResolvedValue(3); // block already has active groups
  });

  it('creates the group with isActive: true even when the block already has active groups', async () => {
    await service.create(ctx, validPayload);

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(txCreate.mock.calls[0][0].data).toMatchObject({ isActive: true, blockId: 'blk-1', name: 'Group B' });
  });

  it('does NOT read the block\'s active-group count to decide isActive (single-active logic removed)', async () => {
    await service.create(ctx, validPayload);
    // The removed logic did `tx.equipmentGroup.count({ where: { blockId, isActive: true } })`
    // to set createActive. No count call should gate the create anymore.
    expect(mockPrisma.equipmentGroup.count).not.toHaveBeenCalled();
  });
});
