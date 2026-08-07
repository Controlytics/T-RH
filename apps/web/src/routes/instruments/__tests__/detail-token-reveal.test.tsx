import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Two properties that exist only at the route level and cannot be seen from
 * `TokenPanel` alone:
 *
 *  1. A revealed token reaches the CONNECTION panel — the labelled rows and the
 *     paste-ready command. A command still carrying `<ACCESS_TOKEN>` after a
 *     reveal is worse than no command, because it looks runnable.
 *  2. Leaving the page hides it again. The mechanism is that the value lives in
 *     the route's `useState`, which unmounts. Move it into SWR and this test
 *     goes red — which is the point: an SWR key survives unmount and would
 *     redisplay a live device credential, with no re-auth, on a shared
 *     workstation.
 */

const instrument = {
  id: 'i-1', name: 'Sensor', code: 'T-1', isActive: true,
  instrumentType: null, manufacturer: null, model: null, serialNumber: null,
  description: null, expectedIntervalSec: null,
  tokenPrefix: 'ABCD1234', lastSeenAt: null, tokenRevealable: true,
  createdAt: '2026-08-06T00:00:00.000Z', createdBy: null,
  block: null, area: null, location: null,
  isGateway: false, gatewayId: null, lastSeenVia: null,
};

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instruments/i-1') return { data: instrument, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/attributes') return { data: { data: [] }, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/children') return { data: { data: [] }, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));

const apiGet = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: (...a: unknown[]) => apiGet(...a),
    getWithReauth: (...a: unknown[]) => apiGet(...a),
    post: vi.fn(), put: vi.fn(), delete: vi.fn(),
    postWithReauth: vi.fn(), putWithReauth: vi.fn(),
  },
}));

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: () => '' }),
}));
// The real hook reads the policy-derived `my-actions` over SWR. These three
// actions are NOT in it (they use `enforceReauthAlways`, which has no policy),
// so `needsReauth` is false and `execute` runs the callback straight through —
// exactly the production path when the first request succeeds. The retroactive
// 401 → dialog branch is the real hook's own tested behaviour.
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_action: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentDetailPage } = await import('../detail');

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/instruments/:id" element={<InstrumentDetailPage />} />
        <Route path="/elsewhere" element={<div>Elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({ token: 'REVEALED-TOKEN-VALUE' });
});

describe('instrument detail — token reveal', () => {
  it('puts the placeholder in the command until the token is revealed', () => {
    renderAt('/instruments/i-1');
    expect(screen.getAllByText(/<ACCESS_TOKEN>/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/REVEALED-TOKEN-VALUE/)).not.toBeInTheDocument();
  });

  it('flows the revealed token into the connection rows AND the pasteable command', async () => {
    renderAt('/instruments/i-1');
    fireEvent.click(screen.getByRole('button', { name: /show token/i }));

    await waitFor(() => expect(screen.getAllByText(/REVEALED-TOKEN-VALUE/).length).toBeGreaterThan(0));
    expect(apiGet).toHaveBeenCalledWith('/api/instruments/i-1/token');

    // The curl command must carry the real value, not the placeholder — this is
    // the assertion that a technician's paste actually works.
    const curl = screen.getByText(/curl -k -X POST/);
    expect(curl.textContent).toContain('Bearer REVEALED-TOKEN-VALUE');
    expect(curl.textContent).not.toContain('<ACCESS_TOKEN>');
    expect(screen.queryAllByText(/<ACCESS_TOKEN>/)).toHaveLength(0);
  });

  it('hides the token again when the operator navigates away', async () => {
    const { unmount } = renderAt('/instruments/i-1');
    fireEvent.click(screen.getByRole('button', { name: /show token/i }));
    await waitFor(() => expect(screen.getAllByText(/REVEALED-TOKEN-VALUE/).length).toBeGreaterThan(0));

    // Leaving the route unmounts the component. Remounting is a fresh visit —
    // it must NOT come back without another re-auth.
    unmount();
    renderAt('/instruments/i-1');
    expect(screen.queryByText(/REVEALED-TOKEN-VALUE/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/<ACCESS_TOKEN>/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /show token/i })).toBeInTheDocument();
  });
});
