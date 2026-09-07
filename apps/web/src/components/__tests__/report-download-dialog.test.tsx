import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReportDownloadDialog } from '../report-download-dialog';

// The Send-to picker (2026-09-07) reads the active roles and users.
vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (typeof k === 'string' && k.startsWith('/api/roles/active')) return { data: [{ name: 'QA', displayName: 'QA Approver' }, { name: 'SUPER_ADMIN', displayName: 'Super Admin' }] };
    if (typeof k === 'string' && k.startsWith('/api/users?')) return { data: { data: [{ id: 'u-appr', username: 'qa1', fullName: 'QA One', role: 'QA' }] } };
    return { data: undefined };
  },
}));

const period = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z', label: 'Last 24 days' };

describe('ReportDownloadDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ReportDownloadDialog open={false} reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={async () => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('refuses to confirm with empty remarks — a report must state its reason', async () => {
    const onConfirm = vi.fn();
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('refuses whitespace-only remarks', async () => {
    const onConfirm = vi.fn();
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('passes the trimmed remarks and the period through on confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '  monthly review  ' } });
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ remarks: 'monthly review', period: expect.objectContaining({ from: period.from }) }),
    ));
  });

  it('offers no interval unless asked, and then carries the chosen one on confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <ReportDownloadDialog open reportName="Alarms" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    expect(screen.queryByLabelText(/^Interval$/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0]).not.toHaveProperty('intervalMs');
    unmount();

    onConfirm.mockClear();
    render(
      <ReportDownloadDialog open reportName="Data Report" initialPeriod={period}
        showInterval initialIntervalMs={300_000}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    // Seeded from the page, sits between the period and the remarks.
    const select = screen.getByLabelText(/^Interval$/) as HTMLSelectElement;
    expect(select.value).toBe(String(300_000));
    const order = [screen.getByLabelText(/^From$/), select, screen.getByLabelText(/remarks/i)];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(select, { target: { value: '' } });   // Raw
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: null })));
  });

  it('shows the caller\'s progress line only while a download is running', async () => {
    let finish: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { rerender } = render(
      <ReportDownloadDialog open reportName="Instrument History" initialPeriod={period}
        progress="Reading CWH/RDU/001-00 (1 of 30)…" onCancel={() => {}} onConfirm={onConfirm} />,
    );
    // Not busy yet: no status line, even though the caller passed one.
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 30'));
    rerender(
      <ReportDownloadDialog open reportName="Instrument History" initialPeriod={period}
        progress="Reading CWH/RDU/002-00 (2 of 30)…" onCancel={() => {}} onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('2 of 30');
    finish();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('hides the period fields when showPeriod is false', () => {
    render(
      <ReportDownloadDialog open reportName="Alarms" initialPeriod={period} showPeriod={false}
        onCancel={() => {}} onConfirm={async () => {}} />,
    );
    expect(screen.queryByLabelText(/from/i)).toBeNull();
  });

  it('calls onCancel without confirming', () => {
    const onCancel = vi.fn(); const onConfirm = vi.fn();
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={onCancel} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('Send to — the request needs an approver (2026-09-07)', () => {
  // Every download is a REQUEST now: the dialog names who approves it, and the
  // confirm button says so. Design: docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
  const period = { from: '2026-08-24T00:00:00.000Z', to: '2026-08-24T01:00:00.000Z', label: 'Custom' };

  it('refuses to confirm until an approver is chosen, and names the button Request approval', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ReportDownloadDialog open reportName="Data Report" initialPeriod={period} onCancel={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole('button', { name: /request approval/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^download$/i })).toBeNull();
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'monthly review' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    expect(await screen.findByText(/choose who approves/i)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('carries the chosen USER on confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ReportDownloadDialog open reportName="Data Report" initialPeriod={period} onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'monthly review' } });
    fireEvent.click(screen.getByRole('button', { name: /to a user/i }));
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'u-appr' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ remarks: 'monthly review', assignee: { userId: 'u-appr' } })));
  });

  it('carries the chosen ROLE on confirm, and never offers SUPER_ADMIN', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ReportDownloadDialog open reportName="Alarms" initialPeriod={period} onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'QA' } });
    const roleSelect = screen.getByLabelText(/send to/i) as HTMLSelectElement;
    expect([...roleSelect.options].map((o) => o.value)).not.toContain('SUPER_ADMIN');
    fireEvent.change(roleSelect, { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: /request approval/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ assignee: { role: 'QA' } })));
  });
});
