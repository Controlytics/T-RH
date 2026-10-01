import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReportDownloadDialog } from '../report-download-dialog';

/**
 * The dialog shapes itself from Configuration → Report Downloads (2026-10-01):
 * Direct or Request, a remarks box or none, a password box or none — and the
 * requester never chooses an approver (the Send-to picker is gone).
 *
 * The swr mock returns MODULE-LEVEL constants per key: a fresh object per call
 * makes an effect keyed on the data re-run forever (the UI v3 hang).
 */
const POLICY = {
  REQUEST_FULL: { mode: 'REQUEST', remarksRequired: true, passwordRequired: true },
  DIRECT_FULL: { mode: 'DIRECT', remarksRequired: true, passwordRequired: true },
  DIRECT_BARE: { mode: 'DIRECT', remarksRequired: false, passwordRequired: false },
} as const;
const APPROVERS = { SOME: { approverRoles: ['SUPERVISOR'], approverUserCount: 2 }, NONE: { approverRoles: [], approverUserCount: 0 } };
const state = vi.hoisted(() => ({ downloads: undefined as unknown, approvers: undefined as unknown }));
const responses = new Map<string, unknown>();
function setPolicy(alarms: unknown, approvers: unknown = APPROVERS.SOME) {
  responses.set('/api/config/report-downloads/current', {
    'data-report': alarms, 'time-series': alarms, 'trend-header': alarms, 'temperature-trend': alarms, 'humidity-trend': alarms, 'instrument-alarms': alarms, alarms, 'audit-trail': alarms,
  });
  responses.set('/api/config/report-approvers/current', approvers);
}
vi.mock('swr', () => ({
  default: (key: any) => ({ data: typeof key === 'string' ? responses.get(key) : undefined }),
}));
void state;

const period = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z', label: 'Last 24 days' };
const open = (extra: Record<string, unknown> = {}, onConfirm = vi.fn().mockResolvedValue(undefined)) => {
  render(<ReportDownloadDialog open reportName="Alarm Report" kind="alarms" initialPeriod={period} onCancel={() => {}} onConfirm={onConfirm} {...extra} />);
  return onConfirm;
};
const password = () => document.getElementById('report-download-password') as HTMLInputElement;

beforeEach(() => { responses.clear(); setPolicy(POLICY.REQUEST_FULL); });

describe('ReportDownloadDialog — the basics', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ReportDownloadDialog open={false} reportName="Audit Trail" kind="audit-trail" initialPeriod={period} onCancel={() => {}} onConfirm={async () => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says Loading and offers no action until the configuration arrives — it never guesses a mode', () => {
    responses.clear();
    open();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByLabelText(/remarks/i)).toBeNull();
    expect(screen.getAllByRole('button').filter((b) => !/cancel/i.test(b.textContent ?? '')).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('calls onCancel without confirming', () => {
    const onCancel = vi.fn(); const onConfirm = vi.fn();
    render(<ReportDownloadDialog open reportName="Audit Trail" kind="audit-trail" initialPeriod={period} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('hides the period fields when showPeriod is false', () => {
    open({ showPeriod: false });
    expect(screen.queryByLabelText(/^from$/i)).toBeNull();
  });
});

describe('REQUEST mode', () => {
  it('names the action Request approval, names who it goes to, and has NO Send-to picker', () => {
    open();
    expect(screen.getByRole('heading', { name: 'Request approval — Alarm Report' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request approval' })).toBeInTheDocument();
    expect(screen.getByTestId('report-download-approvers')).toHaveTextContent('any SUPERVISOR, and 2 named users');
    expect(screen.queryByLabelText(/send to/i)).toBeNull();
    expect(screen.queryByRole('combobox', { name: /send to/i })).toBeNull();
  });

  it('with no approver configured it says so, names the fix, and cannot be sent', () => {
    setPolicy(POLICY.REQUEST_FULL, APPROVERS.NONE);
    open();
    expect(screen.getByRole('alert')).toHaveTextContent(/Report Settings/);
    expect(screen.getByRole('button', { name: 'Request approval' })).toBeDisabled();
  });

  it('carries the trimmed remarks, the password and mode REQUEST on confirm', async () => {
    const onConfirm = open();
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '  monthly review  ' } });
    fireEvent.change(password(), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      remarks: 'monthly review', password: 'pw', mode: 'REQUEST', period: expect.objectContaining({ from: period.from }),
    })));
  });
});

describe('DIRECT mode', () => {
  it('names the action Download and says nothing about approvers', () => {
    setPolicy(POLICY.DIRECT_FULL);
    open();
    expect(screen.getByRole('heading', { name: 'Download — Alarm Report' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByTestId('report-download-approvers')).toBeNull();
  });

  it('with remarks and password OFF shows neither box and confirms with neither', async () => {
    setPolicy(POLICY.DIRECT_BARE);
    const onConfirm = open();
    expect(screen.queryByLabelText(/remarks/i)).toBeNull();
    expect(password()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const req = onConfirm.mock.calls[0][0];
    expect(req).toMatchObject({ mode: 'DIRECT', remarks: '' });
    expect(req).not.toHaveProperty('password');
  });
});

describe('remarks and password, when required', () => {
  it('refuses empty or whitespace-only remarks', async () => {
    const onConfirm = open();
    fireEvent.change(password(), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('refuses a missing password', async () => {
    const onConfirm = open();
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('shows a wrong password IN the dialog and stays open', async () => {
    const onConfirm = open({}, vi.fn().mockRejectedValue({ error: 'REAUTH_FAILED', message: 'x' }));
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'x' } });
    fireEvent.change(password(), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    expect(await screen.findByText('Incorrect password. Please try again.')).toBeInTheDocument();
    expect(onConfirm).toHaveBeenCalled();
  });

  it('a `policy` override replaces the configuration (the Audit Trail Excel export)', () => {
    open({ policy: POLICY.DIRECT_BARE });
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/remarks/i)).toBeNull();
  });
});

describe('interval and progress', () => {
  it('offers no interval unless asked, and then carries the chosen one on confirm', async () => {
    setPolicy(POLICY.DIRECT_BARE);
    const first = open();
    expect(screen.queryByLabelText(/^Interval$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(first).toHaveBeenCalled());
    expect(first.mock.calls[0][0]).not.toHaveProperty('intervalMs');
  });

  it('seeds the interval from the page, between the period and the remarks', async () => {
    const onConfirm = open({ showInterval: true, initialIntervalMs: 300_000 });
    const select = screen.getByLabelText(/^Interval$/) as HTMLSelectElement;
    expect(select.value).toBe(String(300_000));
    const order = [screen.getByLabelText(/^From$/), select, screen.getByLabelText(/remarks/i)];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'x' } });
    fireEvent.change(password(), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: null })));
  });

  it('shows the caller\'s progress line only while running', async () => {
    setPolicy(POLICY.DIRECT_BARE);
    let finish: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { rerender } = render(
      <ReportDownloadDialog open reportName="Data Report" kind="data-report" initialPeriod={period}
        progress="Read 1 of 30 instruments…" onCancel={() => {}} onConfirm={onConfirm} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 30'));
    rerender(
      <ReportDownloadDialog open reportName="Data Report" kind="data-report" initialPeriod={period}
        progress="Read 2 of 30 instruments…" onCancel={() => {}} onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('2 of 30');
    finish();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
