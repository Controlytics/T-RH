import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import useSWR from 'swr';
import { cn } from '@/lib/cn';
import { useBranding } from '@/hooks/use-branding';
import { useAuth } from '@/hooks/use-auth';
import { isSidebarItemVisible } from './sidebar-visibility';

interface SidebarProps {
  userRole: string;
  open: boolean;
  onClose: () => void;
}

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
}

// All available nav items with their IDs matching the config
const allNavItems: NavItem[] = [
  {
    id: 'home',
    label: 'Home',
    href: '/home',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 12l8.954-8.955a1.5 1.5 0 012.122 0L22.28 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" />
      </svg>
    ),
  },
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
    id: 'report-reviews',
    label: 'Report Reviews',
    href: '/report-reviews',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'stage-approvals',
    label: 'Stage Approvals',
    href: '/stage-approvals',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
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
  // Rule Chains + Alarms sidebar items removed 2026-05-17 (subsystems retired).
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
    id: "filter-list",
    label: "Filters",
    href: "/filter-list",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>),
  },
  {
    id: "filter-retirements",
    label: "Retirement List",
    href: "/filter-retirements",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>),
  },
  {
    id: "filter-replacements",
    label: "Replacement List",
    href: "/filter-replacements",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>),
  },
  // Replacement Schedule is now a tab inside the Replacement List page
  // (no separate sidebar item).
  {
    id: "rfid-track-record",
    label: "RFID Track Record",
    href: "/rfid-track-record",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5.5 5.5 0 010-7.778m7.778 0a5.5 5.5 0 010 7.778M5.282 19.232a9.5 9.5 0 010-13.464m13.436 0a9.5 9.5 0 010 13.464M12 12h.01" /></svg>),
  },
  {
    id: "quality-notifications",
    label: "Quality Notifications",
    href: "/quality-notifications",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>),
  },
  {
    id: "filter-operations",
    label: "Filter Operations",
    href: "/filters",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0" /></svg>),
  },
  {
    id: "cleaning-cycles",
    label: "Filter Cleaning Record",
    href: "/cleaning-cycles",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>),
  },
  {
    id: "filter-lifecycle-report",
    label: "Filter Lifecycle Report",
    href: "/filter-lifecycle-report",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-6m4 6V7m4 10v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>),
  },
  {
    id: "checklists",
    label: "Checklists",
    href: "/checklists",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>),
  },
  {
    id: "cleaning-profiles",
    label: "Cleaning Profiles",
    href: "/filter-cleaning-profiles",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>),
  },
  {
    id: "equipment-groups",
    label: "Equipment Groups",
    href: "/config/equipment-groups",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>),
  },
  {
    id: "pm-schedules",
    label: "PM Schedules",
    href: "/pm-schedules",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>),
  },
  {
    id: "my-tasks",
    label: "My Tasks",
    href: "/my-tasks",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>),
  },
  {
    id: "deviations",
    label: "Deviations",
    href: "/deviations",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>),
  },
  // Approvals — only relevant in APPROVAL mode; visibility gated by the
  // block_change.* privileges in sidebar-privilege-map.
  {
    id: "approvals",
    label: "Approvals",
    href: "/approvals",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>),
  },
  // Report Templates + Generated Reports removed from the application (2026-06-08).
  {
    // Audit / Versions (2026-05-02): SUPER_ADMIN by default; assignable to
    // other roles via Role Privileges → Audit / Versions → View Version History.
    id: "version-history",
    label: "Version History",
    href: "/version-history",
    icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>),
  },
];

// Collapsible "Reports" group. Children are existing nav items (matched by id
// against allNavItems / filteredItems) — they are rendered nested under this
// group instead of in the flat list. Order here is the display order inside
// the expanded group.
const REPORTS_GROUP = {
  id: 'reports-group',
  label: 'Reports',
  childIds: ['rfid-track-record', 'cleaning-cycles', 'filter-lifecycle-report', 'deviations', 'quality-notifications'] as const,
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-6m4 6V7m4 10v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  ),
};

interface SidebarProps {
  userRole: string;
}

export function Sidebar({ userRole, open, onClose }: SidebarProps) {
  const location = useLocation();
  const { branding } = useBranding();
  const { user } = useAuth();

  // Fetch user's sidebar configuration
  const { data: config } = useSWR('/api/config/my-config');
  const { data: qnnVis } = useSWR<{ visible: boolean }>('/api/pm-schedules/qnn/visible');

  // Check if a sidebar item is allowed by user's permissions.
  // Phase 5B: resolves from PERMISSION_TREE (visibilityPrivilegeIds) via the pure
  // isSidebarItemVisible helper — behavior-identical to the prior SIDEBAR_PRIVILEGE_MAP
  // + FEATURE_TO_PERMISSION_MAP lookup (proven by sidebar-visibility.test.ts).
  const hasPermissionForItem = (itemId: string): boolean =>
    isSidebarItemVisible(itemId, user?.permissions ?? []);

  // Filter items based on configuration AND permissions
  const filteredItems = allNavItems.filter((item) => {
    // SUPER_ADMIN sees everything
    if (user?.role === 'SUPER_ADMIN') return true;

    // QNN report visibility is config-gated (qnn-notifications.visibleRoles),
    // not permission-mapped — hide until the server confirms this role may see it.
    if (item.id === 'quality-notifications' && !qnnVis?.visible) return false;

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

  // Reports group: pull the group's children out of the flat list and render
  // them nested under a collapsible "Reports" parent. Permission/config
  // filtering already happened in filteredItems, so the group simply hides any
  // child the user can't see — and hides itself entirely when none remain.
  // Children are ordered by the same configured order.
  const reportsChildren = REPORTS_GROUP.childIds
    .map((id) => filteredItems.find((i) => i.id === id))
    .filter((i): i is NavItem => Boolean(i))
    .sort((a, b) => orderOf(a.id) - orderOf(b.id));
  const anyReportActive = reportsChildren.some((c) => location.pathname.startsWith(c.href));
  const [reportsOpen, setReportsOpen] = useState(false);
  // Auto-expand the group whenever one of its routes becomes active.
  useEffect(() => {
    if (anyReportActive) setReportsOpen(true);
  }, [anyReportActive]);

  return (
    <>
      {/* Backdrop overlay — visible on viewports < 768 px when sidebar is open.
          Dismisses the sidebar on tap/click anywhere outside it.
          Audit finding N-5: auto-collapse sidebar below 768 px viewport. */}
      {open && (
        <div className="fixed inset-0 bg-black/30 z-40 md:hidden" onClick={onClose} />
      )}
      <aside
        className={cn(
          // Below md (768 px): fixed overlay, slides in/out via translate.
          // md and above: static in flow, always translated to 0 (always visible).
          // Audit N-5 polish (2026-05-29): cap at 85vw so the 256 px sidebar
          // doesn't cover the entire 320 px phone screen; below ~300 px viewport
          // the sidebar shrinks proportionally, always leaving a backdrop strip
          // visible for tap-dismiss. md+ ignores the cap.
          'fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col transition-transform duration-300 md:static md:max-w-none md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{ background: `linear-gradient(180deg, ${branding.primaryColor} 0%, ${branding.loginBgStart} 100%)` }}
      >
      {/* Logo Section */}
      <div className="flex flex-col items-center py-3 border-b border-white/10">
        <Link to="/" className="flex flex-col items-center w-full px-3">
          {branding.logoUrl ? (
            // White rounded card so the logo's own background looks intentional
            // (and stays legible) on the coloured sidebar gradient.
            <div className="bg-white rounded-xl px-3 py-2 shadow-sm max-w-full flex items-center justify-center">
              <img
                src={branding.logoUrl}
                alt={branding.appName}
                className="max-w-full max-h-12 w-auto h-auto object-contain"
              />
            </div>
          ) : (
            <div
              className="flex h-12 w-12 items-center justify-center rounded-xl text-white text-sm font-bold shadow-lg"
              style={{ background: `linear-gradient(135deg, ${branding.secondaryColor} 0%, ${branding.accentColor} 100%)` }}
            >
              {branding.logoText}
            </div>
          )}
          <span className="text-sm font-semibold text-white text-center leading-tight mt-2 px-1 break-words">{branding.appName}</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-4 overflow-y-auto">
        <p className="px-3 mb-3 text-xs font-semibold text-white/40 uppercase tracking-wider">Menu</p>
        {(() => {
          const renderFlatLink = (item: NavItem) => {
            const active = item.href === '/'
              ? location.pathname === '/'
              : item.href === '/assets'
                ? location.pathname === '/assets'
                : location.pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                to={item.href}
                onClick={onClose}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200',
                  active
                    ? 'bg-white/15 text-white shadow-lg backdrop-blur-sm'
                    : 'text-white/70 hover:bg-white/10 hover:text-white',
                )}
              >
                <span className={cn(
                  'transition-colors',
                  active ? 'text-white' : 'text-white/60'
                )}>
                  {item.icon}
                </span>
                {item.label}
                {active && (
                  <div className="ml-auto w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </Link>
            );
          };

          const reportsChildIds: readonly string[] = REPORTS_GROUP.childIds;
          const nodes: React.ReactNode[] = [];
          let groupInserted = false;

          for (const item of orderedItems) {
            if (reportsChildIds.includes(item.id)) {
              // Insert the whole Reports group at the position of its first
              // visible child, then skip the rest (they render nested).
              if (!groupInserted && reportsChildren.length > 0) {
                groupInserted = true;
                nodes.push(
                  <div key="reports-group">
                    <button
                      type="button"
                      onClick={() => setReportsOpen((o) => !o)}
                      aria-expanded={reportsOpen}
                      className={cn(
                        'w-full flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200',
                        anyReportActive
                          ? 'bg-white/15 text-white shadow-lg backdrop-blur-sm'
                          : 'text-white/70 hover:bg-white/10 hover:text-white',
                      )}
                    >
                      <span className={cn('transition-colors', anyReportActive ? 'text-white' : 'text-white/60')}>
                        {REPORTS_GROUP.icon}
                      </span>
                      {REPORTS_GROUP.label}
                      <svg
                        className={cn('ml-auto w-4 h-4 transition-transform duration-200', reportsOpen ? 'rotate-180' : '')}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {reportsOpen && (
                      <div className="mt-1 ml-4 pl-3 border-l border-white/10 space-y-1">
                        {reportsChildren.map((child) => {
                          const active = location.pathname.startsWith(child.href);
                          return (
                            <Link
                              key={child.href}
                              to={child.href}
                              onClick={onClose}
                              className={cn(
                                'flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200',
                                active
                                  ? 'bg-white/15 text-white shadow-lg backdrop-blur-sm'
                                  : 'text-white/70 hover:bg-white/10 hover:text-white',
                              )}
                            >
                              <span className={cn('transition-colors', active ? 'text-white' : 'text-white/60')}>
                                {child.icon}
                              </span>
                              {child.label}
                              {active && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-white" />}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }
              continue;
            }
            nodes.push(renderFlatLink(item));
          }

          return nodes;
        })()}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-white/10">
        <div className="rounded-xl bg-white/5 p-4 backdrop-blur-sm">
          <p className="text-xs font-medium text-white/80">{branding.companyName}</p>
          <p className="text-xs text-white/40 mt-1">21 CFR Part 11 Compliant</p>
        </div>
      </div>
    </aside>
    </>
  );
}
