import { useAuth } from '@/hooks/use-auth';
import { useBranding } from '@/hooks/use-branding';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { useMemo, useState } from 'react';
import { TelemetryTable } from './telemetry-table';
import { FloorplanView } from './floorplan-view';

const statCardIcons = {
  users: (
    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  ),
  audit: (
    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  notifications: (
    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  ),
};

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  href: string;
  delay?: string;
}

const themeGradient = 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))';

function StatCard({ title, value, icon, href, delay = '0ms' }: StatCardProps) {
  return (
    <Link to={href} className="group" style={{ animationDelay: delay }}>
      <div className="relative overflow-hidden rounded-2xl bg-white border border-slate-200/60 shadow-soft hover:shadow-elevated transition-all duration-300 hover:-translate-y-1">
        {/* Gradient accent bar */}
        <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundImage: themeGradient }} />

        <div className="p-6">
          <div className="flex items-start justify-between">
            <div className="space-y-3">
              <p className="text-sm font-medium text-slate-500 uppercase tracking-wider">{title}</p>
              <p className="text-4xl font-bold text-slate-800">{value}</p>
            </div>
            <div className="p-3 rounded-xl text-white shadow-lg group-hover:scale-110 transition-transform duration-300" style={{ backgroundImage: themeGradient }}>
              {icon}
            </div>
          </div>

          <div className="mt-4 flex items-center text-sm text-slate-500 group-hover:text-slate-700 transition-colors">
            <span>View details</span>
            <svg className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </div>
      </div>
    </Link>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const { branding } = useBranding();
  const { formatDate } = useDatetimeFormat();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const isAdmin = isSuperAdmin || (user?.permissions?.includes('USER_READ') ?? false);

  const swrOpts = { revalidateOnMount: true, revalidateOnFocus: true, dedupingInterval: 2000, refreshInterval: 30000 };
  const { data: userStats } = useSWR(isAdmin ? '/api/users/stats' : null, swrOpts);
  const { data: auditStats } = useSWR('/api/audit?limit=1', swrOpts);
  const { data: notifStats } = useSWR('/api/notifications?limit=1', swrOpts);
  // The `/api/filters/dashboard-stats` poll that fed the Filter Cleaning
  // Analytics block was removed with the filters domain (Phase 0). It 404'd
  // every 20s forever; the block it fed rendered only when the fetch succeeded,
  // so it had been permanently invisible.
  const { data: cardConfig } = useSWR<any>('/api/config/dashboard-cards/current', { revalidateOnFocus: false, dedupingInterval: 10000 });

  // Resolve visible cards for current user's role
  const visibleCards = useMemo(() => {
    const roleName = user?.role ?? '';
    const rolesMap: Record<string, string[]> = cardConfig?.roles ?? {};
    // If no config exists yet, show all cards
    return rolesMap[roleName] ?? null;
  }, [cardConfig, user?.role]);
  const showCard = (key: string) => visibleCards === null || visibleCards.includes(key);

  const [view, setView] = useState<'table' | 'graphical'>('table');

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Welcome Section */}
      <div
        className="relative overflow-hidden rounded-2xl p-8 text-white shadow-elevated"
        style={{ backgroundImage: themeGradient }}
      >
        <div className="relative z-10">
          <p className="text-white/70 text-sm font-medium mb-1">Welcome back,</p>
          <h1 className="text-3xl font-bold mb-2">{user?.fullName}</h1>
          <p className="text-white/80 text-sm">
            {branding.appName}{branding.appTagline ? ` — ${branding.appTagline}` : ''}
          </p>
        </div>

        {/* Background decoration */}
        <div className="absolute right-0 top-0 w-64 h-64 opacity-10">
          <svg viewBox="0 0 200 200" className="w-full h-full">
            <circle cx="100" cy="100" r="80" fill="currentColor" />
            <circle cx="150" cy="50" r="40" fill="currentColor" />
          </svg>
        </div>

        {/* Quick stats in welcome banner */}
        <div className="relative z-10 mt-6 pt-6 border-t border-white/20 flex items-center gap-8">
          <div>
            <p className="text-white/70 text-xs uppercase tracking-wider">Role</p>
            <p className="text-lg font-semibold">{user?.role?.replace('_', ' ')}</p>
          </div>
          <div className="h-10 w-px bg-white/20" />
          <div>
            <p className="text-white/70 text-xs uppercase tracking-wider">Today</p>
            <p className="text-lg font-semibold">
              {formatDate(new Date())}
            </p>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div>
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Quick Overview</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {isAdmin && showCard('total_users') && (
            <StatCard
              title="Total Users"
              value={userStats?.total ?? '-'}
              icon={statCardIcons.users}
              href="/users"
              delay="0ms"
            />
          )}

          {showCard('audit_trail') && (
            <StatCard
              title="Audit Trail"
              value={auditStats?.total ?? '-'}
              icon={statCardIcons.audit}
              href="/audit"
              delay="50ms"
            />
          )}

          {showCard('notifications') && (
            <StatCard
              title="Notifications"
              value={notifStats?.total ?? '-'}
              icon={statCardIcons.notifications}
              href="/notifications"
              delay="100ms"
            />
          )}
        </div>
      </div>

      {/* Instrument Readings — table and floorplan views over live telemetry.
          Both slot into the existing per-role dashboard-cards config, so they
          are hidden per role by the same mechanism as every other card. */}
      {(showCard('telemetry_table') || showCard('telemetry_floorplan')) && (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-800">Instrument Readings</h2>
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
              {showCard('telemetry_table') && (
                <button
                  onClick={() => setView('table')}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    view === 'table' ? 'text-white' : 'text-slate-600 hover:text-slate-800'
                  }`}
                  style={view === 'table' ? { backgroundImage: themeGradient } : undefined}
                >
                  Table view
                </button>
              )}
              {showCard('telemetry_floorplan') && (
                <button
                  onClick={() => setView('graphical')}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    view === 'graphical' ? 'text-white' : 'text-slate-600 hover:text-slate-800'
                  }`}
                  style={view === 'graphical' ? { backgroundImage: themeGradient } : undefined}
                >
                  Graphical view
                </button>
              )}
            </div>
          </div>

          {view === 'table' && showCard('telemetry_table') && <TelemetryTable />}
          {view === 'graphical' && showCard('telemetry_floorplan') && <FloorplanView />}
        </div>
      )}

      {/* Quick Actions */}
      {showCard('quick_actions') && <div>
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Quick Actions</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {isAdmin && (
            <Link to="/users/create">
              <Card className="group cursor-pointer" style={{ borderColor: 'transparent' }}>
                <CardContent className="p-5 flex items-center gap-4">
                  <div
                    className="p-3 rounded-xl transition-colors"
                    style={{ backgroundColor: 'var(--theme-primary-light)', color: 'var(--theme-primary)' }}
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800">Create User</p>
                    <p className="text-sm text-slate-500">Add a new user account</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )}

          <Link to="/audit">
            <Card className="group cursor-pointer" style={{ borderColor: 'transparent' }}>
              <CardContent className="p-5 flex items-center gap-4">
                <div
                  className="p-3 rounded-xl transition-colors"
                  style={{ backgroundColor: 'var(--theme-accent-light)', color: 'var(--theme-accent)' }}
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-slate-800">View Audit Trail</p>
                  <p className="text-sm text-slate-500">Check system activities</p>
                </div>
              </CardContent>
            </Card>
          </Link>

          {isAdmin && (
            <Link to="/config">
              <Card className="group cursor-pointer" style={{ borderColor: 'transparent' }}>
                <CardContent className="p-5 flex items-center gap-4">
                  <div
                    className="p-3 rounded-xl transition-colors"
                    style={{ backgroundColor: 'var(--theme-primary-light)', color: 'var(--theme-primary-dark)' }}
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800">System Configuration</p>
                    <p className="text-sm text-slate-500">Manage system settings</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )}
        </div>
      </div>}

      {/* Compliance Badge */}
      <div className="flex items-center justify-center py-4">
        <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-slate-50 border border-slate-200">
          <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-700">21 CFR Part 11 Compliant</p>
            <p className="text-xs text-slate-500">{branding.companyName}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
