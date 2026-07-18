import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useSuperAdminLock } from '@/hooks/use-super-admin-lock';

/**
 * Super Admin API kill-switch UI.
 *
 *  - SuperAdminLockdownScreen: full-screen wall shown by AppLayout when the
 *    switch is OFF and the current user is a SUPER_ADMIN. The ONLY things a
 *    frozen superadmin can still do are re-enable (with password) and log out.
 *  - SuperAdminApiAccessCard: a SUPER_ADMIN-only card for the Settings page to
 *    turn the switch OFF (or back ON) while the app is unlocked.
 *
 * Both flips go through the same reauth-gated PUT (password required server-side).
 */

function errMessage(e: unknown): string {
  const code = (e as any)?.code;
  if (code === 'REAUTH_FAILED') return 'Incorrect password. Please try again.';
  if (code === 'REAUTH_REQUIRED') return 'Password is required.';
  return (e as any)?.message || 'Something went wrong. Please try again.';
}

/** Full-screen lockdown wall — rendered instead of the app when SA is frozen. */
export function SuperAdminLockdownScreen() {
  const { logout } = useAuth();
  const { setEnabled } = useSuperAdminLock();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const enable = async () => {
    if (!password.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await setEnabled(true, password);
      // On success the SWR cache flips to enabled → AppLayout re-renders the app.
      setPassword('');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="bg-gradient-to-r from-rose-500 to-red-600 px-6 py-5 text-white">
          <div className="flex items-center gap-3">
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            <div>
              <h1 className="text-lg font-bold leading-tight">Super Admin API Access Disabled</h1>
              <p className="text-rose-100 text-xs">Privileged APIs are currently switched off.</p>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-600">
            All Super Admin API access is turned off. Enter your password to re-enable it,
            or log out so another administrator can take over.
          </p>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') enable(); }}
              autoFocus
              autoComplete="current-password"
              placeholder="Enter your password"
              className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:border-rose-500"
            />
          </div>
          {error && <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{error}</div>}
          <button
            onClick={enable}
            disabled={busy || !password.trim()}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Enabling…' : 'Enable Super Admin APIs'}
          </button>
          <button
            onClick={() => logout('manual')}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-slate-600 border border-slate-300 hover:bg-slate-100"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

/** Settings-page card to flip the switch while the app is unlocked. */
export function SuperAdminApiAccessCard() {
  const { isSuperAdmin, enabled, setEnabled, isLoading } = useSuperAdminLock();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!isSuperAdmin) return null;

  const target = !enabled; // the state we're flipping TO
  const submit = async () => {
    if (!password.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await setEnabled(target, password);
      setConfirming(false);
      setPassword('');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-800">Super Admin API Access</h3>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
              {isLoading ? '…' : enabled ? 'ENABLED' : 'DISABLED'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-prose">
            Master switch for everything the Super Admin can do via the API. When <b>disabled</b>,
            the Super Admin account is frozen (only login, logout and this switch keep working);
            regular admins are unaffected. Login is never blocked.
          </p>
        </div>
        {!confirming && (
          <button
            onClick={() => { setConfirming(true); setError(''); setPassword(''); }}
            className={`shrink-0 px-4 py-2 rounded-xl text-sm font-semibold text-white ${enabled ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
          >
            {enabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>

      {confirming && (
        <div className="mt-4 border-t border-slate-100 pt-4 space-y-3">
          {target === false && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              You are about to <b>disable</b> Super Admin API access. You will be locked out of all
              privileged APIs until you re-enable it (login, logout and this switch will still work).
            </div>
          )}
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Confirm with your password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              autoFocus
              autoComplete="current-password"
              placeholder="Enter your password"
              className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
            />
          </div>
          {error && <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{error}</div>}
          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={busy || !password.trim()}
              className={`px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 ${target ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
            >
              {busy ? 'Saving…' : target ? 'Enable' : 'Disable'}
            </button>
            <button
              onClick={() => { setConfirming(false); setPassword(''); setError(''); }}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 border border-slate-300 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
