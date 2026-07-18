import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * "Test the overwrite and QNN" (2026-07-16).
 *
 * Overwriting a PM schedule routes through `editApprovedEntry` (the pending-edit
 * flow): it stages the new date as a pending change, sends the entry back to
 * review (PENDING_REVIEW when the workflow is on), and raises a QNN. The QNN's
 * notification must reach the REVIEW role — the fix this run made in
 * generateQnn (EDIT/RESUBMIT were previously unrouted).
 *
 * prisma + the leaf I/O (createNotification, format-datetime, audit) are mocked;
 * editApprovedEntry, getPmWorkflowConfig and generateQnn run for real, so this
 * exercises the whole overwrite→QNN chain against mocked storage.
 */
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    systemConfig: { findUnique: vi.fn() },
    pmScheduleEntry: { findUnique: vi.fn(), update: vi.fn() },
    qualityNotification: { create: vi.fn() },
    assetInstance: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../pm-shared.js', () => ({ checkPmEnabled: vi.fn(async () => {}) }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('../../../lib/format-datetime.js', () => ({ formatConfiguredDateTime: vi.fn(async () => '16 Jul 2026, 18:00') }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification: vi.fn(async () => ({})) }));

import { editApprovedEntry } from '../pm-approval.js';
import { generateQnn } from '../pm-workflow.js';
import { createNotification } from '../../notifications/notification.service.js';

const P = mockPrisma as any;
const CN = createNotification as any;
const ctx = { userId: 'supervisor1', userSub: 'sub-1', userRole: 'SUPERVISOR', ipAddress: '::1', userAgent: 'vitest' } as any;

// Workflow ON, reviewer MANAGER, approver QA — mirrors the live config.
const WF_CONFIG = { configValue: { workflowEnabled: true, uploadRole: 'SUPERVISOR', reviewRole: 'MANAGER', approvalRole: 'QA' } };

const APPROVED_ENTRY = {
  id: 'entry-1', month: 3, plannedDate: new Date('2026-03-15'), toleranceDays: 5,
  approvalStatus: 'APPROVED', scheduleId: 'sched-1', schedule: { id: 'sched-1', entityId: 'ahu-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  P.systemConfig.findUnique.mockResolvedValue(WF_CONFIG);
  P.pmScheduleEntry.findUnique.mockResolvedValue(APPROVED_ENTRY);
  P.pmScheduleEntry.update.mockImplementation(async ({ data }: any) => ({ ...APPROVED_ENTRY, ...data }));
  P.qualityNotification.create.mockResolvedValue({});
  P.assetInstance.findMany.mockResolvedValue([{ id: 'ahu-1', name: 'AHU-01' }]);
  P.$queryRaw.mockResolvedValue([{ seq: 42n }]);
});

describe('overwrite = editApprovedEntry (pending edit + QNN)', () => {
  it('stages the new date as a pending change and sends the entry to PENDING_REVIEW', async () => {
    await editApprovedEntry(ctx, 'entry-1', { plannedDate: '2026-07-20', toleranceDays: 3 });

    expect(P.pmScheduleEntry.update).toHaveBeenCalledTimes(1);
    const data = P.pmScheduleEntry.update.mock.calls[0][0].data;
    // The current date is NOT changed — the new date rides as a pending edit.
    expect(data.pendingPlannedDate).toBeInstanceOf(Date);
    expect(data.pendingPlannedDate.toISOString().slice(0, 10)).toBe('2026-07-20');
    expect(data.pendingToleranceDays).toBe(3);
    expect(data.approvalStatus).toBe('PENDING_REVIEW');
    // The live plannedDate stays untouched (stays active until approved).
    expect(data.plannedDate).toBeUndefined();
  });

  it('raises a QNN (action EDIT) for the entry', async () => {
    await editApprovedEntry(ctx, 'entry-1', { plannedDate: '2026-07-20' });

    expect(P.qualityNotification.create).toHaveBeenCalledTimes(1);
    const qnn = P.qualityNotification.create.mock.calls[0][0].data;
    expect(qnn.action).toBe('EDIT');
    expect(qnn.pmScheduleEntryId).toBe('entry-1');
    expect(qnn.scheduleId).toBe('sched-1');
  });

  it('routes the QNN notification to the REVIEW role (MANAGER)', async () => {
    await editApprovedEntry(ctx, 'entry-1', { plannedDate: '2026-07-20' });

    expect(CN).toHaveBeenCalledTimes(1);
    const note = CN.mock.calls[0][0];
    expect(note.type).toBe('PM_SCHEDULE_QNN');
    expect(note.forRole).toBe('MANAGER'); // the fix — EDIT was previously unrouted
  });

  it('refuses to overwrite an entry that is not yet approved', async () => {
    P.pmScheduleEntry.findUnique.mockResolvedValue({ ...APPROVED_ENTRY, approvalStatus: 'PENDING_REVIEW' });

    await expect(editApprovedEntry(ctx, 'entry-1', { plannedDate: '2026-07-20' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATUS' });
    expect(P.pmScheduleEntry.update).not.toHaveBeenCalled();
    expect(P.qualityNotification.create).not.toHaveBeenCalled();
  });
});

describe('generateQnn — QNN role routing matrix', () => {
  const qnnFor = async (action: any) => {
    await generateQnn(action, { pmScheduleEntryId: 'e', scheduleId: 's', ahuName: 'AHU-01' }, ctx);
    return CN.mock.calls[0][0].forRole;
  };

  it('routes EDIT (overwrite) to the review role', async () => {
    expect(await qnnFor('EDIT')).toBe('MANAGER');
  });
  it('routes RESUBMIT to the review role', async () => {
    expect(await qnnFor('RESUBMIT')).toBe('MANAGER');
  });
  it('routes UPLOAD to the review role (unchanged)', async () => {
    expect(await qnnFor('UPLOAD')).toBe('MANAGER');
  });
  it('routes REVIEW to the approval role (unchanged)', async () => {
    expect(await qnnFor('REVIEW')).toBe('QA');
  });
  it('leaves APPROVE unrouted (unchanged)', async () => {
    expect(await qnnFor('APPROVE')).toBeUndefined();
  });

  it('always records the QualityNotification row regardless of routing', async () => {
    await generateQnn('APPROVE', { pmScheduleEntryId: 'e', scheduleId: 's' }, ctx);
    expect(P.qualityNotification.create).toHaveBeenCalledTimes(1);
    expect(P.qualityNotification.create.mock.calls[0][0].data.action).toBe('APPROVE');
  });
});
