import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useEffect } from 'react';

/**
 * 2026-10-03, operator: "i logined and go to some page and there only i
 * directly logout, after that i logined another role user its coming to where
 * i logout that page … showing access denied, after every login user should
 * come to dashboard page only dont redirect to other pages".
 *
 * The login page used to honour `?returnUrl=`, which the layout and the API
 * client wrote whenever a session ended on some page — so the NEXT user, on a
 * shared workstation, was sent to the page the PREVIOUS one left. Both ways
 * the login page can send a signed-in user onward now go to `/` and nowhere
 * else, whatever the query string says.
 */
const auth = { current: { user: null as unknown, isAuthenticated: false, isLoading: false, login: vi.fn(), logout: vi.fn() } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth.current }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-single-tab', () => ({ checkExistingUserSession: vi.fn(async () => null) }));
vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: {
    appName: 'T&RH-Monitoring', appTagline: '', logoUrl: '', logoText: 'CC', companyName: 'Controlytics',
    version: '1.0', primaryColor: '#0891b2', secondaryColor: '#0d9488', accentColor: '#14b8a6',
    gradientStart: '#0891b2', gradientMiddle: '#0d9488', gradientEnd: '#14b8a6', loginBgStart: '#164e63', loginBgEnd: '#1e3a5f',
  } }),
}));

const Where = () => { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p>; };

describe('login never returns to a remembered page', () => {
  beforeEach(() => { auth.current = { user: null, isAuthenticated: false, isLoading: false, login: vi.fn(), logout: vi.fn() }; });

  it('an already signed-in visitor to /login?returnUrl=/alarms is sent to the dashboard, not to /alarms', async () => {
    auth.current = { ...auth.current, user: { id: 'u1' }, isAuthenticated: true };
    const { LoginPage } = await import('../login');
    render(
      <MemoryRouter initialEntries={['/login?returnUrl=%2Falarms']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/'));
    expect(screen.getByTestId('where').textContent).toBe('/');
  });
});

/**
 * The hook's own login: after a successful sign-in it navigates to `/`,
 * whatever `?returnUrl=` the login page was opened with. Mocked at the API
 * client and SWR, with a probe route reading where the router ended up.
 */
describe("useAuth().login lands on the dashboard whatever the login page's query string says", () => {
  it('navigates to / after a sign-in on /login?returnUrl=/alarms', async () => {
    // The old code read window.location.search, not the router — set BOTH, or
    // a mutant that puts that read back passes this test (it did, once).
    window.history.pushState({}, '', '/login?returnUrl=%2Falarms');
    vi.resetModules();
    vi.doMock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn(async () => undefined) }) }));
    vi.doMock('@/lib/api-client', () => ({
      apiClient: { post: vi.fn(async () => ({ token: 't', user: { id: 'u1', forcePasswordChange: false } })), get: vi.fn() },
    }));
    vi.doMock('../../../lib/api-client', () => ({
      apiClient: { post: vi.fn(async () => ({ token: 't', user: { id: 'u1', forcePasswordChange: false } })), get: vi.fn() },
    }));
    vi.doMock('../../../lib/server-contact', () => ({ clearServerContact: vi.fn() }));
    vi.doUnmock('@/hooks/use-auth');
    const { useAuth } = await import('../../../hooks/use-auth');
    const Trigger = () => { const { login } = useAuth(); useEffect(() => { void login('someone', 'pw'); }, []); return <p>signing in</p>; };
    render(
      <MemoryRouter initialEntries={['/login?returnUrl=%2Falarms']}>
        <Routes>
          <Route path="/login" element={<Trigger />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('where')).toBeInTheDocument());
    expect(screen.getByTestId('where').textContent).toBe('/');
  });
});
