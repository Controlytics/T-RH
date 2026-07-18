import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    pmSchedule: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    // Array form — resolve the ops as handed in.
    $transaction: vi.fn(),
  },
}));
vi.mock('../pm-shared.js', () => ({ checkPmEnabled: vi.fn(async () => {}) }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn() }));

import { update } from '../pm-schedule-crud.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';

const P = prisma as any;
const ctx = { userId: 'tester', userSub: 'user-1', userRole: 'ADMIN', ipAddress: '::1', userAgent: 'vitest' } as any;

const EXISTING = { id: 'sched-1', entityId: 'ahu-1', year: 2026, version: 1, entries: [] };
const VALID_ENTRIES = [{ month: 4, plannedDate: '2026-04-12', toleranceDays: 3 }];

beforeEach(() => {
  vi.clearAllMocks();
  P.pmSchedule.findUnique.mockResolvedValue(EXISTING);
  P.pmSchedule.update.mockResolvedValue({ ...EXISTING, status: 'ARCHIVED' });
  P.pmSchedule.create.mockResolvedValue({ id: 'sched-2', version: 2, entries: [] });
  P.$transaction.mockImplementation(async (ops: any[]) => Promise.all(ops));
});

describe('update — entry validation precedes any write', () => {
  // The archive is destructive and irreversible in-request: a throw after it
  // would leave the AHU/year with no ACTIVE schedule and silently halt PM tasks.
  it.each([
    ['an empty body', {}],
    ['an empty entries array', { entries: [] }],
    ['a non-array entries value', { entries: 'oops' }],
    ['a null entries value', { entries: null }],
  ])('rejects %s WITHOUT archiving the existing schedule', async (_label, body) => {
    await expect(update(ctx, 'sched-1', body)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });

    expect(P.pmSchedule.update).not.toHaveBeenCalled();
    expect(P.pmSchedule.create).not.toHaveBeenCalled();
    expect(P.$transaction).not.toHaveBeenCalled();
  });

  it('validates before even reading the schedule (404 cannot mask a bad body)', async () => {
    await expect(update(ctx, 'sched-1', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(P.pmSchedule.findUnique).not.toHaveBeenCalled();
  });

  it('still 404s for a missing schedule when the body is valid', async () => {
    P.pmSchedule.findUnique.mockResolvedValue(null);
    await expect(update(ctx, 'nope', { entries: VALID_ENTRIES })).rejects.toMatchObject({ statusCode: 404 });
    expect(P.pmSchedule.update).not.toHaveBeenCalled();
  });
});

describe('update — archive + recreate atomicity', () => {
  it('archives and recreates in a single transaction, bumping the version', async () => {
    const result = await update(ctx, 'sched-1', { entries: VALID_ENTRIES });

    expect(P.$transaction).toHaveBeenCalledTimes(1);
    expect(P.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(P.pmSchedule.update).toHaveBeenCalledWith({ where: { id: 'sched-1' }, data: { status: 'ARCHIVED' } });
    expect(P.pmSchedule.create.mock.calls[0][0].data).toMatchObject({ version: 2, status: 'ACTIVE' });
    expect(result).toMatchObject({ id: 'sched-2' });
  });

  it('derives the tolerance window from plannedDate ± toleranceDays', async () => {
    await update(ctx, 'sched-1', { entries: [{ month: 4, plannedDate: '2026-04-12', toleranceDays: 2 }] });

    const [entry] = P.pmSchedule.create.mock.calls[0][0].data.entries.create;
    expect(entry.windowStart.toISOString()).toBe('2026-04-10T00:00:00.000Z');
    expect(entry.windowEnd.toISOString()).toBe('2026-04-14T00:00:00.000Z');
  });

  it('does not audit when the transaction fails', async () => {
    P.$transaction.mockRejectedValue(new Error('serialization failure'));
    await expect(update(ctx, 'sched-1', { entries: VALID_ENTRIES })).rejects.toThrow('serialization failure');
    expect(auditLog).not.toHaveBeenCalled();
  });
});
