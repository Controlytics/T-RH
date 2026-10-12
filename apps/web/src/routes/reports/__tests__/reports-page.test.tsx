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
// The approvers are the FROZEN set from configuration (2026-10-01): roles and
// named users. The legacy single assignee columns are null on every row.
const legacy = { assigneeUserId: null, assigneeRole: null, instrumentIds: ['i1'] };
// Since 2026-10-12 (audit #9) every list row carries the SERVER's `canDecide`
// for the caller and the approver users by NAME; the page re-derives neither.
// The fixtures are therefore what the server answers for the approver `qa1`.
const toMe = { ...base, ...legacy, id: 'r-user', status: 'PENDING', approverRoles: [], approverUserIds: ['u-appr'], approverUserNames: ['qa1'], canDecide: true };
const toMyRole = { ...base, ...legacy, id: 'r-role', status: 'PENDING', approverRoles: ['QA'], approverUserIds: [], approverUserNames: [], canDecide: true, title: 'ALARM REPORT', reportType: 'Alarms' };
const toSomeoneElse = { ...base, ...legacy, id: 'r-other', status: 'PENDING', approverRoles: ['SUPERVISOR'], approverUserIds: ['u-x'], approverUserNames: ['other'], canDecide: false, title: 'Instrument Trend — Temperature', reportType: 'Instrument Trend — Temperature' };
const approved = { ...base, ...legacy, id: 'r-ok', status: 'APPROVED', approverRoles: ['QA'], approverUserIds: ['u-appr'], approverUserNames: ['qa1'], canDecide: false, decidedBy: 'u-appr', decidedByName: 'qa1', decidedAt: '2026-09-07T15:10:00.000Z', decisionRemarks: 'checked' };

const myOwn = { ...base, ...legacy, id: 'r-own', status: 'PENDING', requestedBy: 'u-appr', requestedByName: 'qa1', approverRoles: ['QA'], approverUserIds: [], approverUserNames: [], canDecide: false, title: 'MY OWN REQUEST' };
const superAdminsOwn = { ...base, ...legacy, id: 'r-sa-own', status: 'PENDING', requestedBy: 'u-sa', requestedByName: 'superadmin', approverRoles: ['ADMIN'], approverUserIds: [], approverUserNames: [], canDecide: false, title: 'SUPER ADMIN OWN REQUEST' };
// Assigned to my ROLE, not mine, PENDING — everything the browser used to check
// says "approve" — but about an instrument outside my scope, so the server says no.
const outOfScope = { ...base, ...legacy, id: 'r-scope', status: 'PENDING', approverRoles: ['QA'], approverUserIds: [], approverUserNames: [], canDecide: false, instrumentIds: ['i-elsewhere'], title: 'OUT OF MY SCOPE' };

const QUEUE_FOR_APPROVER = [toMe, toMyRole, toSomeoneElse, myOwn, superAdminsOwn, outOfScope];
const lists: Record<string, any[]> = { queue: QUEUE_FOR_APPROVER, mine: [], approved: [approved] };
const swrKeys: string[] = [];
/** The frozen v2 snapshot the approved row opens beneath itself. */
const SNAPSHOT = {
  version: 2, reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report', config: {},
  sections: [
    { kind: 'pairs', pairs: [['Instrument ID', 'CWH/RDU/001-00'], ['Interval', '15 minutes']] },
    { kind: 'table', head: ['Date', 'Time', 'Temperature', 'Humidity'], body: [['24/08/2026', '00:15', '22.4', '47.0'], ['24/08/2026', '00:00', '22.1', '46.8']], bold: [[false, false, false, false], [false, false, false, false]] },
  ],
};
const APPROVED_FULL = { ...approved, dataSnapshot: SNAPSHOT };
const PENDING_FULL = { ...toMyRole, dataSnapshot: SNAPSHOT };
let listError: unknown = undefined;
const mutate = vi.fn();

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (typeof k === 'string') swrKeys.push(k);
    if (typeof k === 'string' && k.startsWith('/api/report-reviews?')) {
      const list = new URLSearchParams(k.split('?')[1]).get('list') ?? 'queue';
      if (listError) return { data: undefined, error: listError, isLoading: false, mutate };
      return { data: { data: lists[list], total: lists[list].length }, isLoading: false, mutate };
    }
    if (typeof k === 'string' && k.includes('/config/pagination')) return { data: { limit: 25, options: [10, 25, 50] }, mutate: vi.fn() };
    if (k === '/api/report-reviews/r-ok') return { data: APPROVED_FULL, isLoading: false, mutate: vi.fn() };
    if (k === '/api/report-reviews/r-role') return { data: PENDING_FULL, isLoading: false, mutate: vi.fn() };
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
const downloadApproved = vi.fn(async () => {});
vi.mock('@/lib/report-review', async (orig) => ({
  ...(await orig<typeof import('@/lib/report-review')>()),
  decideReview: (...a: unknown[]) => decideReview(...(a as [])),
  downloadApproved: (...a: unknown[]) => downloadApproved(...(a as [])),
}));

const { ReportsPage } = await import('../index');

function mount() {
  return render(<MemoryRouter initialEntries={['/reports']}><ReportsPage /></MemoryRouter>);
}
const rowOf = (title: string) => screen.getByText(title).closest('tr')!;

describe('ReportsPage', () => {
  beforeEach(() => { me = asApprover; lists.queue = QUEUE_FOR_APPROVER; listError = undefined; swrKeys.length = 0; mutate.mockClear(); decideReview.mockClear(); downloadApproved.mockClear(); });

  it('names the screen once and opens on the approval queue with the three lists as tabs', () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reports');
    // UI v3 (2026-09-21): the shared band and the shared table band.
    expect(screen.getByTestId('page-hero')).toBeInTheDocument();
    expect(document.querySelector('thead')).toHaveAttribute('data-band', 'gradient');
    for (const t of ['For my approval', 'Requests', 'Approved']) expect(screen.getByRole('tab', { name: t })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'For my approval' })).toHaveAttribute('aria-selected', 'true');
    expect(rowOf('Temperature and RH Data Report')).toHaveTextContent('rrq');
    expect(rowOf('Temperature and RH Data Report')).toHaveTextContent('qa1');   // Send to: the named user
    expect(rowOf('ALARM REPORT')).toHaveTextContent('any QA');                  // Send to: the role
    // Every frozen approver is named — roles and users together.
    expect(rowOf('Instrument Trend — Temperature')).toHaveTextContent('any SUPERVISOR, other');
    // The second tab lists my ROLE's requests too (2026-10-01).
    expect(screen.getByRole('tab', { name: 'Requests' })).toBeInTheDocument();
  });

  it('offers Approve and Reject only on a PENDING row I am an approver of — named, or by my role', () => {
    mount();
    expect(within(rowOf('Temperature and RH Data Report')).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(rowOf('ALARM REPORT')).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(rowOf('Instrument Trend — Temperature')).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(rowOf('Instrument Trend — Temperature')).queryByRole('button', { name: 'Reject' })).toBeNull();
    // There is no View draft any more (2026-10-01) — on any row.
    expect(screen.queryByRole('button', { name: 'View draft' })).toBeNull();
    // My own request, though assigned to my role, is not mine to decide.
    expect(within(rowOf('MY OWN REQUEST')).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  // Audit 2026-10-12 #9: the buttons follow the SERVER's per-row answer. The
  // browser's own rule (approver role + not mine + the gate) said yes to this
  // row; the instrument scope says no, and only the server knows the scope.
  it('follows the server\'s canDecide — no Approve on a row outside my instrument scope', () => {
    mount();
    expect(within(rowOf('OUT OF MY SCOPE')).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(rowOf('OUT OF MY SCOPE')).queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('names the approver users from the rows themselves — it never reads /api/users (USER_READ)', () => {
    mount();
    expect(rowOf('Instrument Trend — Temperature')).toHaveTextContent('any SUPERVISOR, other');
    expect(swrKeys.some((k) => k.startsWith('/api/users'))).toBe(false);
  });

  it('SUPER_ADMIN may approve any pending request, their own included (operator, 2026-09-08)', () => {
    me = asSuperAdmin;
    // The server's answer for a SUPER_ADMIN: every pending row is theirs to decide.
    lists.queue = QUEUE_FOR_APPROVER.map((r) => ({ ...r, canDecide: true }));
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
    fireEvent.click(screen.getByRole('tab', { name: 'Requests' }));
    expect(screen.getByText(/no requests/i)).toBeInTheDocument();
  });
});

describe('ReportsPage — no View draft; a PENDING row opens its data beneath it (2026-10-01)', () => {
  // Operator: "remove view draft and how you are showing after approval that
  // below the request show like that only". The approver reads the frozen
  // snapshot under the row and signs there.
  beforeEach(() => { me = asApprover; listError = undefined; });

  it('a pending row opens its snapshot as tables, and its Approve button does not toggle it', () => {
    mount();
    const row = rowOf('ALARM REPORT');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(row.nextElementSibling).toHaveAttribute('data-review-detail', 'r-role');
    expect(within(screen.getByTestId('report-snapshot')).getByText('22.4')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    expect(row).toHaveAttribute('aria-expanded', 'true');
  });

  it('a rejected row offers no Download and does not open', () => {
    const rejected = { ...base, ...legacy, id: 'r-no', status: 'REJECTED', requestedBy: 'u-appr', requestedByName: 'qa1', approverRoles: [], approverUserIds: ['u-x'], title: 'REJECTED REPORT', decidedBy: 'u-x', decidedByName: 'x', decidedAt: '2026-09-07T16:00:00.000Z', decisionRemarks: 'wrong period' };
    const before = lists.mine;
    lists.mine = [rejected];
    try {
      mount();
      fireEvent.click(screen.getByRole('tab', { name: 'Requests' }));
      const row = rowOf('REJECTED REPORT');
      expect(within(row).queryByRole('button', { name: 'Download' })).toBeNull();
      fireEvent.click(row);
      expect(row).not.toHaveAttribute('aria-expanded');
      expect(screen.queryByTestId('report-snapshot')).toBeNull();
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

  it('the Download button does not toggle the row', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    const row = rowOf('Temperature and RH Data Report');
    fireEvent.click(within(row).getByRole('button', { name: 'Download' }));
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(downloadApproved).toHaveBeenCalledWith('r-ok', expect.any(Function));
  });
});
