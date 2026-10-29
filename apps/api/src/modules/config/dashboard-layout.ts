import { prisma } from '../../lib/prisma.js';
import {
  normalizeLayout, parseLayoutForWrite, resolveLayout, widgetsEqual, type DashboardLayout,
} from '@digilog/shared';
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
    // Whose built widgets a viewer sees depends on who they are: see
    // resolveLayout's comment (a non-super-admin's own layout takes the role's).
    { viewerIsSuperAdmin: user.role === 'SUPER_ADMIN' },
  );
}

/**
 * `layout.widgets` in a route schema. The inner shape is validated by zod
 * (`customWidgetSchema`), not here: a nested object declared without its
 * properties serialises to `{}`, so this says "pass every key" instead of
 * enumerating a shape that would have to be kept in step by hand.
 */
export const WIDGETS_JSON_SCHEMA = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
} as const;

export const WIDGETS_SUPER_ADMIN_ONLY = 'Only a super admin can add, change or remove dashboard widgets.';

/**
 * The ONE write rule for both layout routes (the caller's own, and a role's
 * default), so the two cannot drift.
 *
 * `stored` is the row being OVERWRITTEN. An omitted `widgets` key keeps its
 * widgets; anything else that changes them is refused unless the caller is a
 * SUPER_ADMIN (operator 2026-10-28: "super admin only"). The screen hiding the
 * controls is presentation; this is the control.
 *
 * `layout === null` (the role route's "clear") is a widget change when the
 * stored row has any.
 */
export function checkLayoutWrite(
  layout: unknown,
  stored: unknown,
  callerRole: string,
):
  | { ok: true; layout: DashboardLayout | null }
  | { ok: false; status: 400 | 403; error: 'VALIDATION_ERROR' | 'WIDGETS_SUPER_ADMIN_ONLY'; message: string } {
  const storedWidgets = normalizeLayout(stored)?.widgets;
  let next: DashboardLayout | null = null;
  if (layout !== null) {
    const parsed = parseLayoutForWrite(layout, storedWidgets);
    if (!parsed.ok) return { ok: false, status: 400, error: 'VALIDATION_ERROR', message: parsed.message };
    next = parsed.layout;
  }
  if (callerRole !== 'SUPER_ADMIN' && !widgetsEqual(next?.widgets, storedWidgets)) {
    return { ok: false, status: 403, error: 'WIDGETS_SUPER_ADMIN_ONLY', message: WIDGETS_SUPER_ADMIN_ONLY };
  }
  return { ok: true, layout: next };
}
