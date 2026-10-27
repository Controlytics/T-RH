import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * The instrument's device certificate (2026-10-27). Presentation over the
 * server's answer — `available` / `required` / `issued` come from
 * GET /api/instruments/:id/device-certificate and nothing here re-derives them.
 */
type Status = {
  available: boolean; required: boolean; profileName: string;
  issued: null | { issueId: string; fingerprint: string; issuedAt: string; issuedBy: string | null; notAfter: string };
  requiredForChildrenCount: number; requiredForChildren: string[];
  gateway: null | { code: string; certificateIssued: boolean };
};
let status: Status;
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => (key === '/api/instruments/i-1/device-certificate'
    ? { data: status, mutate } : { data: undefined, mutate: vi.fn() }),
}));

const apiPost = vi.fn();
const apiDelete = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => apiPost(...a), postWithReauth: (...a: unknown[]) => apiPost(...a),
    delete: (...a: unknown[]) => apiDelete(...a), deleteWithReauth: (...a: unknown[]) => apiDelete(...a),
  },
}));
const toastError = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: toastError } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => `D(${v})`, formatTime: (v: string) => `T(${v})` }),
}));
// The always-on re-auth is the server's: the first call goes out, a 401 would
// open the dialog — here the callback simply runs, as on a successful attempt.
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>, o?: { onSuccess?: () => void }) => { await cb(); o?.onSuccess?.(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { DeviceCertificateCard } = await import('../device-certificate-card');

const FP = 'ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90cd12ef34ab56cd78ef90ab12';
const ISSUED = { issueId: 'f'.repeat(32), fingerprint: FP, issuedAt: '2026-10-27T09:00:00.000Z', issuedBy: 'admin', notAfter: '2036-10-27T09:00:00.000Z' };

beforeEach(() => {
  apiPost.mockReset(); apiDelete.mockReset(); mutate.mockReset(); toastError.mockReset();
  status = {
    available: true, required: false, profileName: 'Testing Profile', issued: null,
    requiredForChildrenCount: 0, requiredForChildren: [], gateway: null,
  };
});
afterEach(() => { vi.restoreAllMocks(); });

describe('DeviceCertificateCard', () => {
  it('says so, and offers nothing, when the server has no device CA', () => {
    status = { ...status, available: false };
    render(<DeviceCertificateCard instrumentId="i-1" canManage />);
    expect(screen.getByText(/Device certificates are not set up on this server/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a required instrument with none issued is told its data is being refused', () => {
    status = { ...status, required: true };
    render(<DeviceCertificateCard instrumentId="i-1" canManage />);
    expect(screen.getByText(/Required by profile Testing Profile/)).toBeInTheDocument();
    expect(screen.getByText(/data is being refused/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue certificate' })).toBeInTheDocument();
  });

  it('an issued certificate shows its expiry and fingerprint, with Re-issue and Revoke', () => {
    status = { ...status, issued: ISSUED };
    render(<DeviceCertificateCard instrumentId="i-1" canManage />);
    expect(screen.getByText(`D(${ISSUED.notAfter})`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FP.slice(0, 16)))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-issue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('Issue posts, downloads the bundle at once and says the key is not kept', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    apiPost.mockResolvedValue({ issued: ISSUED, fileName: 'T-1-device-certificate.zip', bundle: btoa('PK-zip') });
    render(<DeviceCertificateCard instrumentId="i-1" canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue certificate' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/instruments/i-1/device-certificate', {}));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/The private key is not kept — store this file safely/)).toBeInTheDocument();
    expect(mutate).toHaveBeenCalled();
  });

  it('Revoke deletes', async () => {
    status = { ...status, issued: ISSUED };
    apiDelete.mockResolvedValue({ success: true });
    render(<DeviceCertificateCard instrumentId="i-1" canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/instruments/i-1/device-certificate'));
  });

  it('a GATEWAY that reports for requiring instruments says so, and what refusing means for it', () => {
    status = { ...status, requiredForChildrenCount: 2, requiredForChildren: ['K-1'] };
    render(<DeviceCertificateCard instrumentId="i-1" canManage />);
    expect(screen.getByText(/Required because this gateway reports for 2 instruments that require a device certificate/)).toBeInTheDocument();
    expect(screen.getByText(/K-1/)).toBeInTheDocument();
    expect(screen.getByText(/this gateway is refused on MQTT, and its readings for those instruments are refused on every channel/)).toBeInTheDocument();
  });

  it("a CHILD reported through a gateway is told the gateway's certificate is what counts there", () => {
    status = { ...status, required: true, gateway: { code: 'GW-1', certificateIssued: false } };
    render(<DeviceCertificateCard instrumentId="i-1" canManage />);
    expect(screen.getByText(/this instrument's own connections are refused/)).toBeInTheDocument();
    expect(screen.getByText(/through gateway GW-1 are accepted only while GW-1 connects with its own certificate \(none issued yet\)/)).toBeInTheDocument();
    expect(screen.queryByText(/data is being refused/)).toBeNull();
  });

  it('without the manage right there are no buttons', () => {
    status = { ...status, issued: ISSUED };
    render(<DeviceCertificateCard instrumentId="i-1" canManage={false} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
