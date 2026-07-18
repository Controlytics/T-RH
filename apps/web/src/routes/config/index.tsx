import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { SuperAdminApiAccessCard } from '@/components/super-admin-api-access';
import { canAccessConfigModule } from './can-access-module';
import { useAhuCompletionMode } from '@/hooks/use-ahu-completion-mode';

const configCards = [
  {
    title: 'General & Password Settings',
    description: 'Configure password policy, login security, and session timeout',
    href: '/config/password-policy',
    reauth: true,
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
      </svg>
    ),
    gradient: 'from-blue-500 to-indigo-600',
    shadowColor: 'shadow-blue-500/25',
  },
  {
    title: 'Date/Time Format',
    description: 'Set application date and time display format',
    href: '/config/datetime',
    reauth: false,
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
    gradient: 'from-purple-500 to-pink-600',
    shadowColor: 'shadow-purple-500/25',
  },
  {
    title: 'Backup & Restore',
    description: 'Export or restore the entire database',
    href: '/config/backup',
    reauth: false,
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    ),
    gradient: 'from-emerald-500 to-teal-600',
    shadowColor: 'shadow-emerald-500/25',
  },
  {
    title: 'User ID Format',
    description: 'Configure User ID format and rules',
    href: '/config/user-id',
    reauth: false,
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
      </svg>
    ),
    gradient: 'from-teal-500 to-emerald-600',
    shadowColor: 'shadow-teal-500/25',
  },
];

const superAdminCards = [
  {
    title: 'Configuration Access',
    description: 'Assign config modules to roles — choose what each role can open',
    href: '/config/access-matrix',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    gradient: 'from-indigo-500 to-purple-600',
    shadowColor: 'shadow-indigo-500/25',
  },
  {
    title: 'Schedule AHU Filters',
    description: 'Per role, allow expanding an AHU to see its filters — set independently for the PM Schedule and Replacement Schedule pages',
    href: '/config/replacement-schedule-filters',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    ),
    gradient: 'from-teal-500 to-cyan-600',
    shadowColor: 'shadow-teal-500/25',
  },
  {
    title: 'Branding & Dashboard',
    description: 'Logo, colors, themes, company & app name — plus which dashboard cards each role sees',
    href: '/config/appearance',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
      </svg>
    ),
    gradient: 'from-violet-500 to-fuchsia-600',
    shadowColor: 'shadow-violet-500/25',
  },
  {
    title: 'Report Configuration',
    description: 'Identity, per-report labels & columns, per-role signatories, and export (PDF/Excel) access — all in one place',
    href: '/config/report-config',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    gradient: 'from-indigo-500 to-purple-600',
    shadowColor: 'shadow-indigo-500/25',
  },
  {
    title: 'Tablet App Access',
    description: 'Control which roles can login and access features on the tablet app',
    href: '/config/tablet-access',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    ),
    gradient: 'from-cyan-500 to-teal-600',
    shadowColor: 'shadow-cyan-500/25',
  },
  {
    title: 'Role & Access Configuration',
    description: 'Manage roles, permissions, sidebar visibility, and re-authentication',
    href: '/config/roles',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
    ),
    gradient: 'from-violet-500 to-purple-600',
    shadowColor: 'shadow-violet-500/25',
  },
  {
    title: 'Display Settings',
    description: 'Field display names, audit-trail wording, and list page sizes — all in one place',
    href: '/config/display-settings',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h10" />
      </svg>
    ),
    gradient: 'from-cyan-500 to-blue-600',
    shadowColor: 'shadow-cyan-500/25',
  },

  {
    title: 'LDAP / Active Directory',
    description: 'Configure LDAP authentication and user provisioning',
    href: '/config/ldap',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
      </svg>
    ),
    gradient: 'from-green-500 to-emerald-600',
    shadowColor: 'shadow-green-500/25',
  },
  {
    title: 'Help Articles',
    description: 'Manage contextual help content and documentation',
    href: '/config/help',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    gradient: 'from-emerald-500 to-teal-600',
    shadowColor: 'shadow-emerald-500/25',
  },
  // 'Alarm Columns' config card removed 2026-05-17 (alarm subsystem retired).
  
  {
    title: "Notification Rules",
    description: "Configure alerts, recipients, templates & delivery logs",
    href: "/config/notification-rules",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
    ),
    gradient: "from-amber-500 to-orange-600",
    shadowColor: "shadow-amber-500/25",
  },
  {
    title: "Notification Channels",
    description: "Configure email SMTP and SMS provider settings",
    href: "/config/email-settings",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    gradient: "from-blue-500 to-indigo-600",
    shadowColor: "shadow-blue-500/25",
  },
  {
    title: 'Filter Data Management',
    description: 'Edit, delete, or unretire retirement and replacement records (no audit trail)',
    href: '/config/filter-data-management',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    ),
    gradient: 'from-red-500 to-rose-600',
    shadowColor: 'shadow-red-500/25',
  },
  {
    title: 'Filter Setup',
    description: 'Cleaning-profile assignment rules, cleaning reasons, and filter add/edit dropdown options',
    href: '/config/filter-setup',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.879a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
      </svg>
    ),
    gradient: 'from-amber-500 to-orange-600',
    shadowColor: 'shadow-amber-500/25',
  },
  {
    title: 'AHU Cleaning Completion Process',
    description: 'Interlock / Popup / None for final-stage submission',
    href: '/config/dynamic/ahu-completion-process',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
      </svg>
    ),
    gradient: 'from-teal-500 to-emerald-600',
    shadowColor: 'shadow-teal-500/25',
  },
  // PM Schedule Settings is edited on the consolidated Role Assignments page
  // (Section "PM Schedule Settings"). The old standalone card was a duplicate
  // and has been removed — see roleAssignmentKeys in ConfigIndexPage.
  {
    title: 'Role Assignments',
    description: 'All role assignments in one place — PM workflow, block-change, QNN visibility, guest requests',
    href: '/config/role-assignments',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a3 3 0 10-2.5-4.5" />
      </svg>
    ),
    gradient: 'from-cyan-500 to-blue-600',
    shadowColor: 'shadow-cyan-500/25',
  },
  // PM Schedule Approval, Block Change Approval (Cross-Block Cleaning), and
  // Cleaning Stage Interlock are all edited on the consolidated Role Assignments
  // page. Their old standalone cards were duplicates and have been removed — see
  // roleAssignmentKeys in ConfigIndexPage.
  {
    title: 'Offline Cache & Lockout',
    description: 'Cache staleness window + hard-cutoff read-only lockout after losing server contact',
    href: '/config/offline-cache',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
        <line x1="3" y1="3" x2="21" y2="21" strokeLinecap="round" strokeWidth={1.5} stroke="currentColor" />
      </svg>
    ),
    gradient: 'from-slate-700 to-slate-900',
    shadowColor: 'shadow-slate-500/25',
  },
];

export function ConfigIndexPage() {
  const { user } = useAuth();

  // Auto-discovered config modules from registry
  const { data: manifest } = useSWR<Array<{
    moduleKey: string; moduleName: string; description: string;
    icon: string; category: string; sortOrder: number;
    requiredRole: string | null; hasCustomPage: boolean;
    customPagePath: string | null; settings: any[];
  }>>('/api/config/registry/manifest', { revalidateOnMount: true, dedupingInterval: 5000 });

  // Configuration access matrix — { [moduleKey]: [roleNames] }
  // If a module has an entry, only listed roles (plus SUPER_ADMIN) see it.
  // If a module is NOT in the matrix, it remains visible to all (backwards compat).
  const { data: accessMatrix } = useSWR<Record<string, string[]>>(
    '/api/config/access-matrix',
    { revalidateOnMount: true, dedupingInterval: 5000 },
  );

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  // Task 8 — AHU Interlock enforcement warning
  // Fetch the current AHU completion mode; when it's not NONE, also fetch the
  // list of active cleaning profiles whose final STAGE leads directly to END
  // without a terminal CHECKLIST node (those profiles cannot be enforced).
  const ahuMode = useAhuCompletionMode();
  const { data: unenforceableProfiles } = useSWR<{ profiles: { id: string; name: string }[] }>(
    isSuperAdmin && ahuMode !== 'NONE'
      ? '/api/filters/cleaning-profiles/without-final-checklist'
      : null,
    { revalidateOnMount: true, dedupingInterval: 10_000 },
  );
  // Modules that may be DELEGATED to a non-admin via Configuration Access (shown in
  // the Super Admin Settings section to a granted role). Filter Data Management edits/
  // deletes filter records, so it's the one card admins can hand off explicitly.
  const EXPLICIT_GRANT_KEYS = new Set(['filter-data-management']);
  // DEFAULT-DENY (Phase 2, gap S1): unconfigured modules are hidden from non-superadmins.
  // Was fail-OPEN — see can-access-module.ts. Card visibility only; endpoints gate server-side.
  const canAccessModule = (moduleKey: string | undefined) =>
    canAccessConfigModule(moduleKey, { isSuperAdmin, role: user?.role, accessMatrix });

  // Module key for a hardcoded card is the last segment of its href
  //   '/config/user-id' → 'user-id'
  const cardModuleKey = (href: string) => href.replace(/^\/config\/(dynamic\/)?/, '');

  // Every moduleKey already rendered as a hardcoded card — exclude from the dynamic fallback section
  const hardcodedModuleKeys = new Set(
    [...configCards, ...superAdminCards].map(c => cardModuleKey(c.href)),
  );

  // These keys are edited on the consolidated Role Assignments page
  // (/config/role-assignments), so they must NOT also appear as standalone
  // "Additional Modules" cards. Their defs are retained (with hasCustomPage:false)
  // ONLY so dynamic-routes.ts auto-generates their /api/config/dynamic/<key>
  // GET/PUT endpoints, which Role Assignments reads/writes — setting
  // hasCustomPage:true would drop those routes and break that page.
  const roleAssignmentKeys = new Set([
    'pm-schedule-approval', 'replacement-schedule-approval',
    'qnn-notifications', 'guest-cleaning-requests', 'block-change-approval',
    'stage-interlock', 'pm-schedule-settings',
    // Hosted in the consolidated "Filter Setup" page (hasCustomPage:false defs,
    // so they'd otherwise auto-render here once their standalone cards were removed).
    'filter-cleaning-reasons', 'filter-field-options',
  ]);

  // Group manifest entries by category
  const dynamicModules = (manifest ?? [])
    .filter(m => !m.hasCustomPage)
    .filter(m => !hardcodedModuleKeys.has(m.moduleKey))
    .filter(m => !roleAssignmentKeys.has(m.moduleKey))
    .filter(m => canAccessModule(m.moduleKey));

  const visibleConfigCards = configCards.filter(c => canAccessModule(cardModuleKey(c.href)));

  // Super Admin Settings cards. SUPER_ADMIN sees all; a non-admin sees ONLY the
  // cards explicitly granted to them in Configuration Access AND marked
  // delegable (EXPLICIT_GRANT_KEYS) — so e.g. Filter Data Management can be
  // delegated without exposing Branding / Roles / Backup / etc. The section
  // header still renders for any role that has at least one card here.
  const visibleSuperAdminCards = isSuperAdmin
    ? superAdminCards
    : superAdminCards.filter(c => {
        const k = cardModuleKey(c.href);
        return EXPLICIT_GRANT_KEYS.has(k) && (accessMatrix?.[k] ?? []).includes(user?.role ?? '');
      });

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-xl shadow-indigo-500/25">
          <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">System Configuration</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage system settings and security policies</p>
        </div>
      </div>

      {/* Security & General Settings */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            Security & General Settings
          </h2>
          <p className="text-sm text-slate-500 mt-1">Configure security policies and general application settings</p>
        </div>
        <div className="p-6">
          <div className="grid gap-5 sm:grid-cols-2">
            {visibleConfigCards.map((card) => (
              <Link key={card.href} to={card.href}>
                <div className={`group relative overflow-hidden rounded-2xl border-2 border-slate-200 bg-white p-6 transition-all duration-300 hover:border-slate-300 hover:shadow-xl ${card.shadowColor}`}>
                  {/* Background gradient on hover */}
                  <div className={`absolute inset-0 bg-gradient-to-br ${card.gradient} opacity-0 group-hover:opacity-5 transition-opacity duration-300`} />

                  <div className="relative flex items-start gap-4">
                    <div className={`p-3 rounded-xl bg-gradient-to-br ${card.gradient} text-white shadow-lg ${card.shadowColor} group-hover:scale-110 group-hover:shadow-xl transition-all duration-300`}>
                      {card.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-slate-800 group-hover:text-slate-900">{card.title}</h3>
                        {card.reauth && (
                          <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700 border-0">
                            Re-auth
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-slate-500 mt-1">{card.description}</p>
                      <div className="flex items-center text-sm text-indigo-600 mt-3 font-medium group-hover:text-indigo-700">
                        <span>Configure</span>
                        <svg className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Super Admin Settings */}
      {(isSuperAdmin || visibleSuperAdminCards.length > 0) && (
        <div className="bg-white rounded-2xl border-2 border-red-100 shadow-xl shadow-red-200/30 overflow-hidden">
          <div className="px-6 py-4 border-b border-red-100 bg-gradient-to-r from-red-50 to-pink-50">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-gradient-to-br from-red-500 to-pink-600">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                  Super Admin Settings
                  <Badge className="bg-gradient-to-r from-red-500 to-pink-500 text-white text-xs border-0 shadow-sm">
                    Restricted Access
                  </Badge>
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">Advanced configuration options for super administrators</p>
              </div>
            </div>
          </div>
          <div className="p-6">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {visibleSuperAdminCards.map((card) => (
                <Link key={card.href} to={card.href}>
                  <div className={`group relative overflow-hidden rounded-2xl border-2 border-slate-200 bg-white p-5 transition-all duration-300 hover:border-red-200 hover:shadow-xl ${card.shadowColor}`}>
                    {/* Background gradient on hover */}
                    <div className={`absolute inset-0 bg-gradient-to-br ${card.gradient} opacity-0 group-hover:opacity-5 transition-opacity duration-300`} />

                    <div className="relative">
                      <div className={`p-3 rounded-xl bg-gradient-to-br ${card.gradient} text-white shadow-lg ${card.shadowColor} group-hover:scale-110 group-hover:shadow-xl transition-all duration-300 inline-flex`}>
                        {card.icon}
                      </div>
                      <h3 className="font-semibold text-slate-800 mt-4 group-hover:text-slate-900">{card.title}</h3>
                      <p className="text-xs text-slate-500 mt-1">{card.description}</p>
                      <div className="flex items-center text-sm text-red-600 mt-3 font-medium group-hover:text-red-700">
                        <span>Configure</span>
                        <svg className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            {/* Master kill-switch for all Super Admin API access. */}
            <div className="mt-5">
              <SuperAdminApiAccessCard />
            </div>
          </div>
        </div>
      )}

      {/* AHU Interlock enforcement warning (Task 8) */}
      {/* Shown only to SUPER_ADMIN when mode is not NONE and some profiles are unenforceable */}
      {isSuperAdmin && ahuMode !== 'NONE' && (unenforceableProfiles?.profiles.length ?? 0) > 0 && (
        <div className="bg-amber-50 rounded-2xl border border-amber-200 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-800">
                AHU Interlock — Unenforceable Profiles
              </p>
              <p className="text-sm text-amber-700 mt-1">
                These cleaning profiles do not end with a checklist and will NOT be enforced by
                Interlock:{' '}
                <span className="font-medium">
                  {unenforceableProfiles!.profiles.map((p) => p.name).join(', ')}
                </span>
                . Add a Checklist node before END in the pipeline editor, or switch the AHU
                Completion mode to None.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Info Banner */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-2xl border border-blue-200 p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/25">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <h3 className="font-semibold text-blue-800">21 CFR Part 11 Compliance</h3>
            <p className="text-sm text-blue-700 mt-1">
              All security-critical settings require re-authentication and are logged in the audit trail for compliance purposes. Changes to these settings are recorded with timestamps and user information.
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Electronic Signatures
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Audit Trail
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                Access Control
              </span>
            </div>
          </div>
        </div>
      </div>
      {/* Dynamic Config Modules (auto-discovered) — Super Admin only */}
      {user?.role === 'SUPER_ADMIN' && dynamicModules && dynamicModules.length > 0 && (
        <section>
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-slate-800">Additional Modules</h2>
            <p className="text-sm text-slate-500 mt-1">Auto-discovered configuration modules</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {dynamicModules.map((mod) => (
              <Link key={mod.moduleKey} to={mod.customPagePath || `/config/dynamic/${mod.moduleKey}`} className="group">
                <Card className="relative overflow-hidden border border-slate-200 transition-all duration-200 hover:shadow-lg hover:border-slate-300 hover:-translate-y-0.5">
                  <CardContent className="pt-6 pb-4 px-6">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg flex items-center justify-center text-white flex-shrink-0">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-800 group-hover:text-blue-600 transition-colors">{mod.moduleName}</h3>
                        <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{mod.description}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between">
                      <span className="text-xs text-slate-400">{mod.settings.length} settings</span>
                      <span className="text-xs text-blue-600 font-medium group-hover:translate-x-0.5 transition-transform">Configure →</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
