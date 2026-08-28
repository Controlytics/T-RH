import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useSearchParams } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@digilog/shared';
import { useAuth } from '@/hooks/use-auth';
import { useBranding } from '@/hooks/use-branding';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { checkExistingUserSession, type ActiveSessionInfo } from '@/hooks/use-single-tab';

export function LoginPage() {
  const { login, isAuthenticated, isLoading } = useAuth();
  const [searchParams] = useSearchParams();

  // All hooks must be called unconditionally before any early return
  const { branding } = useBranding();
  const { formatDateTime } = useDatetimeFormat();
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Check if another user is logged in on this system
  const [systemSession, setSystemSession] = useState<ActiveSessionInfo | null>(null);
  const [showSystemSessionDialog, setShowSystemSessionDialog] = useState(false);

  // Session conflict state (server-side active session detected)
  const [sessionConflict, setSessionConflict] = useState<{
    type: 'same_user' | 'different_user';
    ipAddress: string;
    loginTime: string;
    lastActiveAt?: string;
    username?: string;
    fullName?: string;
  } | null>(null);
  const [showSessionConflictDialog, setShowSessionConflictDialog] = useState(false);
  const [pendingCredentials, setPendingCredentials] = useState<{ username: string; password: string } | null>(null);
  const [forceLoginLoading, setForceLoginLoading] = useState(false);

  // Check for existing system session on mount
  useEffect(() => {
    const existingSystemSession = checkExistingUserSession();
    if (existingSystemSession) {
      setSystemSession(existingSystemSession);
      setShowSystemSessionDialog(true);
    }
  }, []);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
  });

  // If already authenticated, redirect to home — prevents back-button to login.
  // This must appear AFTER all hook calls to satisfy React Rules of Hooks.
  if (!isLoading && isAuthenticated) {
    const returnUrl = searchParams.get("returnUrl") || "/";
    return <Navigate to={returnUrl} replace />;
  }

  const onSubmit = async (data: LoginInput) => {
    setError('');

    try {
      await login(data.username, data.password);
    } catch (err: any) {
      if (err.code === 'SESSION_CONFLICT' && err.activeSession) {
        setPendingCredentials({ username: data.username, password: data.password });
        setSessionConflict({ type: 'same_user', ...err.activeSession });
        setShowSessionConflictDialog(true);
        return;
      }
      if (err.code === 'DIFFERENT_USER_SESSION_CONFLICT' && err.activeSession) {
        setPendingCredentials({ username: data.username, password: data.password });
        setSessionConflict({ type: 'different_user', ...err.activeSession });
        setShowSessionConflictDialog(true);
        return;
      }
      setError(err.message || 'Login failed');
    }
  };

  const handleForceLogin = async () => {
    if (!pendingCredentials) return;
    setForceLoginLoading(true);
    setError('');
    try {
      await login(pendingCredentials.username, pendingCredentials.password, true);
      setShowSessionConflictDialog(false);
      setPendingCredentials(null);
      setSessionConflict(null);
    } catch (err: any) {
      setShowSessionConflictDialog(false);
      setPendingCredentials(null);
      setSessionConflict(null);
      setError(err.message || 'Login failed');
    } finally {
      setForceLoginLoading(false);
    }
  };

  const handleCancelConflict = () => {
    setShowSessionConflictDialog(false);
    setPendingCredentials(null);
    setSessionConflict(null);
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center p-8"
      style={{
        background: `linear-gradient(to bottom right, ${branding.loginBgStart}, ${branding.loginBgEnd}, ${branding.loginBgStart})`
      }}
    >
      <div className="w-full max-w-md">
        {/* Login Card */}
        <div className="relative bg-white/95 backdrop-blur-sm rounded-[var(--radius-card)] shadow-[var(--elev-3)] overflow-hidden">
          {/* Decorative gradient header */}
          <div
            className="h-2"
            style={{
              background: `linear-gradient(to right, ${branding.gradientStart}, ${branding.gradientMiddle}, ${branding.gradientEnd})`
            }}
          />

          <div className="p-8 pt-6">
            {/* Branding */}
            <div className="text-center mb-8">
              {branding.logoUrl ? (
                <div className="inline-flex items-center justify-center w-52 h-40 mb-4">
                  <img
                    src={branding.logoUrl}
                    alt={branding.appName}
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : (
                <div
                  className="inline-flex items-center justify-center w-20 h-20 rounded-[var(--radius-card)] mb-4 shadow-[var(--elev-2)]"
                  style={{
                    background: `linear-gradient(to bottom right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                    boxShadow: `0 10px 40px -10px ${branding.secondaryColor}50`
                  }}
                >
                  <span className="text-3xl font-bold text-white tracking-tight">{branding.logoText}</span>
                </div>
              )}
              <h1
                className="mb-2 text-[26px] font-semibold tracking-[-0.01em]"
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

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              {error && (
                <div className="flex items-center gap-2.5 rounded-[var(--radius-control)] border border-rose-200 bg-rose-50 p-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-600">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <p className="text-[13px] font-medium text-rose-800">{error}</p>
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-[13px] font-medium text-slate-700">User ID</label>
                <div className="relative">
                  <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                    <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                  <Input
                    {...register('username')}
                    placeholder="Enter your user ID"
                    autoFocus
                    autoComplete="username"
                    className="pl-11"
                  />
                </div>
                {errors.username && (
                  <p className="mt-1 flex items-center gap-1.5 text-[12px] text-rose-700">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    {errors.username.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-[13px] font-medium text-slate-700">Password</label>
                <div className="relative">
                  <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                    <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                  <Input
                    {...register('password')}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    secureField
                    autoComplete="current-password"
                    className="pl-11 pr-16"
                  />
                  <button
                    type="button"
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-semibold transition-colors"
                    style={{ color: showPassword ? branding.secondaryColor : undefined }}
                    onMouseOver={(e) => e.currentTarget.style.color = branding.secondaryColor}
                    onMouseOut={(e) => e.currentTarget.style.color = showPassword ? branding.secondaryColor : '#94a3b8'}
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                {errors.password && (
                  <p className="mt-1 flex items-center gap-1.5 text-[12px] text-rose-700">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    {errors.password.message}
                  </p>
                )}
                <div className="flex justify-end pt-1">
                  <a
                    href="/forgot-password"
                    className="text-sm font-semibold transition-colors"
                    style={{ color: branding.secondaryColor }}
                    onMouseOver={(e) => e.currentTarget.style.color = branding.primaryColor}
                    onMouseOut={(e) => e.currentTarget.style.color = branding.secondaryColor}
                  >
                    Forgot password?
                  </a>
                </div>
              </div>

              <Button
                type="submit"
                className="w-full" size="lg"
                style={{
                  background: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                  boxShadow: `0 10px 40px -10px ${branding.secondaryColor}50`,
                }}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Signing in...
                  </span>
                ) : 'Sign In'}
              </Button>
            </form>

            {/* The "Guest — Filter Cleaning Request" link was removed here: both
                the `/guest-request` route and the API's `guest` module went in
                the Phase 0 domain strip, so the link bounced straight back to
                /login — a dead control on a public, unauthenticated page. */}

            {/* Contact Admin */}
            <div className="mt-4 text-center">
              <a href="/contact-admin" className="text-sm font-medium text-cyan-600 hover:text-cyan-700 hover:underline">
                Contact Admin
              </a>
            </div>

            {/* Company info */}
            <div className="mt-6 pt-6 border-t border-slate-200 text-center">
              <p className="text-base font-bold text-slate-700">{branding.companyName}</p>
              <p className="text-sm text-slate-500 mt-1 font-semibold">Version {branding.version}</p>
            </div>
          </div>
        </div>
      </div>

      {/* System Session Warning Dialog - Another user is logged in on this system */}
      <Dialog open={showSystemSessionDialog} onClose={() => setShowSystemSessionDialog(false)} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            Another User is Logged In
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Another user is currently logged in on this browser/system. For security reasons, only one user can be logged in at a time.
          </p>

          {systemSession && (
            <div className="p-4 rounded-[var(--radius-control)] bg-slate-50 border border-slate-200 space-y-3">
              <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Current Session</p>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                  <svg className="w-6 h-6 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-slate-800">{systemSession.username}</p>
                  <p className="text-sm text-slate-500">Active in another tab/window</p>
                </div>
              </div>
            </div>
          )}

          <p className="text-sm text-slate-500">
            Please ask the current user to logout first, or close all browser tabs and try again.
          </p>
        </div>

        <DialogFooter>
          <Button
            onClick={() => setShowSystemSessionDialog(false)}
            variant="outline"
            className="w-full"
          >
            Close
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Session Conflict Dialog - Same user or different user conflict (server-side) */}
      <Dialog open={showSessionConflictDialog} onClose={handleCancelConflict} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
              sessionConflict?.type === 'different_user' ? 'bg-red-100' : 'bg-amber-100'
            }`}>
              <svg className={`w-5 h-5 ${
                sessionConflict?.type === 'different_user' ? 'text-red-600' : 'text-amber-600'
              }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            {sessionConflict?.type === 'different_user' ? 'Another User is Logged In' : 'Active Session Detected'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {sessionConflict?.type === 'different_user'
              ? 'Another user is currently logged in from this system. For security reasons, only one user can be active per system. Continuing will terminate their session.'
              : 'Your account is currently logged in from another location. Continuing will terminate the existing session.'}
          </p>

          {sessionConflict && (
            <div className="p-4 rounded-[var(--radius-control)] bg-slate-50 border border-slate-200 space-y-3">
              <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Existing Session</p>
              <div className="space-y-2">
                {sessionConflict.type === 'different_user' && sessionConflict.username && (
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    <span className="text-sm text-slate-700">
                      <span className="font-medium">User:</span> {sessionConflict.fullName || sessionConflict.username} ({sessionConflict.username})
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                  <span className="text-sm text-slate-700">
                    <span className="font-medium">IP Address:</span> {sessionConflict.ipAddress}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm text-slate-700">
                    <span className="font-medium">Logged in:</span> {formatDateTime(sessionConflict.loginTime)}
                  </span>
                </div>
              </div>
            </div>
          )}

          <p className="text-sm text-slate-500">
            {sessionConflict?.type === 'different_user'
              ? 'Do you want to continue and logout the other user\'s session?'
              : 'Do you want to continue and logout the other session?'}
          </p>
        </div>

        <DialogFooter>
          <Button
            onClick={handleCancelConflict}
            variant="outline"
            disabled={forceLoginLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleForceLogin}
            disabled={forceLoginLoading}
            className="font-semibold"
            style={{
              background: sessionConflict?.type === 'different_user'
                ? undefined
                : `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
              backgroundColor: sessionConflict?.type === 'different_user' ? '#dc2626' : undefined,
            }}
          >
            {forceLoginLoading ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Continuing...
              </span>
            ) : sessionConflict?.type === 'different_user'
              ? `Continue & Logout ${sessionConflict?.username ?? 'User'}`
              : 'Continue & Logout Old Session'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
