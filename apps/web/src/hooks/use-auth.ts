import { useEffect } from 'react';
import useSWR from 'swr';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { clearServerContact } from '../lib/server-contact';

interface User {
  id: string;
  username: string;
  fullName: string;
  email: string;
  department?: string;
  photoUrl?: string;
  role: string;
  status: string;
  forcePasswordChange: boolean;
  isTemporaryPassword: boolean;
  lastLogin: string | null;
  createdAt?: string;
  permissions?: string[];
}

interface LoginResponse {
  success: boolean;
  token: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    role: string;
    forcePasswordChange: boolean;
    isTemporaryPassword: boolean;
  };
}

/** Check if an error is a network failure (not a real API error like 401) */
function isNetworkError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message || '').toLowerCase();
  return (err instanceof TypeError && msg.includes('fetch'))
    || msg.includes('failed to fetch') || msg.includes('networkerror')
    || msg.includes('network request failed') || msg.includes('load failed')
    || msg.includes('econnrefused') || msg.includes('unable to resolve host');
}

export function useAuth() {
  const navigate = useNavigate();
  const getToken = () => sessionStorage.getItem('access_token');

  // Cache user data for offline use
  const getCachedUser = (): User | undefined => {
    try {
      const cached = localStorage.getItem('digilog_cached_user');
      return cached ? JSON.parse(cached) : undefined;
    } catch { return undefined; }
  };

  const { data: fetchedUser, error, isLoading, mutate } = useSWR<User>(
    getToken() ? '/api/auth/me' : null,
    {
      fallbackData: getCachedUser(),
      onSuccess: (data) => {
        if (data) localStorage.setItem('digilog_cached_user', JSON.stringify(data));
      },
    },
  );

  // Use fetched user when online, cached user as fallback when offline
  const user = fetchedUser ?? (getToken() ? getCachedUser() : undefined);

  const login = async (username: string, password: string, force?: boolean) => {
    const res = await apiClient.post<LoginResponse>('/api/auth/login', {
      username,
      password,
      ...(force && { force }),
    });
    sessionStorage.setItem('access_token', res.token);

    // The offline-replay grant mint that used to live here was removed with the
    // offline-replay subsystem (commit cbcb913). `POST /api/auth/offline-grant`
    // no longer exists, so the call 404'd on every single login and logged an
    // error after a pointless retry.

    if (res.user.forcePasswordChange) {
      navigate('/change-password', { replace: true });
    } else {
      await mutate();
      // ALWAYS the dashboard (2026-10-03, operator: "after every login user
      // should come to dashboard page only dont redirect to other pages").
      // Until then a `?returnUrl=` on the login page — written by the layout
      // and the API client when a session ended on some page — sent the NEXT
      // user to the page the PREVIOUS one logged out of, which for a role
      // without that page was an Access Denied screen as its first sight of
      // the app. A `returnUrl` still in a bookmark is ignored.
      navigate('/', { replace: true });
    }

    return res;
  };

  const logout = async (reason: 'manual' | 'idle_timeout' = 'manual') => {
    try {
      await apiClient.post('/api/auth/logout', { reason });
    } catch {
      // ignore
    }
    sessionStorage.removeItem('access_token');
    localStorage.removeItem('access_token_backup');
    localStorage.removeItem('digilog_cached_user');
    // W3: clear the last-server-contact timestamp on logout. Otherwise a
    // shared workstation could inherit a stale timestamp from the previous
    // user, making the W4 hard-cutoff blocker disagree with reality on the
    // next login. The new session starts with no recorded contact and the
    // first apiClient call (e.g. POST /api/auth/login) reseeds it.
    clearServerContact();
    // Clean up single-tab localStorage keys
    const myTabId = sessionStorage.getItem('digilog_tab_id');
    if (myTabId && localStorage.getItem('digilog_active_tab_id') === myTabId) {
      localStorage.removeItem('digilog_active_tab_id');
      localStorage.removeItem('digilog_tab_heartbeat');
      localStorage.removeItem('digilog_active_user_id');
    }
    await mutate(undefined, false);
    navigate('/login', { replace: true });
  };

  // Clean up single-tab localStorage keys on tab close
  // Note: We do NOT use beacon logout on beforeunload because it fires on
  // both tab close AND page refresh, which causes the session to be terminated
  // on every refresh. Instead, we rely on the server-side idle session timeout
  // to clean up sessions when the user closes the tab.
  useEffect(() => {
    if (!user) return;

    const handleBeforeUnload = () => {
      // Clean up single-tab localStorage keys
      const myTabId = sessionStorage.getItem('digilog_tab_id');
      if (myTabId && localStorage.getItem('digilog_active_tab_id') === myTabId) {
        localStorage.removeItem('digilog_active_tab_id');
        localStorage.removeItem('digilog_tab_heartbeat');
        localStorage.removeItem('digilog_active_user_id');
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [user]);

  // Periodically refresh JWT token to prevent expiry (every 30 minutes).
  //
  // Audit 2026-05-04 fix #4 (web-plumbing review H — JWT refresh fragmentation):
  // routes through `apiClient.refreshToken()` instead of raw `fetch()` so the
  // request actually reaches the API on Capacitor APK builds (raw fetch with a
  // relative URL hits the WebView origin, which isn't the API host — the
  // refresh was silently no-op on tablet). The shared in-flight Promise guard
  // in apiClient.refreshToken() also coalesces with sync-engine's pre-replay
  // refresh and any future on-401 retry path so we don't double-fire.
  //
  // The 10-second cross-tab lock is dropped here — apiClient's per-process
  // in-flight Promise guards a single tab; cross-tab races only matter if
  // both tabs are actively talking to the API, in which case both refreshes
  // succeed and the second-applied wins (idempotent).
  useEffect(() => {
    // 2026-05-21: skip background JWT refresh while the operator is on the
    // change-password screen with forcePasswordChange=true. The server
    // blocks /api/auth/refresh for fpc:true users (it's not in
    // PASSWORD_CHANGE_ALLOWED → 403 FORCE_PASSWORD_CHANGE). The api-client
    // 403 handler then hard-redirects to /change-password, which on Capacitor
    // tabletkicks in main.tsx's mount-time redirect and bounces the operator
    // to /m/login — mid-typing. Skipping the refresh is correct: the operator
    // is about to change their password anyway; extending the JWT here is
    // pointless.
    if (user?.forcePasswordChange) return;
    const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
    const interval = setInterval(() => { void apiClient.refreshToken(); }, REFRESH_INTERVAL);
    // Also refresh once shortly after mount to extend token on page load.
    const initialRefresh = setTimeout(() => { void apiClient.refreshToken(); }, 5000);
    return () => { clearInterval(interval); clearTimeout(initialRefresh); };
  }, [user]);

  return {
    user,
    isLoading,
    // Network errors should NOT log the user out — only real 401s should.
    // When offline, SWR sets `error` to a TypeError("Failed to fetch"), but
    // we still have a cached user + token, so the user stays authenticated.
    // Token presence is required so a stale cached user (after a 401 cleared
    // the token) cannot keep the app authenticated and bounce between
    // /login → / → /login.
    isAuthenticated: !!user && !!getToken() && (!error || isNetworkError(error)),
    login,
    logout,
    mutate,
  };
}

