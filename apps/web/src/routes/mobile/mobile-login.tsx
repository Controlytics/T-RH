import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../lib/api-client';
import { useBranding } from '../../hooks/use-branding';
import { getApiBase } from '../../lib/api-base';

// 2026-05-21: raw fetch() calls below must hit the API host directly, not the
// Capacitor SPA origin. On the tablet the WebView serves from
// https://localhost (the bundled assets), so a relative URL like
// `/api/config/tablet-access/my-features` resolves to the SPA server and
// returns index.html — checkTabletAccess then can't parse it, the catch
// block returns { allowed: true }, and login goes through even when the
// allowlist forbids it. Prepending VITE_API_URL routes the fetch through
// the LAN/local API instead. apiClient does this already; raw fetches must
// match its behaviour.

export function MobileLoginPage() {
  const navigate = useNavigate();
  const { branding } = useBranding();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForce, setShowForce] = useState(false);
  // Lockout surface state — fed by backend's `attemptsRemaining` on each failed
  // login + ACCOUNT_LOCKED error code. Backend already enforces the count from
  // the password-policy config (passwordPolicy.maxFailedAttempts) — frontend
  // just shows the operator how many tries remain before lockout.
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [accountLocked, setAccountLocked] = useState(false);

  const checkTabletAccess = async (token: string): Promise<{ allowed: boolean; role?: string }> => {
    // 2026-05-21 v2 — fail-closed. Pre-fix this returned `allowed:true` on
    // any non-2xx OR thrown error ("fail open if endpoint errors"). With the
    // tablet's intermittent HTTPS flakiness, /my-features sometimes timed
    // out / returned non-2xx → check passed → operators with deny configs
    // sailed past the allowlist. Now any failure to read the allowlist
    // blocks login; operator must retry when network is healthier.
    try {
      const res = await fetch(`${getApiBase()}/api/config/tablet-access/my-features`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { allowed: false };
      const data = await res.json();
      const allowed: string[] = Array.isArray(data?.allowed) ? data.allowed : [];
      // Respect the server-supplied `configured` flag. Admin explicitly
      // configured this role with an empty allowlist must DENY login, not
      // fall through to "empty = allowed" backwards-compat. Only when the
      // role has no entry in the config at all do we default-allow.
      const configured = data?.configured === true;
      if (!configured) return { allowed: true, role: data?.role };
      return { allowed: allowed.includes('login'), role: data?.role };
    } catch {
      return { allowed: false };
    }
  };

  // 2026-05-20 fix — mobile login NEVER minted the offline-replay grant.
  //
  // This handler is a standalone code path that bypasses use-auth.ts entirely
  // (no `useAuth().login()` call). The grant-minting code in use-auth.ts that
  // posts to /api/auth/offline-grant after every successful login was
  // therefore unreachable on the tablet — operator 101114 (Siva) logged in
  // 2026-05-20 11:04:27 and 12:46:49 and 13:08:55 with NO grant landing,
  // confirmed via audit_trail. Every queued offline op then 401'd with
  // REAUTH_REQUIRED on replay, got marked `failed` after 5 retries, and the
  // operator's cleaning work disappeared silently.
  //
  // Inlining the grant call here AFTER both the main success path AND the
  // SESSION_CONFLICT force-retry path. Best-effort with single retry to
  // ride out transient network blips. On total failure, sets
  // sessionStorage['offline_grant_failed']=1 so the sync-engine's
  // needs-reauth pre-flight (added 2026-05-20) catches the missing grant
  // before draining the queue.
  const mintOfflineGrant = async (password: string): Promise<void> => {
    const post = async () => {
      const grant = await apiClient.post<{ token: string; expiresAt: string }>(
        '/api/auth/offline-grant',
        { _currentPassword: password },
      );
      sessionStorage.setItem('offline_replay_token', grant.token);
      sessionStorage.setItem('offline_replay_expires', grant.expiresAt);
      // offline_replay_token_backup intentionally kept in localStorage:
      // the grant outlives the session (Capacitor can clear sessionStorage
      // on backgrounding while the IndexedDB queue persists).
      localStorage.setItem('offline_replay_token_backup', grant.token);
      localStorage.setItem('offline_replay_expires_backup', grant.expiresAt);
      sessionStorage.removeItem('offline_grant_failed');
    };
    try {
      await post();
    } catch (e) {
      // eslint-disable-next-line no-console -- intentional structured log
      console.warn('[mobile-login] Offline-replay grant first attempt failed; retrying once:', e);
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await post();
      } catch (e2) {
        // eslint-disable-next-line no-console -- intentional structured log
        console.error('[mobile-login] Failed to mint offline-replay grant after retry — offline mode will fail until next login:', e2);
        sessionStorage.setItem('offline_grant_failed', '1');
      }
    }
  };

  const handleLogin = async (force?: boolean) => {
    if (!username.trim() || !password.trim()) return;
    setLoading(true); setError(''); setAttemptsRemaining(null); setAccountLocked(false);
    try {
      const res = await apiClient.post<any>('/api/auth/login', {
        username: username.trim(),
        password,
        ...(force && { force: true }),
      });
      // Enforce tablet-access: this role must be allowed to log in from the tablet
      const access = await checkTabletAccess(res.token);
      if (!access.allowed) {
        // Discard the freshly-issued token so the wrapper can't log us back in
        try { await fetch(`${getApiBase()}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${res.token}` } }); } catch {}
        sessionStorage.removeItem('access_token');
        localStorage.removeItem('access_token_backup');
        setError("You don't have access to log in on the tablet.");
        setLoading(false);
        return;
      }
      sessionStorage.setItem('access_token', res.token);
      // 2026-05-21: skip mintOfflineGrant when the operator must change their
      // password first. The /api/auth/offline-grant endpoint isn't in the
      // server's PASSWORD_CHANGE_ALLOWED list, so calling it returns 403
      // FORCE_PASSWORD_CHANGE and api-client.ts:72 does a hard
      // window.location.href redirect that races with our own navigate() and
      // ends up bouncing the operator back to /m/login. The grant is minted
      // automatically on the next login (post-password-change).
      // Pattern matches hooks/use-auth.ts:96 which already gates mintGrant.
      if (!res.user?.forcePasswordChange) {
        await mintOfflineGrant(password);
      }
      if (res.user?.forcePasswordChange) {
        // Stash a hint so change-password.tsx returns to /m after success
        // instead of dropping the operator onto the desktop dashboard.
        sessionStorage.setItem('post_change_password_redirect', '/m');
        navigate('/change-password', { replace: true });
      } else {
        navigate('/m', { replace: true });
      }
    } catch (e: any) {
      if (e?.code === 'SESSION_CONFLICT' || e?.error === 'SESSION_CONFLICT' || e?.message?.includes('session')) {
        if (!force) {
          // Auto-retry with force on mobile — operators need quick access
          try {
            const res = await apiClient.post<any>('/api/auth/login', {
              username: username.trim(),
              password,
              force: true,
            });
            const access = await checkTabletAccess(res.token);
            if (!access.allowed) {
              try { await fetch(`${getApiBase()}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${res.token}` } }); } catch {}
              sessionStorage.removeItem('access_token');
              localStorage.removeItem('access_token_backup');
              setError("You don't have access to log in on the tablet.");
              setLoading(false);
              return;
            }
            sessionStorage.setItem('access_token', res.token);
            // Same forcePasswordChange skip as the main login path above —
            // /api/auth/offline-grant returns 403 for force-change users.
            if (!res.user?.forcePasswordChange) {
              await mintOfflineGrant(password);
            }
            if (res.user?.forcePasswordChange) {
              sessionStorage.setItem('post_change_password_redirect', '/m');
              navigate('/change-password', { replace: true });
            } else {
              navigate('/m', { replace: true });
            }
          } catch (e2: any) {
            // Auto-retry failed — show manual force button as fallback
            setShowForce(true);
            setError('Session conflict. Tap "Force Login" to proceed.');
          }
        } else {
          setError(e?.message ?? 'Force login failed');
        }
      } else if (e?.code === 'ACCOUNT_LOCKED' || e?.error === 'ACCOUNT_LOCKED') {
        // Account locked per password-policy.maxFailedAttempts. Steer the
        // operator to the forgot-password flow since they can't retry.
        setAccountLocked(true);
        setError(e?.message ?? 'Account locked. Contact your administrator.');
      } else if (e?.code === 'PASSWORD_EXPIRED' || e?.error === 'PASSWORD_EXPIRED') {
        setError('Your password has expired. Contact administrator or use Forgot Password.');
      } else {
        // INVALID_PASSWORD / USER_NOT_FOUND — surface attemptsRemaining if backend sent it
        if (typeof e?.attemptsRemaining === 'number') setAttemptsRemaining(e.attemptsRemaining);
        setError(e?.message ?? 'Login failed');
      }
    }
    setLoading(false);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{
        background: `linear-gradient(to bottom right, ${branding.loginBgStart}, ${branding.loginBgEnd}, ${branding.loginBgStart})`
      }}
    >
      <div className="bg-white/95 backdrop-blur-sm rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
        {/* Decorative gradient header */}
        <div
          className="h-2"
          style={{
            background: `linear-gradient(to right, ${branding.gradientStart}, ${branding.gradientMiddle}, ${branding.gradientEnd})`
          }}
        />

        <div className="p-8 space-y-6">
          <div className="text-center">
            {branding.logoUrl ? (
              <div className="inline-flex items-center justify-center w-40 h-28 mb-4">
                <img
                  src={branding.logoUrl}
                  alt={branding.appName}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
            ) : (
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4 shadow-xl"
                style={{
                  background: `linear-gradient(to bottom right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                  boxShadow: `0 10px 40px -10px ${branding.secondaryColor}50`
                }}
              >
                {branding.logoText}
              </div>
            )}
            <h1
              className="text-2xl font-bold mb-1"
              style={{
                backgroundImage: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              {branding.appName}
            </h1>
            <p className="text-sm text-slate-500 font-medium">{branding.appTagline}</p>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">User ID</label>
              <input
                type="text"
                value={username}
                onChange={e => { setUsername(e.target.value); setError(''); setShowForce(false); }}
                placeholder="Enter your user ID"
                className="w-full bg-slate-50/50 border-2 border-slate-200 rounded-xl px-4 py-4 text-base text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-all"
                autoFocus
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); setShowForce(false); setAttemptsRemaining(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="Enter your password"
                  className="w-full bg-slate-50/50 border-2 border-slate-200 rounded-xl px-4 py-4 pr-14 text-base text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-all"
                  autoComplete="current-password"
                />
                {/* Show/hide password toggle — sized for touch (48px hit target) */}
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-3 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                >
                  {showPassword ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
              {/* Forgot-password link — high-contrast for tablet visibility */}
              <div className="text-right">
                <button
                  type="button"
                  onClick={() => navigate('/m/forgot-password')}
                  className="text-sm font-semibold py-1"
                  style={{ color: branding.secondaryColor }}
                >
                  Forgot password?
                </button>
              </div>
            </div>
          </div>

          {accountLocked ? (
            <div className="rounded-xl bg-red-50 border border-red-200 p-4 space-y-2">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-bold text-red-800">Account Locked</p>
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate('/m/forgot-password')}
                className="w-full mt-2 py-2 rounded-lg text-sm font-semibold bg-red-100 hover:bg-red-200 text-red-800 transition-colors"
              >
                Request Password Reset
              </button>
            </div>
          ) : error ? (
            <div className="rounded-xl bg-gradient-to-r from-red-50 to-red-100 border border-red-200 p-4 space-y-1">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-sm text-red-700 font-medium">{error}</p>
              </div>
              {attemptsRemaining !== null && attemptsRemaining > 0 && (
                <p className="text-xs text-red-600 font-semibold pl-11">
                  {attemptsRemaining} attempt{attemptsRemaining === 1 ? '' : 's'} remaining before account lockout.
                </p>
              )}
            </div>
          ) : null}

          <div className="space-y-3">
            <button
              onClick={() => handleLogin()}
              disabled={loading || !username.trim() || !password.trim()}
              className="w-full py-4 text-white rounded-xl font-bold text-base disabled:opacity-40 active:opacity-90 transition-all"
              style={{
                background: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                boxShadow: `0 10px 40px -10px ${branding.secondaryColor}50`,
              }}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>

            {showForce && (
              <button onClick={() => handleLogin(true)} disabled={loading}
                className="w-full py-3 bg-amber-50 text-amber-700 border border-amber-200 rounded-xl font-medium text-sm">
                Force Login (Disconnect Other Session)
              </button>
            )}

            <button onClick={() => navigate('/guest-request')}
              className="w-full py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-semibold text-sm active:bg-slate-50 transition-all">
              Guest — Filter Cleaning Request
            </button>
          </div>

          {(window as any).Capacitor?.isNativePlatform?.() && (
            <a href="/m/server-config" className="block text-center text-xs text-slate-400 mt-4">
              Change server address
            </a>
          )}

          {/* Company info */}
          <div className="pt-4 border-t border-slate-200 text-center">
            <p className="text-base font-bold text-slate-700">{branding.companyName}</p>
            <p className="text-sm text-slate-500 mt-1 font-semibold">Version {branding.version}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
