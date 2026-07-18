import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    systemConfig: { findUnique: vi.fn() },
    pmScheduleEntry: { findMany: vi.fn() },
    assetInstance: { findMany: vi.fn() },
    cleaningCycle: { groupBy: vi.fn() },
    filterEvent: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    deviation: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));
// resolvePmReasonKeys is stubbed per-test via P.pmReasonKeys (see beforeEach):
// null = no PM reason configured (legacy any-reason fallback), a Set = only those
// reasons satisfy a scheduled PM.
vi.mock('../pm-shared.js', () => ({
  checkPmEnabled: vi.fn(async () => {}),
  resolvePmReasonKeys: vi.fn(async () => null),
}));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn() }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification: vi.fn(async () => ({})) }));

import { sweepOverdueDeviations, acknowledgeDeviation, dayDiff } from '../pm-deviations.js';
import { prisma } from '../../../lib/prisma.js';
import { createNotification } from '../../notifications/notification.service.js';
import { resolvePmReasonKeys } from '../pm-shared.js';
import { auditLog } from '../../../lib/audit.js';

const P = prisma as any;

// assetInstance.findMany is called twice in loadCountedFilters (Promise.all):
// once for the AHUs (where.id) and once for child filters (where.parentId).
// Route by the where shape so order-independence holds.
function wireAhuWithFilters(ahu: { id: string; name: string; mode?: string }, filters: { id: string; name: string; filterSet?: string | null }[]) {
  P.assetInstance.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.parentId) {
      return filters.map((f) => ({ id: f.id, name: f.name, parentId: ahu.id, filterDetails: { filterSet: f.filterSet ?? null } }));
    }
    return [{ id: ahu.id, name: ahu.name, customAttributes: ahu.mode ? { pmFilterSetMode: ahu.mode } : {} }];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  P.systemConfig.findUnique.mockResolvedValue({ configValue: {} }); // → default ['ADMIN']
  P.pmScheduleEntry.findMany.mockResolvedValue([]);
  P.deviation.findMany.mockResolvedValue([]);
  P.cleaningCycle.groupBy.mockResolvedValue([]);
  P.assetInstance.findMany.mockResolvedValue([]);
  P.deviation.update.mockResolvedValue({});
  (resolvePmReasonKeys as any).mockResolvedValue(null); // default: legacy any-reason fallback
});

describe('dayDiff', () => {
  it('counts whole days (to − from), floored at 0', () => {
    const d = (s: string) => new Date(s);
    expect(dayDiff(d('2026-06-03T00:00:00Z'), d('2026-06-03T00:00:00Z'))).toBe(0);
    expect(dayDiff(d('2026-06-08T00:00:00Z'), d('2026-06-03T00:00:00Z'))).toBe(5);
    expect(dayDiff(d('2026-06-03T23:59:00Z'), d('2026-06-03T00:00:00Z'))).toBe(0); // partial day floors
    expect(dayDiff(d('2026-06-01T00:00:00Z'), d('2026-06-03T00:00:00Z'))).toBe(0); // future → 0
  });
});

describe('sweepOverdueDeviations — OPEN', () => {
  const entry = {
    id: 'entry-1', plannedDate: new Date('2026-05-16'),
    windowStart: new Date('2026-05-06'), windowEnd: new Date('2026-05-26'),
    schedule: { entityId: 'ahu-1' },
  };

  it('opens a deviation + fires one overdue notification when filters are not all cleaned', async () => {
    P.pmScheduleEntry.findMany.mockResolvedValue([entry]);
    wireAhuWithFilters({ id: 'ahu-1', name: 'AHU-02' }, [{ id: 'f1', name: 'F1' }, { id: 'f2', name: 'F2' }]);
    P.cleaningCycle.groupBy.mockResolvedValue([]); // nothing cleaned → overdue
    P.deviation.create.mockResolvedValue({ id: 'dev-1', deviationNumber: 'DEV-000001', scheduledDate: entry.plannedDate, pmScheduleEntryId: 'entry-1' });

    const r = await sweepOverdueDeviations();
    expect(r.opened).toBe(1);
    expect(P.deviation.create).toHaveBeenCalledTimes(1);
    const created = P.deviation.create.mock.calls[0][0].data;
    expect(created.pmScheduleEntryId).toBe('entry-1');
    expect(created.filterCount).toBe(2);
    expect(created.status).toBe('OPEN');
    expect(createNotification).toHaveBeenCalledTimes(1); // forRole ADMIN (default)
    expect((createNotification as any).mock.calls[0][0].type).toBe('PM_OVERDUE');
    expect((createNotification as any).mock.calls[0][0].forRole).toBe('ADMIN');
  });

  it('is idempotent — a unique-violation (P2002) on create opens nothing and sends no notification', async () => {
    P.pmScheduleEntry.findMany.mockResolvedValue([entry]);
    wireAhuWithFilters({ id: 'ahu-1', name: 'AHU-02' }, [{ id: 'f1', name: 'F1' }]);
    P.cleaningCycle.groupBy.mockResolvedValue([]);
    P.deviation.create.mockRejectedValue({ code: 'P2002' });

    const r = await sweepOverdueDeviations();
    expect(r.opened).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does NOT open a deviation when all counted filters are already cleaned', async () => {
    P.pmScheduleEntry.findMany.mockResolvedValue([entry]);
    wireAhuWithFilters({ id: 'ahu-1', name: 'AHU-02' }, [{ id: 'f1', name: 'F1' }]);
    P.cleaningCycle.groupBy.mockResolvedValue([{ filterId: 'f1', _max: { completedAt: new Date('2026-05-20') } }]);

    const r = await sweepOverdueDeviations();
    expect(r.opened).toBe(0);
    expect(P.deviation.create).not.toHaveBeenCalled();
  });

  it('skips AHUs whose filter-set mode is DISABLED', async () => {
    P.pmScheduleEntry.findMany.mockResolvedValue([entry]);
    wireAhuWithFilters({ id: 'ahu-1', name: 'AHU-02', mode: 'DISABLED' }, [{ id: 'f1', name: 'F1' }]);
    const r = await sweepOverdueDeviations();
    expect(r.opened).toBe(0);
    expect(P.deviation.create).not.toHaveBeenCalled();
  });

  // M44: only a PM-reason clean satisfies a scheduled PM. An unrelated clean
  // must NOT suppress the deviation — otherwise an overdue PM goes unrecorded.
  it('scopes the cleaned-predicate to the configured PM reason keys', async () => {
    (resolvePmReasonKeys as any).mockResolvedValue(new Set(['PM']));
    P.pmScheduleEntry.findMany.mockResolvedValue([entry]);
    wireAhuWithFilters({ id: 'ahu-1', name: 'AHU-02' }, [{ id: 'f1', name: 'F1' }]);
    P.cleaningCycle.groupBy.mockResolvedValue([]);
    P.deviation.create.mockResolvedValue({ id: 'dev-1', deviationNumber: 'DEV-000001', scheduledDate: entry.plannedDate, pmScheduleEntryId: 'entry-1' });

    await sweepOverdueDeviations();
    // The DB query itself must carry the reason filter — a non-PM clean can then
    // never land in latestCleanMap and can never suppress the deviation.
    expect(P.cleaningCycle.groupBy.mock.calls[0][0].where.cleaningReasonKey).toEqual({ in: ['PM'] });
  });

  it('applies NO reason filter when no PM reason is configured (legacy fallback)', async () => {
    (resolvePmReasonKeys as any).mockResolvedValue(null);
    P.pmScheduleEntry.findMany.mockResolvedValue([entry]);
    wireAhuWithFilters({ id: 'ahu-1', name: 'AHU-02' }, [{ id: 'f1', name: 'F1' }]);
    P.cleaningCycle.groupBy.mockResolvedValue([]);
    P.deviation.create.mockResolvedValue({ id: 'dev-1', deviationNumber: 'DEV-1', scheduledDate: entry.plannedDate, pmScheduleEntryId: 'entry-1' });

    await sweepOverdueDeviations();
    expect(P.cleaningCycle.groupBy.mock.calls[0][0].where.cleaningReasonKey).toBeUndefined();
  });
});

// M45: the UNIQUE(pm_schedule_entry_id) collision means a re-overdue task whose
// deviation is already CLOSED cannot be recorded. That must never be silent.
describe('sweepOverdueDeviations — blocked re-occurrence (P2002 on a CLOSED deviation)', () => {
  const entry = {
    id: 'entry-1', plannedDate: new Date('2026-05-16'),
    windowStart: new Date('2026-05-06'), windowEnd: new Date('2026-05-26'),
    schedule: { entityId: 'ahu-1' },
  };

  beforeEach(() => {
    P.pmScheduleEntry.findMany.mockResolvedValue([entry]);
    wireAhuWithFilters({ id: 'ahu-1', name: 'AHU-02' }, [{ id: 'f1', name: 'F1' }]);
    P.cleaningCycle.groupBy.mockResolvedValue([]); // nothing cleaned → overdue
    P.deviation.create.mockRejectedValue({ code: 'P2002' });
  });

  it('audits + notifies + counts the blocked re-occurrence when the existing deviation is CLOSED', async () => {
    P.deviation.findUnique.mockResolvedValue({ id: 'dev-old', deviationNumber: 'DEV-000001', status: 'CLOSED' });

    const r = await sweepOverdueDeviations();
    expect(r.opened).toBe(0);
    expect(r.blocked).toBe(1);

    // Loud: an audit row naming the task, the blocking deviation and the reason.
    const call = (auditLog as any).mock.calls.find((c: any) => c[0].action === 'DEVIATION_OPEN_BLOCKED');
    expect(call).toBeTruthy();
    expect(call[0].targetId).toBe('dev-old');
    expect(call[0].afterValue.pmScheduleEntryId).toBe('entry-1');
    expect(call[0].beforeValue.existingDeviationNumber).toBe('DEV-000001');

    // ...and a notification to the configured roles (ADMIN by default).
    expect((createNotification as any).mock.calls.some(
      (c: any) => c[0].metadata?.kind === 'PM_DEVIATION_BLOCKED' && c[0].forRole === 'ADMIN',
    )).toBe(true);
  });

  it('stays silent when the existing deviation is still OPEN — that collision is the intended idempotency', async () => {
    P.deviation.findUnique.mockResolvedValue({ id: 'dev-old', deviationNumber: 'DEV-000001', status: 'OPEN' });

    const r = await sweepOverdueDeviations();
    expect(r.blocked).toBe(0);
    expect((auditLog as any).mock.calls.some((c: any) => c[0].action === 'DEVIATION_OPEN_BLOCKED')).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does NOT reopen or mutate the closed deviation (its completion record is regulated data)', async () => {
    P.deviation.findUnique.mockResolvedValue({ id: 'dev-old', deviationNumber: 'DEV-000001', status: 'CLOSED' });
    await sweepOverdueDeviations();
    expect(P.deviation.update).not.toHaveBeenCalled();
  });

  it('does not abort the sweep — the CLOSE half still runs after a blocked entry', async () => {
    P.deviation.findUnique.mockResolvedValue({ id: 'dev-old', deviationNumber: 'DEV-000001', status: 'CLOSED' });
    P.deviation.findMany.mockResolvedValue([{
      id: 'dev-2', deviationNumber: 'DEV-000002', ahuName: 'PC', filterIds: ['f9'],
      scheduledDate: new Date('2026-05-22'), windowStart: new Date('2026-05-13'),
      overdueDaysAtOpen: 12, acknowledgedBy: 'u1', acknowledgedByName: 'operator1', completionNotifiedAt: null,
    }]);
    // f9 is PM-cleaned → the open deviation dev-2 closes despite entry-1 blocking.
    P.cleaningCycle.groupBy.mockResolvedValue([{ filterId: 'f9', _max: { completedAt: new Date('2026-06-03') } }]);

    const r = await sweepOverdueDeviations();
    expect(r.blocked).toBe(1);
    expect(r.closed).toBe(1);
  });
});

describe('sweepOverdueDeviations — CLOSE', () => {
  it('closes an open deviation once all its filters are cleaned + fires completion notification', async () => {
    P.deviation.findMany.mockResolvedValue([{
      id: 'dev-1', deviationNumber: 'DEV-000001', ahuName: 'PC',
      filterIds: ['f1'], scheduledDate: new Date('2026-05-22'), windowStart: new Date('2026-05-13'),
      overdueDaysAtOpen: 12, acknowledgedBy: 'u1', acknowledgedByName: 'operator1', completionNotifiedAt: null,
    }]);
    P.cleaningCycle.groupBy.mockResolvedValue([{ filterId: 'f1', _max: { completedAt: new Date('2026-06-03') } }]);

    const r = await sweepOverdueDeviations();
    expect(r.closed).toBe(1);
    const upd = P.deviation.update.mock.calls.find((c: any) => c[0].data.status === 'CLOSED');
    expect(upd).toBeTruthy();
    expect(upd[0].data.completedByName).toBe('operator1'); // acknowledger wins
    expect(upd[0].data.delayDays).toBeGreaterThan(0);
    expect((createNotification as any).mock.calls.some((c: any) => c[0].type === 'PM_OVERDUE_COMPLETED')).toBe(true);
  });

  it('does not close while any filter is still uncleaned', async () => {
    P.deviation.findMany.mockResolvedValue([{
      id: 'dev-1', deviationNumber: 'DEV-1', ahuName: 'PC', filterIds: ['f1', 'f2'],
      scheduledDate: new Date('2026-05-22'), windowStart: new Date('2026-05-13'), overdueDaysAtOpen: 12,
      acknowledgedBy: null, completionNotifiedAt: null,
    }]);
    P.cleaningCycle.groupBy.mockResolvedValue([{ filterId: 'f1', _max: { completedAt: new Date('2026-06-03') } }]); // only f1
    P.filterEvent.findFirst.mockResolvedValue(null);

    const r = await sweepOverdueDeviations();
    expect(r.closed).toBe(0);
  });
});

describe('acknowledgeDeviation', () => {
  const ctx = { userSub: 'u1', userId: 'operator1', userRole: 'OPERATOR', ipAddress: '127.0.0.1', sessionId: 's1' } as any;

  it('records ACKNOWLEDGED + passwordVerified + the operator identity', async () => {
    P.deviation.findUnique.mockResolvedValue({ id: 'dev-1', deviationNumber: 'DEV-1', ahuName: 'PC', status: 'OPEN', overdueDaysAtOpen: 5, assignedUserId: null });
    P.deviation.update.mockResolvedValue({ id: 'dev-1', status: 'ACKNOWLEDGED', passwordVerified: true });
    await acknowledgeDeviation(ctx, 'dev-1');
    const data = P.deviation.update.mock.calls[0][0].data;
    expect(data.status).toBe('ACKNOWLEDGED');
    expect(data.passwordVerified).toBe(true);
    expect(data.acknowledgedBy).toBe('u1');
    expect(data.acknowledgedByName).toBe('operator1');
  });

  it('rejects acknowledging an already-closed deviation', async () => {
    P.deviation.findUnique.mockResolvedValue({ id: 'dev-1', status: 'CLOSED', ahuName: 'PC' });
    await expect(acknowledgeDeviation(ctx, 'dev-1')).rejects.toThrow(/closed/i);
  });

  it('404s on a missing deviation', async () => {
    P.deviation.findUnique.mockResolvedValue(null);
    await expect(acknowledgeDeviation(ctx, 'nope')).rejects.toThrow(/not found/i);
  });
});
