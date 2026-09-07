import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { useAuth } from '@/hooks/use-auth';
import { PageHeader } from '@/components/ui/page-header';
import { SuperAdminApiAccessCard } from '@/components/super-admin-api-access';
import { canAccessConfigModule } from './can-access-module';

/**
 * One configuration destination.
 *
 * Every card on this screen was previously its own composition: a two-stop
 * gradient across the whole tile on hover, a coloured drop shadow keyed to that
 * gradient, a `scale-110` on the icon, a `border-2`, and an arrow row in a
 * different colour per section. Fourteen cards, fourteen slightly different
 * treatments, and colour spent on decoration rather than meaning.
 *
 * The colour is KEPT — this screen should not be grey — but it is spent in one
 * place: the icon tile. That is enough to tell Backup from Branding at a glance,
 * which is the only job the colour had. Everything structural (border, radius,
 * elevation, the Configure affordance) is now identical on every card, so the
 * grid reads as one set of things rather than fourteen.
 */
function ConfigCard({
  card, compact = false,
}: {
  card: { title: string; description: string; href: string; reauth?: boolean; icon: ReactNode; gradient: string };
  /** The denser layout used by the four-up Super Admin grid. */
  compact?: boolean;
}) {
  return (
    <Link
      to={card.href}
      className="group flex h-full flex-col rounded-[var(--radius-card)] border border-slate-200 bg-white p-4 shadow-[var(--elev-1)] transition-[box-shadow,border-color] duration-150 hover:border-slate-300 hover:shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)]"
    >
      <div className={compact ? 'space-y-3' : 'flex items-start gap-3.5'}>
        <span
          className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-gradient-to-br ${card.gradient} text-white shadow-[var(--elev-1)]`}
        >
          {card.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[0.9375rem] font-semibold text-slate-800">{card.title}</h3>
            {card.reauth && (
              // Says WHY it is marked, not just that it is. "Re-auth" alone
              // meant nothing to anyone who had not met the dialog yet.
              <span
                className="inline-flex items-center rounded-[var(--radius-pill)] border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-800"
                title="Saving here asks for your password again and is recorded in the audit trail."
              >
                Re-authentication
              </span>
            )}
          </div>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-slate-500">{card.description}</p>
        </div>
      </div>
      {/* `mt-auto` pins this to the bottom of the card. Without it the affordance
          floats directly under the description, so in a row of cards with
          different description lengths it lands at a different height on each —
          which is what the grid looked like before. */}
      <span className="mt-auto flex items-center gap-1 pt-3 text-[0.8125rem] font-medium text-[var(--theme-primary,#2a78d6)]">
        Configure
        <svg aria-hidden className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </Link>
  );
}

/**
 * A titled band of configuration cards.
 *
 * One shell for all three groups, so "Security & General", "Super Admin" and
 * "Additional Modules" stop being three different-looking containers.
 */
function ConfigGroup({
  title, description, icon, tone = 'neutral', badge, children,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  /** `restricted` tints the header only — the cards inside stay identical. */
  tone?: 'neutral' | 'restricted';
  badge?: ReactNode;
  children: ReactNode;
}) {
  const restricted = tone === 'restricted';
  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
      <header className={`flex items-start gap-3 border-b px-5 py-4 ${restricted ? 'border-rose-100 bg-rose-50/60' : 'border-slate-100 bg-slate-50/70'}`}>
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] ${restricted ? 'bg-rose-600' : 'bg-slate-700'} text-white`}>
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-[1.1875rem] font-semibold leading-tight text-slate-800">
            {title}
            {badge}
          </h2>
          {description && <p className="mt-0.5 text-[0.8125rem] text-slate-500">{description}</p>}
        </div>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

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
  },
];

const superAdminCards = [
  {
    // Promoted out of "Additional Modules" 2026-08-07 at the operator's
    // request. `cardModuleKey` strips the `/config/dynamic/` prefix, so listing
    // it here also removes it from the auto-discovered section below — a
    // hardcoded card and a dynamic card for one module would be two doors to
    // the same setting.
    // Promoted out of "Additional Modules" 2026-08-07, alongside Instrument
    // Attributes: the two are read together (the keys a device is asked for,
    // and when it counts as reporting) and an admin looking for one expects
    // the other beside it. Listing it here also removes it from the
    // auto-discovered section — `cardModuleKey` strips `/config/dynamic/`.
    title: 'Instrument Activity',
    description: 'How long an instrument may go without reporting before it shows as Inactive',
    href: '/config/dynamic/instrument-activity',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    gradient: 'from-emerald-500 to-teal-600',
  },
  {
    title: 'Instrument Attributes',
    description: 'The attribute keys the New Instrument form asks for, per instrument profile',
    href: '/config/instrument-attributes',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
      </svg>
    ),
    gradient: 'from-sky-500 to-cyan-600',
  },
  {
    title: 'Telemetry Keys',
    description: 'Which telemetry keys the dashboard reads as temperature and humidity',
    href: '/config/dynamic/telemetry-slots',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12h4l3-9 4 18 3-9h4" />
      </svg>
    ),
    gradient: 'from-teal-500 to-cyan-600',
  },
  {
    title: 'Instrument Limit Alarms',
    description: 'Which attributes hold the temperature and humidity limits, and each alarm status wording',
    href: '/config/dynamic/alarm-limits',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
    ),
    gradient: 'from-rose-500 to-orange-600',
  },
  {
    title: 'Inactivity Alarms',
    description: 'Raise an alarm when an instrument stops reporting, and clear it when telemetry returns',
    href: '/config/dynamic/inactivity-alarms',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.143 17.082a24.248 24.248 0 003.844.148m-3.844-.148a23.856 23.856 0 01-5.455-1.31 8.964 8.964 0 002.3-5.542m3.155 6.852a3 3 0 005.667 1.97m1.965-2.277L21 21m-4.225-4.225a23.81 23.81 0 003.536-1.003A8.967 8.967 0 0118 9.75V9A6 6 0 006.53 6.53m10.245 10.245L6.53 6.53M3 3l3.53 3.53" />
      </svg>
    ),
    gradient: 'from-slate-500 to-slate-700',
  },
  {
    title: 'RS485 Sensor Failure Alarms',
    description: 'Raise an alarm when a sensor reports NA or any non-numeric value, and clear it when a number returns',
    href: '/config/dynamic/rs485-alarms',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    ),
    gradient: 'from-amber-500 to-rose-600',
  },
  {
    title: 'Sensor Range Alarms',
    description: 'Raise an alarm when a reading is outside the sensor\'s measurable range, and show OL instead of the value',
    href: '/config/dynamic/sensor-range-alarms',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
    gradient: 'from-orange-500 to-amber-600',
  },
  {
    title: 'Alarm Type Names',
    description: 'What each kind of alarm is called — one name per type, applied everywhere it is shown',
    href: '/config/dynamic/alarm-type-names',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 6h.008v.008H6V6z" />
      </svg>
    ),
    gradient: 'from-sky-500 to-indigo-600',
  },
  {
    // Every field here is also editable in place, from a pencil in each
    // widget's own header on the trend page — the same `system_config` row,
    // reached two ways. This card is the one that lists all six widgets
    // together, which is what you want when renaming a word that appears on
    // several of them.
    title: 'Trend Page Widgets',
    description: 'What each widget on the instrument trend page is called, and how it prints dates and times',
    href: '/config/dynamic/trend-widgets',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
      </svg>
    ),
    gradient: 'from-violet-500 to-fuchsia-600',
  },
  {
    title: 'Report Approvers',
    description: 'Which roles may approve a report request — a report can only be sent to one of them, or to a user holding one',
    href: '/config/dynamic/report-approvers',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
      </svg>
    ),
    gradient: 'from-emerald-500 to-teal-600',
  },
  {
    title: 'Alarm Webhooks',
    description: 'Hooters and HTTP endpoints alarms are announced to, and what body to send',
    href: '/config/alarm-webhooks',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5.636 5.636a9 9 0 000 12.728m12.728 0a9 9 0 000-12.728M8.464 8.464a5 5 0 000 7.072m7.072 0a5 5 0 000-7.072M13 12a1 1 0 11-2 0 1 1 0 012 0z" />
      </svg>
    ),
    gradient: 'from-orange-500 to-amber-600',
  },
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

  // Group manifest entries by category
  const dynamicModules = (manifest ?? [])
    .filter(m => !m.hasCustomPage)
    .filter(m => !hardcodedModuleKeys.has(m.moduleKey))
    .filter(m => canAccessModule(m.moduleKey));

  const visibleConfigCards = configCards.filter(c => canAccessModule(cardModuleKey(c.href)));

  // Super Admin Settings cards: SUPER_ADMIN only.
  //
  // There used to be a delegation escape hatch here — an allow-list of modules a
  // non-admin could be granted through Configuration Access, whose sole member was
  // `filter-data-management`. That module went with the Phase 0 domain strip, so
  // the list matched no card and every non-admin already saw an empty section;
  // removing it changes nothing at runtime (2026-08-19, operator request).
  //
  // To delegate one of these cards again: re-introduce the allow-list, add the
  // module key, and grant the role that key in Configuration Access. Both halves
  // are required — the allow-list says "this card MAY be handed off", the access
  // matrix says "to this role" — and that split is deliberate, so a grant made for
  // a different purpose cannot quietly expose Branding, Roles or Backup.
  const visibleSuperAdminCards = isSuperAdmin ? superAdminCards : [];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="System Configuration"
        description="Manage system settings, security policies and instrument behaviour."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration' }]}
      />

      <ConfigGroup
        title="Security & General Settings"
        description="Security policies and general application settings"
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleConfigCards.map(card => (
            <ConfigCard key={card.href} card={card} />
          ))}
        </div>
      </ConfigGroup>

      {/* Super Admin Settings */}
      {(isSuperAdmin || visibleSuperAdminCards.length > 0) && (
        <ConfigGroup
          title="Super Admin Settings"
          description="Advanced configuration reserved for super administrators"
          tone="restricted"
          badge={
            <span className="inline-flex items-center rounded-[var(--radius-pill)] border border-rose-200 bg-white px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-rose-700">
              Restricted
            </span>
          }
          icon={
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {visibleSuperAdminCards.map(card => (
              <ConfigCard key={card.href} card={card} compact />
            ))}
          </div>

          {/* Master kill-switch for all Super Admin API access. */}
          <div className="mt-4">
            <SuperAdminApiAccessCard />
          </div>
        </ConfigGroup>
      )}

      {/* ── Compliance note ─────────────────────────────────────────────────
          A note, not a hero. This was a full-width gradient panel with a large
          gradient icon tile, and it sat visually LOUDER than the configuration
          cards it was explaining — it is standing information that never
          changes, so it now reads as the quietest thing on the screen. */}
      <aside className="rounded-[var(--radius-card)] border border-sky-200 bg-sky-50/70 p-4">
        <div className="flex items-start gap-3">
          <svg aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-sky-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <div className="min-w-0">
            <h3 className="text-[0.875rem] font-semibold text-sky-900">21 CFR Part 11 Compliance</h3>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-sky-800">
              Security-critical settings require re-authentication and are written to the audit trail with a timestamp and the
              user who made the change.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {['Electronic Signatures', 'Audit Trail', 'Access Control'].map(label => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-sky-200 bg-white px-2.5 py-0.5 text-[0.6875rem] font-medium text-sky-800"
                >
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </aside>
      {/* Dynamic Config Modules (auto-discovered) — Super Admin only */}
      {user?.role === 'SUPER_ADMIN' && dynamicModules && dynamicModules.length > 0 && (
        <ConfigGroup
          title="Additional Modules"
          description="Configuration modules discovered automatically from the registry"
          icon={
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 6h16M4 12h16M4 18h10" />
            </svg>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {dynamicModules.map(mod => (
              <Link
                key={mod.moduleKey}
                to={mod.customPagePath || `/config/dynamic/${mod.moduleKey}`}
                className="group flex h-full flex-col rounded-[var(--radius-card)] border border-slate-200 bg-white p-4 shadow-[var(--elev-1)] transition-[box-shadow,border-color] duration-150 hover:border-slate-300 hover:shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)]"
              >
                <div className="flex items-start gap-3.5">
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[0.9375rem] font-semibold text-slate-800">{mod.moduleName}</h3>
                    <p className="mt-1 line-clamp-2 text-[0.8125rem] leading-relaxed text-slate-500">{mod.description}</p>
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between pt-3">
                  <span className="text-[0.75rem] text-slate-400">
                    {mod.settings.length} {mod.settings.length === 1 ? 'setting' : 'settings'}
                  </span>
                  <span className="flex items-center gap-1 text-[0.8125rem] font-medium text-[var(--theme-primary,#2a78d6)]">
                    Configure
                    <svg aria-hidden className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </ConfigGroup>
      )}
    </div>
  );
}
