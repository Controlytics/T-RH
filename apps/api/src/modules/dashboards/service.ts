/**
 * The rules behind `/api/dashboards` (dashboard builder phase 1, 2026-10-29;
 * spec docs/superpowers/specs/2026-10-29-dashboard-builder-design.md §5, §6.1).
 *
 * - `visibleDashboardWhere` is THE rule for which dashboards a caller may see.
 *   The list, `GET /:id` and every write's 404 test all go through it, so the
 *   list and the detail cannot disagree again (audit 2026-10-12 finding 10).
 * - Source summaries are read in two batched queries, never one per row.
 * - Audit values are built here so every row names what it is about: the
 *   Audit Trail renders `{targetName}` from `name`, and a blank one is an
 *   anti-goal of the spec.
 */
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  readDashboardDocument,
  type CustomWidget, type DashboardSource, type DashboardSourceSummary, type DashboardSummary,
  type DashboardDetail, type StoredDashboardDocument,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const DASHBOARDS_SUPER_ADMIN_ONLY = 'Only a super admin can create, change, assign or delete dashboards.';
export const DASHBOARD_CHANGED_MESSAGE = 'This dashboard was changed by someone else. Reload it and make your change again.';
export const DASHBOARD_NOT_FOUND_MESSAGE = 'Dashboard not found.';

/** `audit_trail.signature_meaning` is VARCHAR(255) and the insert is raw SQL: a longer one is a 500. */
export const SIGNATURE_MEANING_MAX = 255;

/** Every signature meaning this module writes goes through here. */
export function meaning(text: string): string {
  return text.length <= SIGNATURE_MEANING_MAX ? text : `${text.slice(0, SIGNATURE_MEANING_MAX - 1)}…`;
}

// ─── visibility ──────────────────────────────────────────────────────────────

/**
 * Active only. A SUPER_ADMIN sees every active dashboard. Everyone else sees
 * the ones assigned to them or to their role — and with no assignment, NONE.
 * ADMIN is not special. (The parked module let ADMIN see all, and let anyone
 * with no assignment see every active dashboard; both are gone on purpose.)
 * `DASHBOARD_VIEW` is the route's own preHandler, not part of this rule.
 */
export function visibleDashboardWhere(user: { sub: string; role: string }): Prisma.DashboardWhereInput {
  if (user.role === 'SUPER_ADMIN') return { isActive: true };
  return {
    isActive: true,
    assignments: {
      some: {
        OR: [
          { assigneeType: 'USER', userId: user.sub },
          { assigneeType: 'ROLE', roleValue: user.role },
        ],
      },
    },
  };
}

/** The dashboard if the caller may see it, else null (the route answers 404, never 403). */
export function findVisibleDashboard(user: { sub: string; role: string }, id: string, db: Db = prisma) {
  return db.dashboard.findFirst({ where: { AND: [visibleDashboardWhere(user), { id }] } });
}

// ─── source summaries ────────────────────────────────────────────────────────

/** What the list and the page header say a dashboard covers, one entry per source, in order. */
export async function summariseSources(sources: readonly (DashboardSource | null)[], db: Db = prisma): Promise<DashboardSourceSummary[]> {
  const profileIds = [...new Set(sources.flatMap((s) => (s?.mode === 'profile' ? [s.profileId] : [])))];
  const locationIds = [...new Set(sources.flatMap((s) => (s?.mode === 'location' ? [s.functionalLocationId] : [])))];
  const [profiles, locations] = await Promise.all([
    profileIds.length
      ? db.instrumentProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    locationIds.length
      ? db.functionalLocation.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const profileName = new Map(profiles.map((p) => [p.id, p.name]));
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  return sources.map((s): DashboardSourceSummary => {
    // Plan ruling D4: an unreadable stored source shows no instruments and says
    // so. It never reads as "All instruments".
    if (s === null) return { mode: 'unreadable', label: 'Instruments could not be read' };
    switch (s.mode) {
      case 'all':
        return { mode: 'all', label: 'All instruments' };
      case 'profile':
        return { mode: 'profile', label: profileName.get(s.profileId) ?? 'Profile no longer exists' };
      case 'location': {
        const name = locationName.get(s.functionalLocationId);
        return { mode: 'location', label: name === undefined ? 'Location no longer exists' : `${name}${s.directOnly ? ' (direct only)' : ''}` };
      }
      case 'instruments':
        return { mode: 'instruments', label: `${s.ids.length} instruments` };
    }
  });
}

// ─── assignments ─────────────────────────────────────────────────────────────

export type Assignments = NonNullable<DashboardSummary['assignments']>;

/**
 * Who each dashboard is assigned to, for a SUPER_ADMIN's eyes. Only roles and
 * users that still EXIST are listed: neither assignment column has a foreign
 * key and both tables are hard-deleted, and a name the editor cannot pick again
 * would make its next save a 400. The replace in `PUT /:id/assignments` diffs
 * against every stored row, so a dangling one is removed (and audited) by the
 * next save rather than lingering.
 */
export async function readAssignments(dashboardIds: readonly string[], db: Db = prisma): Promise<Map<string, Assignments>> {
  const out = new Map<string, Assignments>(dashboardIds.map((id) => [id, { roles: [], users: [] }]));
  if (dashboardIds.length === 0) return out;
  const rows = await db.dashboardAssignment.findMany({
    where: { dashboardId: { in: [...dashboardIds] } },
    select: { dashboardId: true, assigneeType: true, userId: true, roleValue: true },
  });
  const roleNames = [...new Set(rows.flatMap((r) => (r.assigneeType === 'ROLE' && r.roleValue ? [r.roleValue] : [])))];
  const userIds = [...new Set(rows.flatMap((r) => (r.assigneeType === 'USER' && r.userId ? [r.userId] : [])))];
  const [roles, users] = await Promise.all([
    roleNames.length ? db.role.findMany({ where: { name: { in: roleNames } }, select: { name: true } }) : Promise.resolve([]),
    userIds.length
      ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, fullName: true } })
      : Promise.resolve([]),
  ]);
  const knownRoles = new Set(roles.map((r) => r.name));
  const knownUsers = new Map(users.map((u) => [u.id, u]));
  for (const r of rows) {
    const a = out.get(r.dashboardId)!;
    if (r.assigneeType === 'ROLE' && r.roleValue && knownRoles.has(r.roleValue) && !a.roles.includes(r.roleValue)) a.roles.push(r.roleValue);
    if (r.assigneeType === 'USER' && r.userId && knownUsers.has(r.userId) && !a.users.some((u) => u.id === r.userId)) {
      const u = knownUsers.get(r.userId)!;
      a.users.push({ id: u.id, username: u.username, fullName: u.fullName });
    }
  }
  for (const a of out.values()) {
    a.roles.sort((x, y) => x.localeCompare(y));
    a.users.sort((x, y) => x.username.localeCompare(y.username));
  }
  return out;
}

// ─── presentation ────────────────────────────────────────────────────────────

type DashboardRow = { id: string; title: string; description: string | null; layout: unknown; updatedAt: Date };

/** Case-insensitive (`accent`: A = a, a ≠ á), then by id so equal titles keep a stable order. */
export function byTitle(a: { title: string; id: string }, b: { title: string; id: string }): number {
  return a.title.localeCompare(b.title, 'en', { sensitivity: 'accent' }) || a.id.localeCompare(b.id);
}

/**
 * The wire shape of one or more rows. `assignments` is attached only when the
 * caller is a SUPER_ADMIN — for anyone else the key is ABSENT, not null.
 */
export async function presentDashboards(
  rows: readonly DashboardRow[],
  isSuperAdmin: boolean,
  db: Db = prisma,
): Promise<{ summary: DashboardSummary; document: StoredDashboardDocument }[]> {
  const documents = rows.map((r) => readDashboardDocument(r.layout));
  const [summaries, assignments] = await Promise.all([
    summariseSources(documents.map((d) => d.source), db),
    isSuperAdmin ? readAssignments(rows.map((r) => r.id), db) : Promise.resolve(null),
  ]);
  return rows.map((r, n) => ({
    document: documents[n],
    summary: {
      id: r.id,
      title: r.title,
      description: r.description,
      sourceSummary: summaries[n],
      widgetCount: documents[n].widgets.length,
      updatedAt: r.updatedAt.toISOString(),
      ...(assignments ? { assignments: assignments.get(r.id)! } : {}),
    },
  }));
}

export async function presentDetail(row: DashboardRow, isSuperAdmin: boolean, db: Db = prisma): Promise<DashboardDetail> {
  const [one] = await presentDashboards([row], isSuperAdmin, db);
  return { ...one.summary, document: one.document };
}

// ─── audit ───────────────────────────────────────────────────────────────────

/** Who, on every audit row this module writes. */
export const who = (req: FastifyRequest) => ({
  userId: req.user.username, userRole: req.user.role,
  ipAddress: req.ip, userAgent: req.headers['user-agent'], sessionId: req.user.sessionId,
});

/** A dashboard on a CREATED / DELETED row. */
export const dashboardCreatedValue = (title: string, description: string | null, doc: StoredDashboardDocument) =>
  ({ name: title, description, source: doc.source, widgetCount: doc.widgets.length });

/** A dashboard on an UPDATED / DELETED row: everything a save can change except the widgets' own content. */
export const dashboardStateValue = (title: string, description: string | null, doc: StoredDashboardDocument) =>
  ({ name: title, description, source: doc.source, timeWindow: doc.timeWindow, widgetCount: doc.widgets.length, items: doc.items });

/** A widget row: `name` is the WIDGET's title; the dashboard is named in the details. */
export const widgetValue = (w: CustomWidget, dashboardTitle: string) => ({ name: w.title, dashboard: dashboardTitle, widget: w });

export type Assignee = { type: 'ROLE'; role: string } | { type: 'USER'; userId: string; username: string | null };

export const assigneeValue = (dashboardTitle: string, assignee: Assignee) => ({ name: dashboardTitle, assignee });

export const assigneeText = (a: Assignee) => (a.type === 'ROLE' ? `role ${a.role}` : `user ${a.username ?? a.userId}`);
