import { useState } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { useSession } from '@/hooks/use-session';
import { useSingleTab } from '@/hooks/use-single-tab';
import { useBranding } from '@/hooks/use-branding';
import { useDragScroll } from '@/hooks/use-drag-scroll';
import { backgroundLayerStyle } from '@/lib/background-style';
import { SuperAdminLockdownScreen } from '@/components/super-admin-api-access';
import { useSuperAdminLock } from '@/hooks/use-super-admin-lock';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import useSWR from 'swr';
import { safeStorage } from '@/lib/safe-storage';

/**
 * Where the sidebar's collapsed state lives.
 *
 * `localStorage`, not `sessionStorage`: this is a per-workstation display
 * preference, not session data. An operator who collapses the rail on a 1366px
 * panel PC wants it collapsed tomorrow morning too, and nothing here identifies
 * anybody — the auth token deliberately stays in `sessionStorage`, and this must
 * not be mistaken for it.
 */
const SIDEBAR_COLLAPSED_KEY = 'compliance-core.sidebarCollapsed';

function readCollapsedPreference(): boolean {
  // Through `safeStorage`: a browser set to block site data throws on ACCESS,
  // not on read, and an exception here would take the whole application shell
  // down with it. Since audit 2026-10-03 (WEB-3) that guard lives in ONE place.
  return safeStorage.local.get(SIDEBAR_COLLAPSED_KEY) === '1';
}

export function AppLayout() {
  useDragScroll(); // App-wide click-drag horizontal panning for wide tables/grids
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsedPreference);

  const toggleCollapsed = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      // A failed write is a preference not persisted; the toggle still works
      // for this session.
      safeStorage.local.set(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };
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

  if (isLoading) {
    return (
      /*
        THE ONE PLACE A SPINNER IS STILL RIGHT, and it is worth saying why so
        nobody "finishes the job" by replacing it.

        A skeleton is a promise about the shape of what is coming. Here nothing
        is known yet — the session has not resolved, so we do not know whether
        this becomes the dashboard, a login redirect, a forced password change
        or the super-admin lockdown screen. Drawing card outlines would promise
        a layout that four times out of five never appears.

        The mark also stops using the hardcoded #1e3a5f/#3b82f6 pair: this is
        the first thing an operator sees, and it should be their site's colour.
      */
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 animate-pulse rounded-[var(--radius-card)] bg-[var(--theme-primary,#2a78d6)]" />
            <div className="absolute inset-0 h-12 w-12 animate-ping rounded-[var(--radius-card)] bg-[var(--theme-primary,#2a78d6)] opacity-20" />
          </div>
          <p role="status" className="text-sm font-medium text-slate-500">Loading…</p>
        </div>
      </div>
    );
  }

  // No `?returnUrl=` (2026-10-03, operator): the login page never returns to
  // the page a session ended on — the next sign-in may be another role, and
  // its first screen was Access Denied. Every login lands on the dashboard.
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
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
          <div className="relative bg-white/95 backdrop-blur-sm rounded-[var(--radius-card)] shadow-[var(--elev-3)] overflow-hidden">
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
                  <h2 className="text-[1.1875rem] font-semibold leading-tight text-slate-800 mb-3">Another User is Logged In</h2>
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
                  <h2 className="text-[1.1875rem] font-semibold leading-tight text-slate-800 mb-3">Session Active in Another Tab</h2>
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

  // DASHBOARD ONLY. The dashboard is one route (`/`) with several levels inside it
  // — entry cards, a Block's Areas, the tabular and graphical views — so a single
  // pathname check covers every dashboard screen. Every other page keeps the plain
  // grey chrome: a wallpaper behind the Audit Trail or a config form is where
  // legibility actually suffers.
  const onDashboard = location.pathname === '/';

  // The operator-uploaded wallpaper, or null when none is set. Resolved by a pure
  // helper so the clamping and the url() escaping are unit-tested — Playwright cannot
  // authenticate in this repo, so no automated check ever sees this render.
  const backgroundStyle = onDashboard ? backgroundLayerStyle(branding) : null;

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar
        userRole={user?.role ?? ''}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={sidebarCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          user={user}
          onLogout={logout}
          onMenuToggle={() => setSidebarOpen(o => !o)}
          onCollapseToggle={toggleCollapsed}
          collapsed={sidebarCollapsed}
        />
        {/*
          The content pane. The wallpaper lives HERE — after the sidebar and below the
          header — not behind the chrome, and not on the viewport.

          Scoping it to this box is also what fixes where the image starts: the layer
          is sized to the pane, so `contain` centres the image within the content area
          instead of letterboxing it against the whole window (which is what made it
          appear to begin partway down the sidebar).

          The wallpaper sits OUTSIDE the scrolling <main> so it stays put while
          content scrolls over it. A layer inside a scrolling box would scroll away
          and only ever cover the first screenful.
        */}
        <div className="relative flex-1 overflow-hidden">
          {backgroundStyle && (
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-white">
              <div className="absolute inset-0" style={backgroundStyle} />
            </div>
          )}
          {/* With a wallpaper set the pane goes transparent so the image shows
              through. Without one every page's ground is WHITE (operator,
              2026-09-25: "make dashboard background white color in all pages").
              That closed a day of grounds: a grey gradient, then a theme tint
              ("background should be fully colorfull"), then a deep theme ground
              behind the dashboard's colour cards ("as per cards colors make
              background good color", "all pages should colorful"), then white.
              The colour lives on the cards, the bands and the tables now, not
              behind them. */}
          <main
            className={`absolute inset-0 overflow-y-auto p-3 sm:p-4 lg:p-6 ${backgroundStyle ? '' : 'bg-white'}`}
          >
            <Outlet />
          </main>
        </div>
      </div>

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
            <div className="px-6 py-3 rounded-[var(--radius-card)] bg-red-50 border border-red-100">
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
