import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  profileId: 'p-1', profileName: 'Default',
};

const profiles = { data: [{ id: 'p-1', name: 'Default' }, { id: 'p-2', name: 'Test' }] };

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instruments/i-1') return { data: instrument, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/attributes') return { data: { data: [] }, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/children') return { data: { data: [] }, mutate: vi.fn() };
    if (key === '/api/instrument-profiles') return { data: profiles, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));

const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: (...a: unknown[]) => apiGet(...a),
    getWithReauth: (...a: unknown[]) => apiGet(...a),
    post: vi.fn(), put: (...a: unknown[]) => apiPut(...a), delete: vi.fn(),
    postWithReauth: vi.fn(), putWithReauth: vi.fn(),
  },
}));

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
// The Connection card is SUPER_ADMIN only, and both properties under test are
// properties OF that card — so the reveal path can only be observed as this role.
// The gate itself is asserted separately below.
const authUser = { role: 'SUPER_ADMIN' } as { role: string };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: authUser }) }));
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
  apiPut.mockReset();
  apiPut.mockResolvedValue({});
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

    // Every curl command must carry the real value, not the placeholder — this is
    // the assertion that a technician's paste actually works. Over HTTP there are
    // three since 2026-10-28: the telemetry POST, the attribute read (GET) and the
    // attribute report (POST). This read `getByText` of ONE POST until then and
    // went red the day the second arrived.
    const commands = screen.getAllByText(/^curl -k /);
    expect(commands).toHaveLength(3);
    for (const curl of commands) {
      expect(curl.textContent).toContain('Bearer REVEALED-TOKEN-VALUE');
      expect(curl.textContent).not.toContain('<ACCESS_TOKEN>');
    }
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

describe('the Connection card is SUPER_ADMIN only', () => {
  const asRole = (role: string) => { authUser.role = role; };

  afterEach(() => asRole('SUPER_ADMIN'));

  it('is not rendered for a non-super-admin, even one who may edit the instrument', () => {
    // `useCan` is mocked true throughout this file, so this proves the gate is the
    // ROLE and not a permission that an admin might also hold.
    asRole('ADMIN');
    renderAt('/instruments/i-1');
    expect(screen.queryByText('Connection')).not.toBeInTheDocument();
    expect(screen.queryAllByText(/<ACCESS_TOKEN>/)).toHaveLength(0);
    expect(screen.queryByText(/curl -k -X POST/)).not.toBeInTheDocument();
  });

  it('does not hide the token panel with it — that is gated on permission, not role', () => {
    asRole('OPERATOR');
    renderAt('/instruments/i-1');
    expect(screen.getByRole('button', { name: /show token/i })).toBeInTheDocument();
  });

  it('is rendered for a super admin', () => {
    renderAt('/instruments/i-1');
    expect(screen.getByText('Connection')).toBeInTheDocument();
  });
});


/**
 * The profile used to be a LIVE select sitting in the read-only view: choosing an
 * option fired a PUT immediately, with no Save and nothing to cancel. Since
 * f1650bb (2026-09-16) it changes NOWHERE on this page — the picker cases that
 * used to sit here (edit form offers it, Save sends profileId) described a
 * control that no longer exists and were red on the committed tree; the
 * replacement behaviour is pinned in detail-edit.test.tsx.
 */
describe('the profile is read-only on this page', () => {
  it('renders the profile as text in the read-only view, with no picker', () => {
    renderAt('/instruments/i-1');
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.queryByLabelText('Profile')).not.toBeInTheDocument();
  });
});
