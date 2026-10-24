import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Report Settings (2026-10-01): Report Approvers and Report Downloads on ONE
 * page, each still its own stored row, each PUT through the generic dynamic
 * route only when it changed. The swr mock returns MODULE-LEVEL constants — a
 * fresh object per call would re-run the seeding effects forever.
 */
const APPROVERS_ROW = { approverRoles: ['SUPERVISOR'], approverUserIds: ['u1'] };
const EMPTY_APPROVERS = { approverRoles: [], approverUserIds: [] };
// A legacy row: Trend Chart was Direct before the split, Data Report remarks off.
const DOWNLOADS_ROW = { trendChartMode: 'DIRECT', dataReportRemarks: false };
const ROLES = [{ name: 'SUPERVISOR', displayName: 'Supervisor' }, { name: 'OPERATOR', displayName: 'Operator' }, { name: 'SUPER_ADMIN', displayName: 'Super Admin' }];
const CANDIDATES = [{ value: 'u1', label: 'sup1 (SUPERVISOR)' }, { value: 'u2', label: 'qa1 (QA)' }];
let approversRow: unknown = APPROVERS_ROW;
// The server's readiness answer (2026-10-24): the toggles each role / user lacks to approve.
const READY = { roles: { SUPERVISOR: [], OPERATOR: [] }, users: { u1: [], u2: [] } };
const NOT_READY = { roles: { SUPERVISOR: ['Approve / Reject Reports'], OPERATOR: [] }, users: { u1: ['Approve / Reject Reports'], u2: [] } };
const ONLY_USER_READY = { roles: { SUPERVISOR: ['Approve / Reject Reports'], OPERATOR: [] }, users: { u1: [], u2: [] } };
let readiness: unknown = READY;
// The server's manifest names the action both rows' PUT enforces (2026-10-12).
const MANIFEST = [
  { moduleKey: 'report-approvers', reauthAction: 'UPDATE_CONFIG_PAGE' },
  { moduleKey: 'report-downloads', reauthAction: 'UPDATE_CONFIG_PAGE' },
];
const NO_ACTIONS = { actions: [] as string[] };
const CONFIG_PAGE_SIGNED = { actions: ['UPDATE_CONFIG_PAGE'] };
let myActions: { actions: string[] } = NO_ACTIONS;

vi.mock('swr', () => ({
  default: (key: string) => {
    const data = key === '/api/config/dynamic/report-approvers' ? approversRow
      : key === '/api/config/dynamic/report-downloads' ? DOWNLOADS_ROW
        : key === '/api/roles/active' ? ROLES
          : key === '/api/config/report-approvers/candidates' ? CANDIDATES
            : key === '/api/config/registry/manifest' ? MANIFEST
              : key === '/api/config/action-reauth/my-actions' ? myActions
                : key === '/api/config/report-approvers/readiness' ? readiness
                : undefined;
    return { data, mutate: vi.fn(async () => undefined) };
  },
}));
const put = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])) } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const { ReportSettingsConfigPage } = await import('../report-settings');
const mount = () => render(<MemoryRouter><ReportSettingsConfigPage /></MemoryRouter>);
const rowOf = (kind: string) => document.querySelector(`[data-report-kind="${kind}"]`) as HTMLElement;

beforeEach(() => { put.mockClear(); approversRow = APPROVERS_ROW; myActions = NO_ACTIONS; readiness = READY; });

describe('Report Settings', () => {
  it('shows the approvers and ALL EIGHT report types on one page, never offering SUPER_ADMIN as a role', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Report Settings');
    expect(screen.getByLabelText('Supervisor')).toBeChecked();
    expect(screen.getByLabelText('Operator')).not.toBeChecked();
    expect(screen.queryByLabelText('Super Admin')).toBeNull();
    expect(screen.getByLabelText('sup1 (SUPERVISOR)')).toBeChecked();
    const kinds = [...document.querySelectorAll('[data-report-kind]')].map((r) => r.getAttribute('data-report-kind'));
    expect(kinds).toEqual(['data-report', 'time-series', 'trend-header', 'temperature-trend', 'humidity-trend', 'instrument-alarms', 'alarms', 'audit-trail']);
  });

  it('shows each split type with the values it INHERITS from the setting it came from', () => {
    mount();
    expect((within(rowOf('temperature-trend')).getByRole('combobox') as HTMLSelectElement).value).toBe('DIRECT');
    expect((within(rowOf('humidity-trend')).getByRole('combobox') as HTMLSelectElement).value).toBe('DIRECT');
    expect(within(rowOf('time-series')).getByLabelText('Time Series remarks required')).not.toBeChecked();
    expect(within(rowOf('trend-header')).getByLabelText('Trend Page Report remarks required')).not.toBeChecked();
    expect((within(rowOf('alarms')).getByRole('combobox') as HTMLSelectElement).value).toBe('REQUEST');
  });

  it('Save is off until something changes; a download change PUTs ONLY the downloads row, whole, with every type\'s own keys', async () => {
    mount();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(rowOf('humidity-trend')).getByRole('combobox'), { target: { value: 'REQUEST' } });
    fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('/api/config/dynamic/report-downloads');
    expect(body.humidityTrendMode).toBe('REQUEST');
    expect(body.temperatureTrendMode).toBe('DIRECT');     // inherited value written as its own
    expect(body.timeSeriesRemarks).toBe(false);
    expect(body).not.toHaveProperty('trendChartMode');
    expect(Object.keys(body)).toHaveLength(24);
  });

  it('an approver change PUTs ONLY the approvers row, with roles and users', async () => {
    mount();
    fireEvent.click(screen.getByLabelText('Operator'));
    fireEvent.click(screen.getByLabelText('qa1 (QA)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]).toEqual(['/api/config/dynamic/report-approvers', { approverRoles: ['SUPERVISOR', 'OPERATOR'], approverUserIds: ['u1', 'u2'] }]);
  });

  it('says so when nobody is an approver — no report can be requested', () => {
    approversRow = EMPTY_APPROVERS;
    mount();
    expect(screen.getByTestId('no-approver')).toHaveTextContent(/Report Settings/);
  });
});

/**
 * 2026-10-12: both saves are signed when the Action Re-auth policy asks this
 * role for UPDATE_CONFIG_PAGE — the action the SERVER names for both rows in
 * the manifest. Until then the page PUT bare and showed the 401 as an error.
 */
describe('Report Settings — re-authentication', () => {
  it('asks for the password BEFORE sending anything, then signs both PUTs with it', async () => {
    myActions = CONFIG_PAGE_SIGNED;
    mount();
    fireEvent.click(screen.getByLabelText('Operator'));
    fireEvent.change(within(rowOf('humidity-trend')).getByRole('combobox'), { target: { value: 'REQUEST' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    expect(put).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByPlaceholderText('Enter your password'), { target: { value: 'Secret@123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /verify/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    const bodies = put.mock.calls.map((c) => (c as unknown as [string, Record<string, unknown>])[1]);
    for (const b of bodies) expect(b._currentPassword).toBe('Secret@123');
  });

  it('a cancelled password sends nothing, shows no error, and Save is offered again', async () => {
    myActions = CONFIG_PAGE_SIGNED;
    mount();
    fireEvent.click(screen.getByLabelText('Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(put).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

// 2026-10-24 (operator: "when im giving request approval request is not coming
// why"): on AWS the only approver role held View Reports but not Approve /
// Reject Reports, so no request reached anyone — and this page said nothing.
describe('Report Settings says which ticked approvers cannot approve', () => {
  it('a ticked role and a ticked user that cannot approve are named, with the toggle to tick, and the page says nobody can', () => {
    readiness = NOT_READY;
    mount();
    expect(screen.getByTestId('role-cannot-approve-SUPERVISOR')).toHaveTextContent('needs Approve / Reject Reports');
    expect(screen.getByTestId('user-cannot-approve-u1')).toHaveTextContent('needs Approve / Reject Reports');
    expect(screen.getByTestId('no-approver-can-approve')).toBeInTheDocument();
  });

  it('one approver who can approve is enough: no "nobody" banner, the one who cannot is still named', () => {
    readiness = ONLY_USER_READY;
    mount();
    expect(screen.queryByTestId('no-approver-can-approve')).toBeNull();
    expect(screen.getByTestId('role-cannot-approve-SUPERVISOR')).toBeInTheDocument();
    expect(screen.queryByTestId('user-cannot-approve-u1')).toBeNull();
  });

  it('approvers who can approve carry no warning, and an unticked role is not judged', () => {
    mount();
    expect(screen.queryByTestId('no-approver-can-approve')).toBeNull();
    expect(screen.queryByTestId('role-cannot-approve-SUPERVISOR')).toBeNull();
    expect(screen.queryByTestId('role-cannot-approve-OPERATOR')).toBeNull();
  });
});
