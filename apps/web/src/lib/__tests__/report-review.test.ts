import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The report-review client (2026-09-07): what a download became. Every PDF
 * trigger posts a request; an approved report is downloaded only after its
 * download is audited; the signature lines are built from the review row.
 * Design: docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 */
const events: string[] = [];
const post = vi.fn(async (url: string) => { events.push(`post:${url}`); return { success: true }; });
const postWithReauth = vi.fn(async (url: string, body: unknown) => { events.push(`postWithReauth:${url}`); return { id: 'r1', status: 'PENDING', ...(body as object) }; });
const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...(a as [string])), postWithReauth: (...a: unknown[]) => postWithReauth(...(a as [string, unknown])) } }));

const saved: string[] = [];
vi.mock('@/lib/pdf-report', async (orig) => {
  const real = await orig<typeof import('@/lib/pdf-report')>();
  return {
    ...real,
    renderSnapshotToPdf: vi.fn(async (_snap: unknown, opts: any) => ({
      save: (name: string) => { events.push(`save:${name}`); saved.push(name); },
      // The FINALISED document (end block + footers + watermark) is what
      // `toBlobUrl` returns; `doc.output` alone is the un-finalised one.
      toBlobUrl: () => 'blob:draft',
      doc: { output: () => 'blob:UNFINALISED' },
      __opts: opts,
    })),
  };
});

const { submitReportForReview, downloadApproved, reviewSignatures, assigneeLabel, openDraft } = await import('../report-review');
const { renderSnapshotToPdf } = await import('@/lib/pdf-report');

const snapshot = { version: 2 as const, reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report', config: {}, sections: [] };
const fmt = (d: string) => d.slice(0, 16).replace('T', ' ');
const approved = {
  id: 'r1', reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report', subtitle: null,
  requestMeta: { period: { from: '2026-08-24T00:00:00.000Z', to: '2026-08-24T01:00:00.000Z', label: 'Custom' } },
  status: 'APPROVED' as const,
  requestedBy: 'u-req', requestedByName: 'rrq', requestedAt: '2026-09-07T14:02:00.000Z', requestRemarks: 'periodic review',
  assigneeUserId: 'u-appr', assigneeRole: null,
  decidedBy: 'u-appr', decidedByName: 'rra', decidedAt: '2026-09-07T15:10:00.000Z', decisionRemarks: 'checked',
  createdAt: '2026-09-07T14:02:00.000Z',
  dataSnapshot: snapshot,
};

beforeEach(() => { events.length = 0; saved.length = 0; post.mockClear(); postWithReauth.mockClear(); get.mockReset(); (renderSnapshotToPdf as any).mockClear(); });

describe('submitReportForReview', () => {
  it('posts the snapshot, the meta and the assignee through the re-auth client', async () => {
    const res = await submitReportForReview({
      snapshot, reportType: 'Instrument Time Series', title: snapshot.title,
      requestMeta: { period: approved.requestMeta.period, intervalMs: null, instrumentCodes: ['CWH/RDU/001-00'] },
      remarks: 'periodic review', assignee: { userId: 'u-appr' }, password: 'pw',
    });
    expect(postWithReauth).toHaveBeenCalledTimes(1);
    const [url, body, password] = postWithReauth.mock.calls[0] as any[];
    expect(url).toBe('/api/report-reviews');
    expect(password).toBe('pw');
    expect(body).toMatchObject({ reportType: 'Instrument Time Series', title: snapshot.title, remarks: 'periodic review', assigneeUserId: 'u-appr', dataSnapshot: snapshot });
    expect(body).not.toHaveProperty('assigneeRole');
    expect(res.status).toBe('PENDING');
  });

  it('sends a role assignee as assigneeRole', async () => {
    await submitReportForReview({ snapshot, reportType: 'Alarms', title: 'ALARM REPORT', requestMeta: {}, remarks: 'x', assignee: { role: 'QA' } });
    expect((postWithReauth.mock.calls[0] as any[])[1]).toMatchObject({ assigneeRole: 'QA' });
  });
});

describe('reviewSignatures', () => {
  it('names each signer with their user id and the date-time of their password-verified action', () => {
    expect(reviewSignatures(approved, fmt)).toEqual([
      { label: 'Requested By', value: 'rrq (rrq) — 2026-09-07 14:02' },
      { label: 'Approved By', value: 'rra (rra) — 2026-09-07 15:10' },
    ]);
  });

  it('omits Approved By while undecided', () => {
    const pending = { ...approved, status: 'PENDING' as const, decidedBy: null, decidedByName: null, decidedAt: null };
    expect(reviewSignatures(pending, fmt)).toEqual([{ label: 'Requested By', value: 'rrq (rrq) — 2026-09-07 14:02' }]);
  });
});

describe('assigneeLabel', () => {
  it('reads as who will approve', () => {
    expect(assigneeLabel({ userId: 'u1' }, [{ id: 'u1', username: 'qa1' }])).toBe('qa1');
    expect(assigneeLabel({ role: 'QA' }, [])).toBe('any QA');
  });
});

describe('downloadApproved', () => {
  it('audits the download BEFORE saving, and saves with both signatures', async () => {
    get.mockResolvedValue(approved);
    await downloadApproved('r1', fmt);
    expect(events).toEqual(['post:/api/report-reviews/r1/download-log', expect.stringMatching(/^save:/)]);
    const opts = (renderSnapshotToPdf as any).mock.calls[0][1];
    expect(opts.draft).toBeUndefined();
    expect(opts.signatures.map((s: any) => s.label)).toEqual(['Requested By', 'Approved By']);
    expect(saved[0]).toMatch(/approved\.pdf$/);
  });

  it('refuses a request that is not approved, without touching the audit or the file', async () => {
    get.mockResolvedValue({ ...approved, status: 'PENDING' });
    await expect(downloadApproved('r1', fmt)).rejects.toThrow(/not approved/i);
    expect(events).toEqual([]);
  });

  it('does not save when the audit write fails', async () => {
    get.mockResolvedValue(approved);
    post.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(downloadApproved('r1', fmt)).rejects.toThrow('audit unavailable');
    expect(saved).toEqual([]);
  });
});

describe('openDraft', () => {
  it('renders the DRAFT (no signatures) and opens it without saving or auditing', async () => {
    get.mockResolvedValue({ ...approved, status: 'PENDING' });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await openDraft('r1', fmt);
    const opts = (renderSnapshotToPdf as any).mock.calls[0][1];
    expect(opts.draft).toBe(true);
    expect(opts.signatures).toBeUndefined();
    expect(open).toHaveBeenCalledWith('blob:draft', '_blank');
    expect(events).toEqual([]);
    vi.unstubAllGlobals();
  });
});
