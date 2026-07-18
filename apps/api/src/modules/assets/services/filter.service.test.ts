import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    filter: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    filterDetails: { findUnique: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../lib/audit.js', () => ({
  auditLog: vi.fn(),
}));

vi.mock('./filter-fields.service.js', () => ({
  // update() walks this list to spot explicitly-cleared fields, so the mock
  // must export it alongside the builder.
  FILTER_ATTRIBUTE_FIELDS: ['ahuType', 'filterType', 'micronSize', 'filterSize', 'lastCleaningDate'],
  validateAndBuildFilterAttributes: vi.fn(async () => ({ attributes: { micronSize: '5' }, errors: [] })),
}));

vi.mock('./identifier.service.js', () => ({
  identifierService: {},
}));

import { filterService } from './filter.service.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';

const ctx = { userId: 'u1', userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 't', sessionId: 's' } as any;

describe('filterService.update — audit before/after', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const txMock = {
        filter: { update: vi.fn().mockResolvedValue({ id: 'f1', name: 'NEW', attributes: { micronSize: '5' } }) },
        filterDetails: { upsert: vi.fn() },
      };
      return cb(txMock);
    });
  });

  it('records the pre-edit values in beforeValue', async () => {
    vi.mocked(prisma.filter.findUnique).mockResolvedValue({ id: 'f1', name: 'OLD', attributes: { micronSize: '3' } } as any);
    vi.mocked(prisma.filter.findFirst).mockResolvedValue(null); // no name dupe
    vi.mocked(prisma.filterDetails.findUnique).mockResolvedValue({ filterSet: 'SET_A' } as any);

    await filterService.update('f1', { name: 'NEW' } as any, ctx);

    expect(auditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(auditLog).mock.calls[0][0];
    expect(entry.action).toBe('ASSET_UPDATED');
    expect(entry.beforeValue).toMatchObject({ name: 'OLD', filterSet: 'SET_A', attributes: { micronSize: '3' }, templateKind: 'FILTER' });
    expect(entry.afterValue).toMatchObject({ name: 'NEW', templateKind: 'FILTER' });
  });

  it('keeps name/filterSet symmetric on an attributes-only edit', async () => {
    vi.mocked(prisma.filter.findUnique).mockResolvedValue({ id: 'f1', name: 'OLD', attributes: { micronSize: '3' } } as any);
    vi.mocked(prisma.filterDetails.findUnique).mockResolvedValue({ filterSet: 'SET_A' } as any);

    await filterService.update('f1', { micronSize: '9' } as any, ctx); // NO name, NO filterSet

    const e = vi.mocked(auditLog).mock.calls[0][0];
    expect(e.afterValue.name).toBe(e.beforeValue.name);
    expect(e.afterValue.filterSet).toBe(e.beforeValue.filterSet);
    expect(e.afterValue.name).toBe('OLD');
    expect(e.afterValue.filterSet).toBe('SET_A');
  });
});
