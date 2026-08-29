import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { Badge } from '../ui/badge';
import { useBranding } from '@/hooks/use-branding';
import { getPhotoUrl } from '../../lib/url-utils';
import { Button } from '@/components/ui/button';

interface HeaderProps {
  user: {
    fullName: string;
    role: string;
    username: string;
    photoUrl?: string;
    email?: string;
    department?: string;
  } | undefined;
  onLogout: () => void;
  /** Slides the off-canvas sidebar in on a narrow viewport. */
  onMenuToggle?: () => void;
  /** Collapses the sidebar to its icon rail on a wide viewport. */
  onCollapseToggle?: () => void;
  collapsed?: boolean;
}

/**
 * The build this browser is running.
 *
 * Shown ONLY when it is not a production build. An environment chip that says
 * "PRODUCTION" on every screen is decoration; one that appears solely to warn
 * you that you are looking at a development build is information. The value is
 * Vite's own `MODE`, so it cannot drift from what was actually built.
 */
function EnvironmentChip() {
  if (import.meta.env.PROD) return null;
  return (
    <span
      className="hidden items-center gap-1.5 rounded-[var(--radius-pill)] border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-amber-800 sm:inline-flex"
      title="This is a development build, not the validated production system."
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      {import.meta.env.MODE}
    </span>
  );
}

/**
 * Role chips: a tint and a hairline, not a saturated gradient.
 *
 * These were six two-stop gradients in full-strength brand colours. Beside a
 * status badge that means something — an instrument in alarm, a delivery that
 * failed — a red gradient on a job title competes with it for the same alarm
 * reflex. Role is context, not condition, so it is drawn quietly and the strong
 * colour is left to the things an operator has to act on.
 */
const roleColors: Record<string, string> = {
  SUPER_ADMIN: 'bg-rose-50 text-rose-700 border border-rose-200',
  ADMIN: 'bg-sky-50 text-sky-700 border border-sky-200',
  SUPERVISOR: 'bg-amber-50 text-amber-800 border border-amber-200',
  MAINTENANCE: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  OPERATOR: 'bg-slate-100 text-slate-700 border border-slate-200',
  VIEWER: 'bg-slate-50 text-slate-600 border border-slate-200',
};

const roleLabels: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  MAINTENANCE: 'Maintenance',
  OPERATOR: 'Operator',
  VIEWER: 'Viewer',
};

export function Header({ user, onLogout, onMenuToggle, onCollapseToggle, collapsed }: HeaderProps) {
  const [showMenu, setShowMenu] = useState(false);
  const { branding } = useBranding();
  const navigate = useNavigate();

  // Fetch unread notifications count for all users
  const { data: notificationData } = useSWR<{ count: number }>(
    user ? '/api/notifications/unread-count' : null,
    { refreshInterval: 30000 } // Refresh every 30 seconds
  );
  const unreadCount = notificationData?.count ?? 0;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 shadow-[var(--elev-1)] lg:h-16 lg:px-5">
      {/* ── Left cluster ─────────────────────────────────────────────────────
          This was an empty spacer on desktop, which is why the top of every
          wide screen read as an unfinished strip. It now carries the two
          controls that belong to the shell rather than to the page — the
          navigation toggles — and the identity the sidebar surrenders when it
          collapses to a rail. */}
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="md:hidden"
          onClick={onMenuToggle}
          aria-label="Open navigation menu"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </Button>

        {onCollapseToggle && (
          <Button variant="ghost" size="icon" className="hidden md:flex"
            onClick={onCollapseToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3.75 5.25h16.5v13.5H3.75z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9.75 5.25v13.5" />
            </svg>
          </Button>
        )}

        {/* The application's name, shown here only once the sidebar has stopped
            showing it — never both at once. */}
        {collapsed && (
          <span className="hidden min-w-0 truncate text-[0.9375rem] font-semibold text-slate-800 md:block">
            {branding.appName}
          </span>
        )}

        <EnvironmentChip />
      </div>

      {/* Right side - User info */}
      <div className="flex shrink-0 items-center gap-2">
        {user && (
          <>
            {/* Notifications - Show for all users */}
            <Button variant="ghost" size="icon" className="relative"
              onClick={() => navigate('/notifications')}
              title={unreadCount > 0 ? `${unreadCount} unread notification(s)` : 'Notifications'}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {/* Notification badge */}
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-bold text-white bg-red-500 rounded-full animate-pulse">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </Button>

            {/* Divider */}
            <div className="h-8 w-px bg-slate-200" />

            {/* User dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="flex items-center gap-3 p-2 rounded-[var(--radius-control)] hover:bg-slate-100 transition-colors"
              >
                {/* Avatar/Photo */}
                {user.photoUrl ? (
                  <img
                    src={getPhotoUrl(user.photoUrl)}
                    alt={user.fullName}
                    className="w-10 h-10 rounded-[var(--radius-control)] object-cover shadow-[var(--elev-1)] border-2 border-white"
                  />
                ) : (
                  <div
                    className="w-10 h-10 rounded-[var(--radius-control)] flex items-center justify-center text-white font-semibold text-sm shadow-[var(--elev-1)]"
                    style={{ background: `linear-gradient(135deg, ${branding.primaryColor}, ${branding.secondaryColor})` }}
                  >
                    {user.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                )}
                <div className="hidden md:block text-left">
                  <p className="text-sm font-semibold text-slate-700">{user.fullName}</p>
                  <div className="flex items-center gap-2">
                    <Badge className={`text-xs px-2 py-0 ${roleColors[user.role] ?? ''}`}>
                      {roleLabels[user.role] ?? user.role}
                    </Badge>
                  </div>
                </div>
                <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Dropdown menu */}
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                  <div className="absolute right-0 top-full mt-2 w-72 bg-white rounded-[var(--radius-card)] shadow-[var(--elev-3)] border border-slate-200 overflow-hidden z-50 animate-fade-in">
                    {/* User Info Header */}
                    <div
                      className="px-5 py-4 text-white"
                      style={{ background: `linear-gradient(135deg, ${branding.primaryColor}, ${branding.secondaryColor})` }}
                    >
                      <div className="flex items-center gap-4">
                        {user.photoUrl ? (
                          <img
                            src={getPhotoUrl(user.photoUrl)}
                            alt={user.fullName}
                            className="w-14 h-14 rounded-[var(--radius-control)] object-cover border-2 border-white/30"
                          />
                        ) : (
                          <div className="w-14 h-14 rounded-[var(--radius-control)] bg-white/20 flex items-center justify-center text-white font-bold text-xl">
                            {user.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-lg truncate">{user.fullName}</p>
                          <Badge className={`mt-1 text-xs px-2 py-0.5 ${roleColors[user.role] ?? ''}`}>
                            {roleLabels[user.role] ?? user.role}
                          </Badge>
                        </div>
                      </div>
                    </div>

                    {/* User Details */}
                    <div className="px-5 py-3 bg-slate-50 border-b border-slate-100">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3 text-sm">
                          <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          <span className="text-slate-500">User ID:</span>
                          <span className="font-medium text-slate-700">{user.username}</span>
                        </div>
                        {user.email && (
                          <div className="flex items-center gap-3 text-sm">
                            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                            <span className="text-slate-500">Email:</span>
                            <span className="font-medium text-slate-700 truncate">{user.email}</span>
                          </div>
                        )}
                        {user.department && (
                          <div className="flex items-center gap-3 text-sm">
                            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                            </svg>
                            <span className="text-slate-500">Department:</span>
                            <span className="font-medium text-slate-700">{user.department}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Menu Options */}
                    <div className="py-2">
                      <Link
                        to="/profile"
                        onClick={() => setShowMenu(false)}
                        className="flex items-center gap-3 px-5 py-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                      >
                        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>My Profile</span>
                      </Link>
                      <Link
                        to="/change-password"
                        onClick={() => setShowMenu(false)}
                        className="flex items-center gap-3 px-5 py-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                      >
                        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                        </svg>
                        <span>Change Password</span>
                      </Link>
                    </div>

                    {/* Logout */}
                    <div className="border-t border-slate-100 py-2">
                      <Button variant="ghost" className="w-full"
                        onClick={() => {
                          setShowMenu(false);
                          onLogout();
                        }}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                        </svg>
                        <span>Logout</span>
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  );
}
