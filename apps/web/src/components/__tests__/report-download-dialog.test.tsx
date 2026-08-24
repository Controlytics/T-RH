import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReportDownloadDialog } from '../report-download-dialog';

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
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('refuses whitespace-only remarks', async () => {
    const onConfirm = vi.fn();
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('passes the trimmed remarks and the period through on confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '  monthly review  ' } });
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ remarks: 'monthly review', period: expect.objectContaining({ from: period.from }) }),
    ));
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
