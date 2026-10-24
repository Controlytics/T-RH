import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 2026-10-24 (operator: "when im giving request approval request is not coming
 * why"): a super admin's request that nobody else can decide was accepted and
 * toasted "The approvers have been notified" — nobody had been. The server now
 * returns how many approvers were notified; zero is its own outcome, and the
 * toast says so in amber.
 */
const created = { current: {} as Record<string, unknown> };
vi.mock('../report-review', () => ({
  submitReportForReview: vi.fn(async () => created.current),
  fileSlug: (s: string) => s,
}));
vi.mock('../report-export-log', () => ({ logReportExport: vi.fn(async () => undefined) }));

const { deliverReport, deliveryToast } = await import('../report-delivery');

const request = () => deliverReport({
  kind: 'data-report',
  req: { mode: 'REQUEST', remarks: 'r' } as never,
  report: { getSnapshot: () => ({}), save: vi.fn() } as never,
  reportType: 'Instrument Time Series', title: 'T', requestMeta: {} as never, instrumentIds: ['i1'],
});

beforeEach(() => { created.current = {}; });

describe('deliverReport — a request nobody else can decide', () => {
  it('with approvers notified: REQUESTED, a success toast', async () => {
    created.current = { id: 'r1', eligibleApproverCount: 2 };
    const outcome = await request();
    expect(outcome).toBe('REQUESTED');
    expect(deliveryToast(outcome)).toMatchObject({ tone: 'success', title: 'Sent for approval' });
  });

  it('with nobody notified: its own outcome, and the toast is a WARNING that says so', async () => {
    created.current = { id: 'r1', eligibleApproverCount: 0 };
    const outcome = await request();
    expect(outcome).toBe('REQUESTED_NO_APPROVER');
    const t = deliveryToast(outcome);
    expect(t.tone).toBe('warning');
    expect(t.message).toMatch(/nobody was notified/);
    expect(t.message).not.toMatch(/have been notified/);
  });

  it('a response without the count (an older server) reads as REQUESTED, never as "nobody"', async () => {
    created.current = { id: 'r1' };
    expect(await request()).toBe('REQUESTED');
  });
});
