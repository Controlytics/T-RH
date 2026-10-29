import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import useSWR from 'swr';
import { cn } from '@/lib/cn';
import { useBranding } from '@/hooks/use-branding';
import { useAuth } from '@/hooks/use-auth';
import { isSidebarItemVisible } from './sidebar-visibility';

interface SidebarProps {
  userRole: string;
  /** Off-canvas state on a narrow viewport. */
  open: boolean;
  onClose: () => void;
  /**
   * Rail mode on a wide viewport: icons only, labels on hover.
   *
   * Separate from `open` on purpose. `open` is a phone sliding the whole panel
   * in over the content; `collapsed` is a desktop trading label width for chart
   * width while keeping every destination reachable. Conflating them gives a
   * tablet a sidebar that is both half-width and half-off-screen.
   */
  collapsed?: boolean;
}

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
}

// All available nav items with their IDs matching the config
// Exported for the SIDEBAR_ITEMS<->allNavItems parity test. These two lists are
// independent: one drives the Roles & Access toggles, the other renders the nav.
export const allNavItems: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    href: '/',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    id: "users",
    label: "Users",
    href: "/users",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>),

  },
  {
    id: "admin-requests",
    label: "Admin Requests",
    href: "/admin-requests",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>),
  },
  {
    id: 'configuration',
    label: 'Configuration',
    href: '/config',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    href: '/notifications',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
    ),
  },
  {
    id: 'audit',
    label: 'Audit Trail',
    href: '/audit',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'system-health',
    label: 'System Health',
    href: '/system-health',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    id: 'instruments',
    label: 'Instruments',
    href: '/instruments',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
      </svg>
    ),
  },
  {
    id: 'functional-locations',
    label: 'Functional Locations',
    href: '/functional-locations',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
      </svg>
    ),
  },
  {
    id: 'alarms',
    label: 'Alarms',
    href: '/alarms',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
    ),
  },
  {
    id: 'debug-traces',
    label: 'Debug Traces',
    href: '/debug/traces',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
      </svg>
    ),
  },
  {
    // 2026-09-07: the Instrument History widget, off the dashboard onto its own page.
    id: 'data-report',
    label: 'Data Report',
    href: '/data-report',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-4m3 4v-8m3 8v-2m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    // 2026-09-07: the report review workflow — every PDF download is a request.
    id: 'reports',
    label: 'Reports',
    href: '/reports',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    // 2026-09-08: every instrument's details and attributes in one table.
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    // 2026-10-29: the dashboard builder's list. Visibility reuses `dashboard.view`.
    id: 'dashboards',
    label: 'Dashboards',
    href: '/dashboards',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
      </svg>
    ),
  },
];

/**
 * True while the viewport is at least Tailwind's `md` (768px).
 *
 * The rail is a WIDE-viewport state, and it has to be one in JavaScript as well
 * as in CSS. Its width is a `md:` class, but what it renders — icon without
 * label, mark without app name, "§11" instead of the compliance line — is
 * decided in JS. Gating only the width would produce a 256px panel showing
 * icon-only content on a tablet, with no control to expand it, because the
 * toggle in the header is itself `md:flex`.
 */
function useIsWideViewport(): boolean {
  const query = '(min-width: 768px)';
  const [isWide, setIsWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setIsWide(e.matches);
    setIsWide(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isWide;
}

export function Sidebar({ userRole: _userRole, open, onClose, collapsed: collapsedPref = false }: SidebarProps) {
  const isWide = useIsWideViewport();
  // The preference only takes effect where it can be reversed.
  const collapsed = collapsedPref && isWide;
  const location = useLocation();
  const { branding } = useBranding();
  const { user } = useAuth();

  // Fetch user's sidebar configuration
  const { data: config } = useSWR('/api/config/my-config');

  // Check if a sidebar item is allowed by user's permissions.
  // Resolves from PERMISSION_TREE (visibilityPrivilegeIds) via the pure
  // isSidebarItemVisible helper.
  const hasPermissionForItem = (itemId: string): boolean =>
    isSidebarItemVisible(itemId, user?.permissions ?? []);

  // Filter items based on configuration AND permissions
  const filteredItems = allNavItems.filter((item) => {
    // SUPER_ADMIN sees everything
    if (user?.role === 'SUPER_ADMIN') return true;

    // Check permissions first — if user lacks permission, always hide
    if (!hasPermissionForItem(item.id)) return false;

    // If explicit sidebar config exists, also check it
    if (config?.sidebarItems && Array.isArray(config.sidebarItems) && config.sidebarItems.length > 0) {
      return config.sidebarItems.includes(item.id);
    }

    return true;
  });

  // Role/user-configured display order: config.sidebarItems is an ORDERED array
  // (the Sidebar config "Arrange Order" panel rearranges it). Honour that order;
  // items not present in the array (or when no config exists) keep their default
  // declaration order via a stable sort with a max-index fallback.
  const orderIndex = new Map<string, number>();
  if (config?.sidebarItems && Array.isArray(config.sidebarItems)) {
    config.sidebarItems.forEach((id: string, i: number) => orderIndex.set(id, i));
  }
  const orderOf = (id: string) => (orderIndex.has(id) ? orderIndex.get(id)! : Number.MAX_SAFE_INTEGER);
  const orderedItems = [...filteredItems].sort((a, b) => orderOf(a.id) - orderOf(b.id));

  return (
    <>
      {/* Backdrop overlay — visible on viewports < 768 px when sidebar is open. */}
      {open && (
        <div className="fixed inset-0 z-40 bg-slate-900/45 backdrop-blur-[2px] md:hidden" onClick={onClose} />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex max-w-[85vw] flex-col transition-[transform,width] duration-300 md:static md:max-w-none md:translate-x-0',
          // The rail is 72px: enough for a 20px icon with a real hit target
          // around it, and narrow enough that giving up the labels buys back
          // meaningful width for the charts and tables beside it.
          //
          // `md:` IS REQUIRED. The control that toggles this lives in the header
          // as `md:flex`, so below that breakpoint there is no way to expand
          // again — an operator who collapsed the rail on a desktop panel PC
          // would open the app on a tablet in portrait and find a 72px
          // icon-only drawer with no control to undo it. Collapsed is a
          // wide-viewport state only; narrow always gets the full-width
          // off-canvas panel.
          'w-64',
          collapsed && 'md:w-[72px]',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{ background: `linear-gradient(180deg, ${branding.primaryColor} 0%, ${branding.loginBgStart} 100%)` }}
      >
      {/* ── Brand ───────────────────────────────────────────────────────────
          Collapsed, this drops to the mark alone. The application NAME is the
          first thing to go: it is the one piece of the sidebar that the header
          repeats, so losing it here costs nothing. */}
      <div className={cn('flex flex-col items-center border-b border-white/10', collapsed ? 'py-3' : 'py-3.5')}>
        <Link
          to="/"
          className="flex w-full flex-col items-center rounded-[var(--radius-card)] px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
          title={collapsed ? branding.appName : undefined}
        >
          {branding.logoUrl ? (
            <div className="flex max-w-full items-center justify-center rounded-[var(--radius-card)] bg-white px-2.5 py-1.5 shadow-[var(--elev-1)]">
              <img
                src={branding.logoUrl}
                alt={branding.appName}
                className={cn('h-auto w-auto max-w-full object-contain', collapsed ? 'max-h-8' : 'max-h-12')}
              />
            </div>
          ) : (
            <div
              className={cn(
                'flex items-center justify-center rounded-[var(--radius-card)] font-bold text-white shadow-[var(--elev-2)]',
                collapsed ? 'h-10 w-10 text-xs' : 'h-12 w-12 text-sm',
              )}
              style={{ background: `linear-gradient(135deg, ${branding.secondaryColor} 0%, ${branding.accentColor} 100%)` }}
            >
              {branding.logoText}
            </div>
          )}
          {!collapsed && (
            <span className="mt-2 break-words px-1 text-center text-[0.8125rem] font-semibold leading-tight text-white">
              {branding.appName}
            </span>
          )}
        </Link>
      </div>

      {/* ── Navigation ──────────────────────────────────────────────────────
          A FLAT list, deliberately NOT grouped into sections. The order here is
          the operator's: `config.sidebarItems` is an ordered array that Config →
          Roles & Access → Sidebar rearranges. Imposing "Operations / Admin /
          System" headings would silently override an arrangement someone chose
          on purpose — a worse outcome than a longer list. */}
      <nav className={cn('flex-1 space-y-1 overflow-y-auto py-4', collapsed ? 'px-2' : 'px-3')}>
        {!collapsed && (
          <p className="mb-2 px-3 text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-white/40">Menu</p>
        )}
        {orderedItems.map((item) => {
          const active = item.href === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              to={item.href}
              onClick={onClose}
              aria-current={active ? 'page' : undefined}
              data-active={active ? 'true' : 'false'}
              // The native tooltip IS the label when there is no label. Not a
              // custom popover: this has to work for someone tabbing through
              // without a pointer, and `title` is what gets announced.
              title={collapsed ? item.label : undefined}
              className={cn(
                'group relative flex items-center rounded-[var(--radius-card)] text-[0.875rem] font-medium transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70',
                collapsed ? 'h-11 justify-center' : 'gap-3 px-3 py-2.5',
                // UI v3 (2026-09-21): the active item is a WHITE PILL with the
                // theme's ink — cc-dashboard.png — so the current screen reads
                // from across the room. The pill is the marker; the dot at the
                // right edge is its punctuation. No rail.
                active
                  ? 'bg-white text-[var(--theme-primary,#2a78d6)] shadow-[var(--elev-1)]'
                  : 'text-white/75 hover:bg-white/10 hover:text-white',
              )}
            >
              {active && !collapsed && (
                <span
                  aria-hidden
                  className="absolute right-3 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[var(--theme-primary,#2a78d6)]"
                />
              )}
              <span className={cn('shrink-0 transition-colors', active ? 'text-[var(--theme-primary,#2a78d6)]' : 'text-white/60 group-hover:text-white')}>
                {item.icon}
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* ── Footer ──────────────────────────────────────────────────────────
          The compliance statement is the reason this product exists, so it
          stays visible. Collapsed, it reduces to the §11 mark with the full
          sentence on hover. */}
      <div className={cn('border-t border-white/10', collapsed ? 'p-2' : 'p-3')}>
        {collapsed ? (
          <div
            className="flex h-10 items-center justify-center rounded-[var(--radius-card)] bg-white/5 text-[0.625rem] font-semibold tracking-wide text-white/70"
            title={`${branding.companyName} — 21 CFR Part 11 Compliant`}
          >
            §11
          </div>
        ) : (
          <div className="rounded-[var(--radius-card)] bg-white/5 p-3">
            <p className="truncate text-[0.75rem] font-medium text-white/80">{branding.companyName}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-white/45">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
              21 CFR Part 11 Compliant
            </p>
          </div>
        )}
      </div>
    </aside>
    </>
  );
}
