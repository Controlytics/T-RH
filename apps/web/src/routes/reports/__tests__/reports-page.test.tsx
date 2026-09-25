import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Reports page (2026-09-07), mounted for real. Operator: *"in side bar new
 * option there user can download reports"*. Every assertion is a WIRING one:
 * which rows offer which action to WHOM, and that a decision goes out with the
 * remarks and the password and refreshes the list. Design:
 * docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 *
 * NOT VERIFIED HERE: what it looks like. Read out of the DOM, not seen.
 */

let me: { id: string; username: string; role: string; permissions: string[] } = { id: 'u-appr', username: 'qa1', role: 'QA', permissions: ['REPORT_REVIEW_READ', 'REPORT_REVIEW_APPROVE'] };
const asApprover = { id: 'u-appr', username: 'qa1', role: 'QA', permissions: ['REPORT_REVIEW_READ', 'REPORT_REVIEW_APPROVE'] };
const asSuperAdmin = { id: 'u-sa', username: 'superadmin', role: 'SUPER_ADMIN', permissions: [] as string[] };

const base = {
  reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report', subtitle: null,
  requestMeta: { period: { from: '2026-08-24T00:00:00.000Z', to: '2026-08-24T01:00:00.000Z', label: 'Custom' }, recordCount: 12, instrumentCodes: ['CWH/RDU/001-00'] },
  requestedBy: 'u-req', requestedByName: 'rrq', requestedAt: '2026-09-07T14:02:00.000Z', requestRemarks: 'periodic review',
  decidedBy: null, decidedByName: null, decidedAt: null, decisionRemarks: null, createdAt: '2026-09-07T14:02:00.000Z',
};
const toMe = { ...base, id: 'r-user', status: 'PENDING', assigneeUserId: 'u-appr', assigneeRole: null };
const toMyRole = { ...base, id: 'r-role', status: 'PENDING', assigneeUserId: null, assigneeRole: 'QA', title: 'ALARM REPORT', reportType: 'Alarms' };
const toSomeoneElse = { ...base, id: 'r-other', status: 'PENDING', assigneeUserId: 'u-x', assigneeRole: null, title: 'Instrument Trend — Temperature', reportType: 'Instrument Trend — Temperature' };
const approved = { ...base, id: 'r-ok', status: 'APPROVED', assigneeUserId: 'u-appr', assigneeRole: null, decidedBy: 'u-appr', decidedByName: 'qa1', decidedAt: '2026-09-07T15:10:00.000Z', decisionRemarks: 'checked' };

const myOwn = { ...base, id: 'r-own', status: 'PENDING', requestedBy: 'u-appr', requestedByName: 'qa1', assigneeUserId: null, assigneeRole: 'QA', title: 'MY OWN REQUEST' };
const superAdminsOwn = { ...base, id: 'r-sa-own', status: 'PENDING', requestedBy: 'u-sa', requestedByName: 'superadmin', assigneeUserId: null, assigneeRole: 'ADMIN', title: 'SUPER ADMIN OWN REQUEST' };

const lists: Record<string, any[]> = { queue: [toMe, toMyRole, toSomeoneElse, myOwn, superAdminsOwn], mine: [], approved: [approved] };
/** The frozen v2 snapshot the approved row opens beneath itself. */
const SNAPSHOT = {
  version: 2, reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report', config: {},
  sections: [
    { kind: 'pairs', pairs: [['Instrument ID', 'CWH/RDU/001-00'], ['Interval', '15 minutes']] },
    { kind: 'table', head: ['Date', 'Time', 'Temperature', 'Humidity'], body: [['24/08/2026', '00:15', '22.4', '47.0'], ['24/08/2026', '00:00', '22.1', '46.8']], bold: [[false, false, false, false], [false, false, false, false]] },
  ],
};
let listError: unknown = undefined;
const mutate = vi.fn();

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (typeof k === 'string' && k.startsWith('/api/report-reviews?')) {
      const list = new URLSearchParams(k.split('?')[1]).get('list') ?? 'queue';
      if (listError) return { data: undefined, error: listError, isLoading: false, mutate };
      return { data: { data: lists[list], total: lists[list].length }, isLoading: false, mutate };
    }
    if (typeof k === 'string' && k.includes('/config/pagination')) return { data: { limit: 25, options: [10, 25, 50] }, mutate: vi.fn() };
    if (typeof k === 'string' && k.startsWith('/api/users?')) return { data: { data: [{ id: 'u-appr', username: 'qa1' }, { id: 'u-x', username: 'other' }] }, mutate: vi.fn() };
    if (k === '/api/report-reviews/r-ok') return { data: { ...approved, dataSnapshot: SNAPSHOT }, isLoading: false, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: me }) }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => node === 'reports.approve' }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d.slice(0, 16).replace('T', ' '), formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), postWithReauth: vi.fn() } }));

const decideReview = vi.fn(async () => ({ ...toMe, status: 'APPROVED' }));
const openDraft = vi.fn(async () => {});
const downloadApproved = vi.fn(async () => {});
vi.mock('@/lib/report-review', async (orig) => ({
  ...(await orig<typeof import('@/lib/report-review')>()),
  decideReview: (...a: unknown[]) => decideReview(...(a as [])),
  openDraft: (...a: unknown[]) => openDraft(...(a as [])),
  downloadApproved: (...a: unknown[]) => downloadApproved(...(a as [])),
}));

const { ReportsPage } = await import('../index');

function mount() {
  return render(<MemoryRouter initialEntries={['/reports']}><ReportsPage /></MemoryRouter>);
}
const rowOf = (title: string) => screen.getByText(title).closest('tr')!;

describe('ReportsPage', () => {
  beforeEach(() => { me = asApprover; listError = undefined; mutate.mockClear(); decideReview.mockClear(); openDraft.mockClear(); downloadApproved.mockClear(); });

  it('names the screen once and opens on the approval queue with the three lists as tabs', () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reports');
    // UI v3 (2026-09-21): the shared band and the shared table band.
    expect(screen.getByTestId('page-hero')).toBeInTheDocument();
    expect(document.querySelector('thead')).toHaveAttribute('data-band', 'gradient');
    for (const t of ['For my approval', 'My requests', 'Approved']) expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'For my approval' })).toHaveAttribute('aria-selected', 'true');
    expect(rowOf('Temperature and RH Data Report')).toHaveTextContent('rrq');
    expect(rowOf('Temperature and RH Data Report')).toHaveTextContent('qa1');   // Send to: the named user
    expect(rowOf('ALARM REPORT')).toHaveTextContent('any QA');                  // Send to: the role
  });

  it('offers Approve and Reject only on a PENDING row assigned to me — by user or by my role', () => {
    mount();
    expect(within(rowOf('Temperature and RH Data Report')).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(rowOf('ALARM REPORT')).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(rowOf('Instrument Trend — Temperature')).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(rowOf('Instrument Trend — Temperature')).queryByRole('button', { name: 'Reject' })).toBeNull();
    // Every party can look at the draft.
    expect(within(rowOf('Instrument Trend — Temperature')).getByRole('button', { name: 'View draft' })).toBeInTheDocument();
    // My own request, though assigned to my role, is not mine to decide.
    expect(within(rowOf('MY OWN REQUEST')).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('SUPER_ADMIN may approve any pending request, their own included (operator, 2026-09-08)', () => {
    me = asSuperAdmin;
    mount();
    expect(within(rowOf('SUPER ADMIN OWN REQUEST')).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(rowOf('SUPER ADMIN OWN REQUEST')).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    // Not assigned to them by user or role — SUPER_ADMIN still decides it.
    expect(within(rowOf('Instrument Trend — Temperature')).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('approves with remarks and password, then refreshes the list', async () => {
    mount();
    fireEvent.click(within(rowOf('Temperature and RH Data Report')).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Temperature and RH Data Report');
    fireEvent.change(within(dialog).getByLabelText(/remarks/i), { target: { value: 'checked against the batch record' } });
    fireEvent.change(within(dialog).getByPlaceholderText(/signs this decision/i), { target: { value: 'Secret@123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decideReview).toHaveBeenCalledWith('r-user', 'approve', 'checked against the batch record', 'Secret@123'));
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it('refuses a decision without remarks or without a password', () => {
    mount();
    fireEvent.click(within(rowOf('ALARM REPORT')).getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/remarks/i), { target: { value: 'wrong period' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText(/signs this decision/i), { target: { value: 'x' } });
    expect(confirm).toBeEnabled();
  });

  it('opens the draft for review', async () => {
    mount();
    fireEvent.click(within(rowOf('ALARM REPORT')).getByRole('button', { name: 'View draft' }));
    await waitFor(() => expect(openDraft).toHaveBeenCalledWith('r-role', expect.any(Function)));
  });

  it('downloads only from the Approved list, and shows who signed', async () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    const row = rowOf('Temperature and RH Data Report');
    expect(row).toHaveTextContent('qa1');
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloadApproved).toHaveBeenCalledWith('r-ok', expect.any(Function)));
  });

  it('says so when the list cannot be loaded — never "no requests"', () => {
    listError = new Error('boom');
    mount();
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/no requests/i)).toBeNull();
  });

  it('says "No requests" only when the list is genuinely empty', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'My requests' }));
    expect(screen.getByText(/no requests/i)).toBeInTheDocument();
  });
});

describe('ReportsPage — View draft only while PENDING (2026-09-25)', () => {
  // Operator: "if request is approved or rejected then view draft should not
  // come". The draft is a thing to review; once decided, an approved report
  // downloads signed and a rejected one is closed.
  beforeEach(() => { me = asApprover; listError = undefined; openDraft.mockClear(); });

  it('offers Download and no View draft on an approved row', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    const row = rowOf('Temperature and RH Data Report');
    expect(within(row).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'View draft' })).toBeNull();
  });

  it('offers neither on a rejected row', () => {
    const rejected = { ...base, id: 'r-no', status: 'REJECTED', requestedBy: 'u-appr', requestedByName: 'qa1', assigneeUserId: 'u-x', assigneeRole: null, title: 'REJECTED REPORT', decidedBy: 'u-x', decidedByName: 'x', decidedAt: '2026-09-07T16:00:00.000Z', decisionRemarks: 'wrong period' };
    const before = lists.mine;
    lists.mine = [rejected];
    try {
      mount();
      fireEvent.click(screen.getByRole('tab', { name: 'My requests' }));
      const row = rowOf('REJECTED REPORT');
      expect(within(row).queryByRole('button', { name: 'View draft' })).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Download' })).toBeNull();
      // And a pending row in the queue still offers it.
      fireEvent.click(screen.getByRole('tab', { name: 'For my approval' }));
      expect(within(rowOf('ALARM REPORT')).getByRole('button', { name: 'View draft' })).toBeInTheDocument();
    } finally {
      lists.mine = before;
    }
  });
});

describe('ReportsPage — an approved row opens its report data beneath it (2026-09-25)', () => {
  // Operator: "once approved then if user click on that row, that report data
  // should be shown in below that row in table format". The data is the
  // frozen snapshot the approver signed, rendered as bordered tables.
  beforeEach(() => { me = asApprover; listError = undefined; downloadApproved.mockClear(); });

  it('shows the snapshot as tables under the row on click, and closes on a second click', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    const row = rowOf('Temperature and RH Data Report');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('report-snapshot')).toBeNull();

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const view = screen.getByTestId('report-snapshot');
    // The pairs block and the readings table, both as .tbl-grid tables.
    const tables = within(view).getAllByRole('table');
    expect(tables).toHaveLength(2);
    for (const t of tables) expect(t.className).toMatch(/(^|\s)tbl-grid(\s|$)/);
    expect(within(view).getByText('CWH/RDU/001-00')).toBeInTheDocument();
    expect(within(view).getByRole('columnheader', { name: 'Temperature' })).toBeInTheDocument();
    expect(within(view).getByText('22.4')).toBeInTheDocument();
    // Directly beneath the row.
    expect(row.nextElementSibling).toHaveAttribute('data-review-detail', 'r-ok');

    fireEvent.click(row);
    expect(screen.queryByTestId('report-snapshot')).toBeNull();
  });

  it('does not open on a pending row, and the Download button does not toggle the row', () => {
    mount();
    const pendingRow = rowOf('ALARM REPORT');
    fireEvent.click(pendingRow);
    expect(pendingRow).not.toHaveAttribute('aria-expanded');
    expect(screen.queryByTestId('report-snapshot')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    const row = rowOf('Temperature and RH Data Report');
    fireEvent.click(within(row).getByRole('button', { name: 'Download' }));
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(downloadApproved).toHaveBeenCalledWith('r-ok', expect.any(Function));
  });
});
