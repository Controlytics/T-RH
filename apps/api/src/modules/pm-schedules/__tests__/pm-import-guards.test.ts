import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    systemConfig: { findUnique: vi.fn() },
    assetInstance: { findMany: vi.fn() },
    pmSchedule: { findFirst: vi.fn(), create: vi.fn() },
    pmScheduleEntry: { count: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    pmExecution: { count: vi.fn(), deleteMany: vi.fn() },
    // Interactive form — hand the callback the same mocked client.
    $transaction: vi.fn(),
  },
}));
vi.mock('../pm-shared.js', () => ({ checkPmEnabled: vi.fn(async () => {}) }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn() }));
vi.mock('../pm-workflow.js', () => ({
  getPmWorkflowConfig: vi.fn(),
  // These fixtures mock a workflow config with no uploadRole, and the real
  // assertPmRole no-ops when the configured role is unset — so a bare stub
  // matches production behaviour here. uploadRole enforcement itself is covered
  // in upload-role.test.ts against the real implementation.
  assertPmRole: vi.fn(),
  generateQnn: vi.fn(async () => 'QNN-0001'),
}));

import { importSchedules } from '../pm-import.js';
import { prisma } from '../../../lib/prisma.js';
import { getPmWorkflowConfig } from '../pm-workflow.js';

const P = prisma as any;
const ctx = { userId: 'tester', userSub: 'user-1', userRole: 'ADMIN', ipAddress: '::1', userAgent: 'vitest' } as any;

const ROW = { ahu_name: 'AHU-01', scheduled_date: '2026-04-12', tolerance_days: '3' };

beforeEach(() => {
  vi.clearAllMocks();
  P.systemConfig.findUnique.mockResolvedValue({ configValue: {} });
  P.assetInstance.findMany.mockResolvedValue([{ id: 'ahu-1', name: 'AHU-01' }]);
  P.pmSchedule.findFirst.mockResolvedValue({ id: 'sched-1', version: 1 });
  P.pmExecution.count.mockResolvedValue(0);
  P.pmScheduleEntry.count.mockResolvedValue(0);
  P.pmScheduleEntry.findMany.mockResolvedValue([{ id: 'entry-1', month: 4 }]);
  P.pmScheduleEntry.createMany.mockResolvedValue({ count: 1 });
  P.pmScheduleEntry.deleteMany.mockResolvedValue({ count: 0 });
  P.$transaction.mockImplementation(async (fn: any) => fn(P));
  (getPmWorkflowConfig as any).mockResolvedValue({ workflowEnabled: false });
});

describe('importSchedules — execution-evidence guard', () => {
  it('refuses to replace a schedule that has recorded executions, and deletes nothing', async () => {
    P.pmExecution.count.mockResolvedValue(2);

    const r = await importSchedules(ctx, [ROW]);

    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.details.skipped[0].reason).toMatch(/2 recorded execution\(s\)/);
    expect(r.details.skipped[0].reason).toContain('AHU-01');
    // The wipe must not have run in any form.
    expect(P.pmExecution.deleteMany).not.toHaveBeenCalled();
    expect(P.pmScheduleEntry.deleteMany).not.toHaveBeenCalled();
    expect(P.pmScheduleEntry.createMany).not.toHaveBeenCalled();
  });

  it('never deletes PmExecution rows even on the happy path', async () => {
    await importSchedules(ctx, [ROW]);
    expect(P.pmExecution.deleteMany).not.toHaveBeenCalled();
  });
});

describe('importSchedules — approved-entry guard', () => {
  it('refuses to wipe APPROVED entries when the review workflow is enabled', async () => {
    (getPmWorkflowConfig as any).mockResolvedValue({ workflowEnabled: true });
    P.pmScheduleEntry.count.mockResolvedValue(3);

    const r = await importSchedules(ctx, [ROW]);

    expect(r.imported).toBe(0);
    expect(r.details.skipped[0].reason).toMatch(/3 APPROVED entries/);
    expect(P.pmScheduleEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('allows the legacy hard-replace of APPROVED entries when the workflow is OFF', async () => {
    (getPmWorkflowConfig as any).mockResolvedValue({ workflowEnabled: false });
    P.pmScheduleEntry.count.mockResolvedValue(3);

    const r = await importSchedules(ctx, [ROW]);

    expect(r.imported).toBe(1);
    expect(P.pmScheduleEntry.deleteMany).toHaveBeenCalled();
  });
});

describe('importSchedules — per-schedule atomicity', () => {
  it('wipes and repopulates inside one transaction', async () => {
    await importSchedules(ctx, [ROW]);

    expect(P.$transaction).toHaveBeenCalledTimes(1);
    // Both halves of the hard-replace ran against the tx client.
    expect(P.pmScheduleEntry.deleteMany).toHaveBeenCalledWith({ where: { scheduleId: 'sched-1' } });
    expect(P.pmScheduleEntry.createMany).toHaveBeenCalled();
  });

  it('opens ONE transaction per (AHU, year) regardless of row count', async () => {
    P.pmScheduleEntry.findMany.mockResolvedValue([{ id: 'e4', month: 4 }, { id: 'e5', month: 5 }]);

    await importSchedules(ctx, [ROW, { ...ROW, scheduled_date: '2026-05-12' }]);

    expect(P.$transaction).toHaveBeenCalledTimes(1);
    expect(P.pmScheduleEntry.createMany).toHaveBeenCalledTimes(1);
    // Both months land in the single createMany payload.
    expect(P.pmScheduleEntry.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('rolls a failed schedule back and reports every one of its rows as skipped', async () => {
    P.$transaction.mockRejectedValue(new Error('deadlock detected'));

    const r = await importSchedules(ctx, [ROW, { ...ROW, scheduled_date: '2026-05-12' }]);

    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(2);
    expect(r.details.skipped.every((s: any) => /deadlock detected/.test(s.reason))).toBe(true);
  });

  it('isolates a blocked schedule from a healthy one in the same file', async () => {
    P.assetInstance.findMany.mockResolvedValue([
      { id: 'ahu-1', name: 'AHU-01' },
      { id: 'ahu-2', name: 'AHU-02' },
    ]);
    P.pmSchedule.findFirst.mockImplementation(async (args: any) =>
      args.where.entityId === 'ahu-1' ? { id: 'sched-1', version: 1 } : { id: 'sched-2', version: 1 },
    );
    // Only AHU-01's schedule carries executions.
    P.pmExecution.count.mockImplementation(async (args: any) =>
      args.where.scheduleEntry.scheduleId === 'sched-1' ? 1 : 0,
    );

    const r = await importSchedules(ctx, [ROW, { ...ROW, ahu_name: 'AHU-02' }]);

    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.details.imported[0].ahuName).toBe('AHU-02');
    expect(r.details.skipped[0].reason).toContain('AHU-01');
  });
});
