import { useState, useEffect } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { useSession } from '@/hooks/use-session';
import { useSingleTab } from '@/hooks/use-single-tab';
import { useBranding } from '@/hooks/use-branding';
import { useRfidGuard } from '@/hooks/use-rfid-guard';
import { useOfflineConfig } from '@/hooks/use-offline-config';
import { useDragScroll } from '@/hooks/use-drag-scroll';
import { HardCutoffBlocker } from '@/components/hard-cutoff-blocker';
import { SuperAdminLockdownScreen } from '@/components/super-admin-api-access';
import { useSuperAdminLock } from '@/hooks/use-super-admin-lock';
import { FailedOpsPanel } from '@/components/failed-ops-panel';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import useSWR from 'swr';
import { triggerSync, startSyncPolling } from '@/lib/sync-since';

export function AppLayout() {
  useRfidGuard(); // Block RFID UKB input from going into random fields
  useDragScroll(); // App-wide click-drag horizontal panning for wide tables/grids
  // W2: read the SUPER_ADMIN-tuned offline-cache config and push the staleness
  // value into offline-store. Also exposes cacheHardCutoffHours for W4's
  // read-only blocker (consumed by a child component to be added in W4).
  useOfflineConfig();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  // Super Admin API kill-switch. When OFF and the current user is a SUPER_ADMIN,
  // we replace the whole app with the lockdown screen below (the only escape
  // routes are re-enable-with-password or logout, both still allowed server-side).
  const { isSuperAdmin, enabled: superAdminApiEnabled } = useSuperAdminLock();
  const location = useLocation();
  const { branding } = useBranding();
  const { data: passwordPolicy } = useSWR(isAuthenticated ? '/api/config/password-policy/current' : null, { revalidateOnMount: true, dedupingInterval: 5000 });
  // Extract session settings from consolidated password policy config
  const sessionConfig = passwordPolicy ? {
    autoLogoutEnabled: passwordPolicy.autoLogoutEnabled ?? true,
    idleTimeoutMinutes: passwordPolicy.idleTimeoutMinutes ?? 15,
    warningMinutes: passwordPolicy.warningMinutes ?? 2,
  } : null;
  const { showWarning, countdown, continueSession } = useSession(
    sessionConfig,
    // Idle auto-logout → tag it distinctly in the audit trail.
    () => logout('idle_timeout'),
  );
  const { isDuplicateTab, existingUserSession, claimActiveTab } = useSingleTab(
    isAuthenticated,
    user?.id,
    user?.username,
  );

  // Phase 8.4b — versioned-cache sync. Fires once at AppLayout mount (post-
  // auth, post-login redirect — keeps the login screen pristine), then wires
  // up visibilitychange + online + 60s poll triggers. Errors are swallowed
  // inside the trigger; the next event will retry. Teardown on unmount.
  useEffect(() => {
    if (!isAuthenticated) return;
    triggerSync('app-start');
    const teardown = startSyncPolling();
    return () => teardown();
  }, [isAuthenticated]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-r from-[#1e3a5f] to-[#3b82f6] animate-pulse" />
            <div className="absolute inset-0 w-12 h-12 rounded-xl bg-gradient-to-r from-[#1e3a5f] to-[#3b82f6] animate-ping opacity-20" />
          </div>
          <p className="text-sm text-slate-500 font-medium">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to={`/login?returnUrl=${encodeURIComponent(location.pathname)}`} replace />;
  }

  // Force password change redirect
  if (user?.forcePasswordChange) {
    return <Navigate to="/change-password" replace />;
  }

  // Show duplicate tab warning
  if (isDuplicateTab) {
    // Check if it's a different user or same user in different tab
    const isDifferentUser = existingUserSession && existingUserSession.userId !== user?.id;

    return (
      <div
        className="flex h-screen items-center justify-center p-8"
        style={{
          background: `linear-gradient(to bottom right, ${branding.loginBgStart}, ${branding.loginBgEnd}, ${branding.loginBgStart})`
        }}
      >
        <div className="w-full max-w-md">
          <div className="relative bg-white/95 backdrop-blur-sm rounded-3xl shadow-2xl overflow-hidden">
            <div
              className="h-2"
              style={{
                background: `linear-gradient(to right, ${branding.gradientStart}, ${branding.gradientMiddle}, ${branding.gradientEnd})`
              }}
            />
            <div className="p-8 text-center">
              <div className={`w-20 h-20 rounded-full ${isDifferentUser ? 'bg-red-100' : 'bg-amber-100'} flex items-center justify-center mx-auto mb-6`}>
                <svg className={`w-10 h-10 ${isDifferentUser ? 'text-red-600' : 'text-amber-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>

              {isDifferentUser ? (
                <>
                  <h2 className="text-2xl font-bold text-slate-800 mb-3">Another User is Logged In</h2>
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 mb-6">
                    <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mb-3">Active Session</p>
                    <div className="flex items-center justify-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                        <svg className="w-6 h-6 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                      </div>
                      <p className="font-semibold text-slate-800">{existingUserSession.username}</p>
                    </div>
                  </div>
                  <p className="text-slate-600 mb-6">
                    For security reasons, only one user can be logged in at a time on this browser/system.
                  </p>
                  <p className="text-sm text-slate-500 mb-6">
                    Please ask the current user to logout first, or logout your session below.
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-2xl font-bold text-slate-800 mb-3">Session Active in Another Tab</h2>
                  <p className="text-slate-600 mb-6">
                    You are already logged in another tab or browser window. For security reasons, only one active session is allowed per browser.
                  </p>
                  <p className="text-sm text-slate-500 mb-6">
                    Please close this tab and continue working in the other tab, or click below to use this tab instead.
                  </p>
                </>
              )}

              <div className="flex flex-col gap-3">
                {!isDifferentUser && (
                  <Button
                    onClick={claimActiveTab}
                    className="w-full"
                    style={{
                      background: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                    }}
                  >
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    Use This Tab Instead
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => logout()}
                  className="w-full"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Logout
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Super Admin API access switched OFF → freeze the superadmin behind the
  // lockdown wall (re-enable with password, or log out). Placed after the
  // auth/forcePasswordChange/duplicate-tab gates so those still take priority.
  if (isSuperAdmin && !superAdminApiEnabled) {
    return <SuperAdminLockdownScreen />;
  }

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar userRole={user?.role ?? ''} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header user={user} onLogout={logout} onMenuToggle={() => setSidebarOpen(o => !o)} />
        <main className="flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6 bg-gradient-to-br from-slate-50 to-slate-100/50">
          <Outlet />
        </main>
      </div>

      {/* W4: read-only blocker overlay when hard-cutoff window has elapsed
          since the last successful server contact. Renders nothing under
          normal conditions. */}
      <HardCutoffBlocker />

      {/* Floating "couldn't sync" review panel — appears only when there are
          terminal-failed offline operations to retry or dismiss. */}
      <FailedOpsPanel />

      {/* Session Timeout Warning Dialog */}
      <Dialog open={showWarning} onClose={continueSession}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-100 text-amber-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            Session Timeout Warning
          </DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <p className="text-sm text-slate-600">
            Your session will expire due to inactivity in
          </p>
          <div className="mt-3 flex items-center justify-center">
            <div className="px-6 py-3 rounded-2xl bg-red-50 border border-red-100">
              <span className="text-4xl font-bold text-red-600">{countdown}</span>
              <span className="text-sm text-red-500 ml-2">seconds</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => logout()}>
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Logout Now
          </Button>
          <Button onClick={continueSession}>
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Continue Session
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
