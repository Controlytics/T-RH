import { prisma } from '../../lib/prisma.js';
import { normalizeLayout, resolveLayout, type DashboardLayout } from '@digilog/shared';
import { resolvePanelsFor } from './panel-access.js';
import { PANEL_KEYS } from '@digilog/shared';

/**
 * Where this user's dashboard panels sit.
 *
 * Resolved once, server-side, and shipped on `/api/config/my-config` beside
 * `panels`. The browser arranges what it is given and never re-derives the
 * user → role → built-in fallback.
 *
 * **Layout is a PREFERENCE and grants nothing.** It is narrowed by panel
 * assignment — which IS governance — so this reads the panels through the same
 * `resolvePanelsFor` the rest of the system uses. Two answers to "what may this
 * user see" would eventually disagree, and the layout would be the one showing
 * something it should not.
 */
export async function resolveLayoutFor(username: string): Promise<DashboardLayout> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, role: true },
  });

  const panels = await resolvePanelsFor(username);
  // `null` from the resolver means "every panel"; the layout resolver wants the
  // concrete list, since it has to place each one.
  const visible = panels ?? [...PANEL_KEYS];

  if (!user) return resolveLayout(undefined, undefined, visible);

  const [userCfg, roleCfg] = await Promise.all([
    prisma.userConfig.findUnique({ where: { userId: user.id }, select: { dashboardLayout: true } }),
    prisma.roleConfig.findUnique({ where: { role: user.role }, select: { dashboardLayout: true } }),
  ]);

  return resolveLayout(
    normalizeLayout(userCfg?.dashboardLayout),
    normalizeLayout(roleCfg?.dashboardLayout),
    visible,
  );
}
