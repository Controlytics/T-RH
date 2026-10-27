import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * The profile's "Require device certificate" switch (2026-10-27). The server
 * decides everything — super admin, reason, refused while no device CA — and
 * this renders its answers.
 */
const apiPut = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => apiPut(...a), putWithReauth: (...a: unknown[]) => apiPut(...a) },
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: toastSuccess, error: toastError } }) }));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>, o?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      try { await cb(); o?.onSuccess?.(); } catch (e) { o?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { ProfileDeviceCertificateSwitch } = await import('../profile-switch');

const profile = { id: 'p-1', name: 'Testing Profile', requireDeviceCertificate: false };

beforeEach(() => { apiPut.mockReset(); toastError.mockReset(); toastSuccess.mockReset(); });

function turnOnWithReason(reason: string) {
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.change(screen.getByPlaceholderText('Why is this changing?'), { target: { value: reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
}

describe('ProfileDeviceCertificateSwitch', () => {
  it('shows the stored state', () => {
    render(<ProfileDeviceCertificateSwitch profile={{ ...profile, requireDeviceCertificate: true }} onSaved={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('turning it on asks for a reason, then saves the flag with it', async () => {
    apiPut.mockResolvedValue({ ...profile, requireDeviceCertificate: true, instrumentsWithoutCertificate: 0 });
    const onSaved = vi.fn();
    render(<ProfileDeviceCertificateSwitch profile={profile} onSaved={onSaved} />);
    expect(apiPut).not.toHaveBeenCalled();
    turnOnWithReason('client requirement');
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith(
      '/api/instrument-profiles/p-1', { requireDeviceCertificate: true, reason: 'client requirement' },
    ));
    expect(onSaved).toHaveBeenCalled();
  });

  it('says how many instruments have no certificate yet', async () => {
    apiPut.mockResolvedValue({ ...profile, requireDeviceCertificate: true, instrumentsWithoutCertificate: 1 });
    render(<ProfileDeviceCertificateSwitch profile={profile} onSaved={vi.fn()} />);
    turnOnWithReason('client requirement');
    expect(await screen.findByText('1 instrument has no certificate yet — its data will be refused.')).toBeInTheDocument();
  });

  it('names the gateways that must now present their own certificate', async () => {
    apiPut.mockResolvedValue({
      ...profile, requireDeviceCertificate: true, instrumentsWithoutCertificate: 0,
      gatewaysNeedingCertificate: [{ code: 'GW-1', certificateIssued: false }, { code: 'GW-2', certificateIssued: true }],
    });
    render(<ProfileDeviceCertificateSwitch profile={profile} onSaved={vi.fn()} />);
    turnOnWithReason('client requirement');
    expect(await screen.findByText(/Gateways that must now present their own certificate/)).toBeInTheDocument();
    expect(screen.getByText(/GW-1 \(none issued — refused on MQTT until one is\)/)).toBeInTheDocument();
    expect(screen.getByText(/GW-2 \(issued\)/)).toBeInTheDocument();
  });

  it('shows the server\'s refusal (no device CA on this server)', async () => {
    apiPut.mockRejectedValue({ message: 'Device certificates are not set up on this server (no device CA configured).' });
    render(<ProfileDeviceCertificateSwitch profile={profile} onSaved={vi.fn()} />);
    turnOnWithReason('client requirement');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'Could not save', 'Device certificates are not set up on this server (no device CA configured).',
    ));
  });

  it('closing the reason dialog changes nothing', () => {
    render(<ProfileDeviceCertificateSwitch profile={profile} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apiPut).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });
});
