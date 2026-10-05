import { allNavItems } from '@/components/layout/sidebar';
import { isSidebarItemVisible } from '@/components/layout/sidebar-visibility';

/**
 * Where a signed-in user LANDS (audit 2026-10-03, WEB-4).
 *
 * Every login goes to `/` since 2026-10-03, and `/` was unguarded: a role
 * without `DASHBOARD_VIEW` (a user-admin role, say) saw "0 instruments", an
 * empty Blocks overview and a readings-table error, with the 403 toast
 * suppressed and no sidebar entry for the page it was on. The tree declares
 * `dashboard.view` gated on `DASHBOARD_VIEW`; this applies it: the dashboard
 * when the role may see it, else the FIRST sidebar item the role can see
 * (the sidebar's own rule, so the landing page is always one the user has a
 * link to), else the profile page, which every signed-in user may open.
 *
 * Pure, so the rule is tested without a router.
 */
export const DASHBOARD_VIEW_PERMISSION = 'DASHBOARD_VIEW';

export function landingRoute(perms: readonly string[], role: string | null | undefined): string {
  if (role === 'SUPER_ADMIN' || perms.includes(DASHBOARD_VIEW_PERMISSION)) return '/';
  const first = allNavItems.find((item) => item.href !== '/' && isSidebarItemVisible(item.id, [...perms]));
  return first?.href ?? '/profile';
}
