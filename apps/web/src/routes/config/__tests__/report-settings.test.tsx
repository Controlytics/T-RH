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

vi.mock('swr', () => ({
  default: (key: string) => {
    const data = key === '/api/config/dynamic/report-approvers' ? approversRow
      : key === '/api/config/dynamic/report-downloads' ? DOWNLOADS_ROW
        : key === '/api/roles/active' ? ROLES
          : key === '/api/config/report-approvers/candidates' ? CANDIDATES
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

beforeEach(() => { put.mockClear(); approversRow = APPROVERS_ROW; });

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
