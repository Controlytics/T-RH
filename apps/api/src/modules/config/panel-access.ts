import { prisma } from '../../lib/prisma.js';
import { normalizePanels, resolvePanels } from '@digilog/shared';

/**
 * Which panels a user may see.
 *
 * The rule is resolved ONCE, here, and shipped on `/api/config/my-config`. The
 * browser applies the resulting list to its layout but never re-derives the
 * inherit/none/these resolution — that is a policy decision, and this repo has
 * been bitten before by a client that recomputed one and drifted from the server.
 *
 * Note the deliberate difference from `configService.getMyConfig`, which decides
 * whether a user config wins by testing `sidebarItems.length > 0`. An empty panel
 * list means NO PANELS and must not fall through to the role. Do not unify these
 * two rules: the sidebar's version is already recorded as the wrong direction to
 * fail in (see `modules/instruments/visibility.ts:effectiveScope`).
 *
 * A hidden panel is a DISPLAY decision, NOT an access control — it does not stop
 * the data being fetched. `instrument_scope` is what restricts data.
 */

/** The pure half: no database, so the rule itself is testable in isolation. */
export function pickPanels(
  userRole: string,
  storedRole: unknown,
  storedUser: unknown,
): string[] | null {
  return resolvePanels(userRole, normalizePanels(storedRole), normalizePanels(storedUser));
}

/** `null` = every panel. */
export async function resolvePanelsFor(username: string): Promise<string[] | null> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, role: true },
  });
  // An unknown username resolves to "every panel" rather than "none": this runs on
  // an authenticated route, so it cannot happen, and blanking the screen would be a
  // worse way to surface it than the 401 that already would have.
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') return null;

  const [userCfg, roleCfg] = await Promise.all([
    prisma.userConfig.findUnique({ where: { userId: user.id }, select: { dashboardCards: true } }),
    prisma.roleConfig.findUnique({ where: { role: user.role }, select: { dashboardCards: true } }),
  ]);
  return pickPanels(user.role, roleCfg?.dashboardCards, userCfg?.dashboardCards);
}
