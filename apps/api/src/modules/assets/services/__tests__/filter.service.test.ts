import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterService } from '../filter.service.js';
import { prisma } from '../../../../lib/prisma.js';
import { auditLog } from '../../../../lib/audit.js';

// The tx client IS the prisma mock, so tests can assert on either handle.
vi.mock('../../../../lib/prisma.js', () => {
  const prisma: any = {
    ahu: { findUnique: vi.fn() },
    filter: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(async ({ data }: any) => ({ ...data })), update: vi.fn(async ({ data }: any) => ({ ...data })) },
    filterDetails: { create: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    cleaningCycle: { findFirst: vi.fn() },
    assetIdentifier: { findMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});
vi.mock('../filter-fields.service.js', () => ({
  FILTER_ATTRIBUTE_FIELDS: ['ahuType', 'filterType', 'micronSize', 'filterSize', 'lastCleaningDate'],
  // Mirrors the real builder's contract: only present, non-blank fields are emitted.
  validateAndBuildFilterAttributes: vi.fn(async (i: any) => {
    const attributes: Record<string, unknown> = {};
    for (const f of ['ahuType', 'filterType', 'micronSize', 'filterSize', 'lastCleaningDate']) {
      const raw = (i[f] ?? '').toString().trim();
      if (raw) attributes[f] = raw;
    }
    return { attributes, errors: [] };
  }),
}));
vi.mock('../identifier.service.js', () => ({ identifierService: { create: vi.fn() } }));
vi.mock('../../../../lib/audit.js', () => ({ auditLog: vi.fn() }));

const ctx = { userId: 'superadmin', userRole: 'SUPER_ADMIN' } as any;
beforeEach(() => {
  vi.clearAllMocks();
  (prisma.ahu.findUnique as any).mockResolvedValue({ id: 'ahu1' });
  (prisma.filter.findFirst as any).mockResolvedValue(null);
  (prisma.filterDetails.findUnique as any).mockResolvedValue(null);
  (prisma.cleaningCycle.findFirst as any).mockResolvedValue(null);
  (prisma.assetIdentifier.findMany as any).mockResolvedValue([]);
});

describe('filterService.create', () => {
  it('rejects when the AHU does not exist (no asset hierarchy validation)', async () => {
    (prisma.ahu.findUnique as any).mockResolvedValue(null);
    await expect(filterService.create({ name: 'F', ahuId: 'nope' }, ctx)).rejects.toThrow(/AHU/);
  });

  it('rejects a duplicate filter name', async () => {
    (prisma.filter.findFirst as any).mockResolvedValue({ id: 'x' });
    await expect(filterService.create({ name: 'Dup', ahuId: 'ahu1' }, ctx)).rejects.toThrow(/exists/);
  });

  it('creates the typed filter with a generated id + ahuId + attributes and returns it', async () => {
    const out = await filterService.create({ name: 'F', ahuId: 'ahu1', filterSet: 'A', ahuType: 'Process' }, ctx);
    expect(typeof out.id).toBe('string');      // app-generated UUID (filters.id has no DB default)
    expect(out.id.length).toBeGreaterThan(10);
    expect(out.ahuId).toBe('ahu1');
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

// #221 — a partial PUT must not destroy the regulated field-option values the
// caller didn't resend, while an explicit '' must still clear a field.
describe('filterService.update — partial-update attributes contract', () => {
  const stored = { ahuType: 'Process', filterType: 'HEPA', micronSize: '0.3', filterSize: '610x610', lastCleaningDate: '2026-01-02' };
  beforeEach(() => {
    (prisma.filter.findUnique as any).mockResolvedValue({ name: 'F1', attributes: { ...stored } });
  });

  it('preserves every attribute the caller omitted (name-only PUT)', async () => {
    await filterService.update('f1', { name: 'F2' }, ctx);
    expect((prisma.filter.update as any).mock.calls[0][0].data.attributes).toEqual(stored);
  });

  it('overlays only the supplied field and leaves the rest intact', async () => {
    await filterService.update('f1', { micronSize: '0.5' }, ctx);
    expect((prisma.filter.update as any).mock.calls[0][0].data.attributes).toEqual({ ...stored, micronSize: '0.5' });
  });

  it("clears a field sent as an explicit '' (the edit dialog's clear path)", async () => {
    await filterService.update('f1', { name: 'F1', ahuType: 'Process', filterType: '', micronSize: '0.3', filterSize: '610x610', lastCleaningDate: '2026-01-02' }, ctx);
    const { filterType, ...rest } = stored;
    expect((prisma.filter.update as any).mock.calls[0][0].data.attributes).toEqual(rest);
  });

  it('clears a field sent as an explicit null', async () => {
    await filterService.update('f1', { lastCleaningDate: null }, ctx);
    expect((prisma.filter.update as any).mock.calls[0][0].data.attributes).not.toHaveProperty('lastCleaningDate');
  });

  it('audits the MERGED post-update attributes, not just the supplied keys', async () => {
    await filterService.update('f1', { micronSize: '0.5' }, ctx);
    const entry = (auditLog as any).mock.calls[0][0];
    expect(entry.action).toBe('ASSET_UPDATED');
    expect(entry.afterValue.attributes).toEqual({ ...stored, micronSize: '0.5' });
  });
});

// #222 / #223 — deleting a filter must not strand its cycle or its RFID tag.
describe('filterService.softDelete', () => {
  beforeEach(() => {
    (prisma.filter.findUnique as any).mockResolvedValue({ id: 'f1', name: 'F1' });
  });

  it('refuses with 409 when the filter has an IN_PROGRESS cleaning cycle', async () => {
    (prisma.filterDetails.findUnique as any).mockResolvedValue({ currentCycleId: 'c1' });
    (prisma.cleaningCycle.findFirst as any).mockResolvedValue({ cycleCode: 'CY-001' });
    await expect(filterService.softDelete('f1', ctx)).rejects.toMatchObject({ statusCode: 409, code: 'FILTER_CYCLE_IN_PROGRESS' });
    expect(prisma.filter.update).not.toHaveBeenCalled();
  });

  it('allows the delete when currentCycleId points at an already-finished cycle', async () => {
    (prisma.filterDetails.findUnique as any).mockResolvedValue({ currentCycleId: 'c1' });
    (prisma.cleaningCycle.findFirst as any).mockResolvedValue(null); // status filter excludes it
    await filterService.softDelete('f1', ctx);
    expect((prisma.filter.update as any).mock.calls[0][0].data.isActive).toBe(false);
  });

  it('cascades the RFID identifiers so the tag is free for the replacement filter', async () => {
    (prisma.assetIdentifier.findMany as any).mockResolvedValue([{ id: 'i1', assetId: 'f1', identifierType: 'RFID', identifierValue: 'TAG-1' }]);
    await filterService.softDelete('f1', ctx);
    expect(prisma.assetIdentifier.deleteMany).toHaveBeenCalledWith({ where: { assetId: 'f1' } });
  });

  it('writes an ASSET_IDENTIFIER_DELETED audit row per cascaded tag, in-tx, in the RFID-report shape', async () => {
    (prisma.assetIdentifier.findMany as any).mockResolvedValue([{ id: 'i1', assetId: 'f1', identifierType: 'RFID', identifierValue: 'TAG-1' }]);
    await filterService.softDelete('f1', ctx);
    const call = (auditLog as any).mock.calls.find((c: any[]) => c[0].action === 'ASSET_IDENTIFIER_DELETED');
    expect(call).toBeDefined();
    expect(call[0].beforeValue).toEqual({ assetId: 'f1', identifierType: 'RFID', identifierValue: 'TAG-1', filterName: 'F1' });
    expect(call[1]).toBeDefined(); // tx handle — the row is the only surviving evidence
  });

  it('still writes the ASSET_DELETED audit row', async () => {
    await filterService.softDelete('f1', ctx);
    expect((auditLog as any).mock.calls.some((c: any[]) => c[0].action === 'ASSET_DELETED')).toBe(true);
  });
});
