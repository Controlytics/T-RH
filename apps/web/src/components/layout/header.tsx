import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { Badge } from '../ui/badge';
import { useBranding } from '@/hooks/use-branding';
import { getPhotoUrl } from '../../lib/url-utils';

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
  onMenuToggle?: () => void;
}

const roleColors: Record<string, string> = {
  SUPER_ADMIN: 'bg-gradient-to-r from-red-500 to-pink-500 text-white border-0',
  ADMIN: 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white border-0',
  SUPERVISOR: 'bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0',
  MAINTENANCE: 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-0',
  OPERATOR: 'bg-gradient-to-r from-slate-500 to-gray-500 text-white border-0',
  VIEWER: 'bg-gradient-to-r from-gray-400 to-slate-400 text-white border-0',
};

const roleLabels: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  MAINTENANCE: 'Maintenance',
  OPERATOR: 'Operator',
  VIEWER: 'Viewer',
};

export function Header({ user, onLogout, onMenuToggle }: HeaderProps) {
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
    <header className="flex h-14 lg:h-16 items-center justify-between border-b border-slate-200 bg-white px-4 lg:px-6 shadow-sm">
      {/* Left side - Hamburger menu (mobile only) */}
      <button
        onClick={onMenuToggle}
        className="p-2 rounded-xl text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors lg:hidden"
        aria-label="Toggle menu"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <div className="hidden lg:block" /> {/* Spacer for desktop */}
      {/* Right side - User info */}
      <div className="flex items-center gap-3">
        {user && (
          <>
            {/* Notifications - Show for all users */}
            <button
              onClick={() => navigate('/notifications')}
              className="relative p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
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
            </button>

            {/* Divider */}
            <div className="h-8 w-px bg-slate-200" />

            {/* User dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="flex items-center gap-3 p-2 rounded-xl hover:bg-slate-100 transition-colors"
              >
                {/* Avatar/Photo */}
                {user.photoUrl ? (
                  <img
                    src={getPhotoUrl(user.photoUrl)}
                    alt={user.fullName}
                    className="w-10 h-10 rounded-xl object-cover shadow-md border-2 border-white"
                  />
                ) : (
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-semibold text-sm shadow-md"
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
                  <div className="absolute right-0 top-full mt-2 w-72 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-50 animate-fade-in">
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
                            className="w-14 h-14 rounded-xl object-cover border-2 border-white/30"
                          />
                        ) : (
                          <div className="w-14 h-14 rounded-xl bg-white/20 flex items-center justify-center text-white font-bold text-xl">
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
                      <button
                        onClick={() => {
                          setShowMenu(false);
                          onLogout();
                        }}
                        className="flex items-center gap-3 w-full px-5 py-3 text-sm text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                        </svg>
                        <span>Logout</span>
                      </button>
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
