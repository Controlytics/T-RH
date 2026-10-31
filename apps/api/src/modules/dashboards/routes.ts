import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  parseDashboardDocument, readDashboardDocument, emptyDashboardDocument, diffWidgets,
  widgetItemId, widgetIdOf,
  type DashboardDocument, type StoredDashboardDocument, type CustomWidget,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { stripHtml } from '../../lib/sanitize.js';
import { cleanWidgetText } from '../../lib/widget-text.js';
import {
  idParams, listResponse, detailResponse, createdResponse, assignmentsResponse, deleteResponse,
  createDashboardBody, updateDashboardBody, assignmentsBody, DASHBOARD_TITLE_MAX, DASHBOARD_DESCRIPTION_MAX,
} from './schemas.js';
import {
  DASHBOARDS_SUPER_ADMIN_ONLY, DASHBOARD_CHANGED_MESSAGE, DASHBOARD_NOT_FOUND_MESSAGE,
  visibleDashboardWhere, findVisibleDashboard, presentDashboards, presentDetail, readAssignments, byTitle,
  who, meaning, dashboardCreatedValue, dashboardStateValue, widgetValue, assigneeValue, assigneeText,
  type Assignee,
} from './service.js';

/**
 * `/api/dashboards` — the server behind the dashboard builder (phase 1,
 * 2026-10-29; spec docs/superpowers/specs/2026-10-29-dashboard-builder-design.md
 * §5, §6.1). Rewritten from the parked DigiLog widget-dashboard module.
 *
 * - **A dashboard is ONE document** in `dashboards.layout`:
 *   `{ version, source, timeWindow, items, widgets }`. A save sends the whole
 *   document, strictly parsed (`parseDashboardDocument`); a read is forgiving
 *   (`readDashboardDocument`), so one bad widget never blanks a dashboard. The
 *   per-widget routes, `PUT /:id/layout`, `POST /:id/assign`, the assignment
 *   DELETE, `GET /:id/data/:widgetId` and `GET /widget-types` are GONE, and the
 *   `dashboard_widgets` table is left in place, unused (spec §12 question 1).
 * - **Seeing** a dashboard needs DASHBOARD_VIEW + an active row + an assignment
 *   to the caller or their role (`visibleDashboardWhere`, the ONE rule). A
 *   SUPER_ADMIN sees every active one; ADMIN is not special; no assignment means
 *   none. Anything not visible is a 404, never a 403. A dashboard grants
 *   nothing: its widgets read the instrument routes under the viewer's own scope.
 * - **Writing** is SUPER_ADMIN only, checked by ROLE before anything else, so a
 *   stale DASHBOARD_CREATE / MANAGE / ASSIGN grant (still possible on AWS) opens
 *   nothing. Those permission constants stay defined; no route reads them.
 * - **Every write, in this order:** the role (403) → the row exists and is
 *   active (404) → `enforceReauth('UPDATE_DASHBOARD')` → validation (400) → ONE
 *   transaction holding the write and all its audit rows.
 * - **Two editors:** `PUT /:id` carries the `updatedAt` the editor loaded and
 *   the update is conditional on it; a stale save is a 409 that writes nothing.
 * - `isDefault`, `isActive` and `createdBy` keep their columns; `isDefault` is
 *   neither exposed nor writable.
 */
const REAUTH_ACTION = 'UPDATE_DASHBOARD';
const COPY_SUFFIX = ' (copy)';
/** Up to 550 hash-chained audit inserts (an assignment replace) must not hit Prisma's 5 s default. */
const WRITE_TX = { timeout: 30_000 } as const;

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'DASHBOARD_NOT_FOUND', message: DASHBOARD_NOT_FOUND_MESSAGE });
const invalid = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: 'VALIDATION_ERROR', message });

/**
 * Step 1 of every write, as a `preValidation` hook so it runs BEFORE the path
 * and the body are validated: a non-SUPER_ADMIN is a 403 whatever they sent,
 * never a 400 or a 404. `req.user` is set by the global `onRequest` auth hook.
 */
async function superAdminOnly(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role === 'SUPER_ADMIN') return;
  return reply.code(403).send({ error: 'DASHBOARDS_SUPER_ADMIN_ONLY', message: DASHBOARDS_SUPER_ADMIN_ONLY });
}

/** HTML stripped and trimmed, as on every text field; null when nothing is left. */
function cleanTitle(v: string): string | null {
  const t = stripHtml(v).slice(0, DASHBOARD_TITLE_MAX).trim();
  return t.length > 0 ? t : null;
}
function cleanDescription(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  // Cut AFTER stripping: stripHtml's fail-safe escapes, which can lengthen the
  // text past the VARCHAR(500) column (a P2000, i.e. a 500).
  const t = stripHtml(v).slice(0, DASHBOARD_DESCRIPTION_MAX).trim();
  return t.length > 0 ? t : null;
}

/** `<title> (copy)`, within the column, the suffix always kept. */
function copyTitle(title: string): string {
  if (title.length + COPY_SUFFIX.length <= DASHBOARD_TITLE_MAX) return `${title}${COPY_SUFFIX}`;
  return `${title.slice(0, DASHBOARD_TITLE_MAX - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
}

/**
 * Whether two documents have the same source, window and placement. Both sides
 * come out of the same zod / `readItem` path (the strict parse, and the
 * forgiving read of the stored row), so their keys are in the same order and
 * JSON comparison is exact. The WIDGETS are compared separately, by id
 * (`diffWidgets`): the order of the widget list means nothing — the items
 * place the widgets — and nothing audits it.
 */
function sameLayout(a: StoredDashboardDocument, b: StoredDashboardDocument): boolean {
  return JSON.stringify(a.source) === JSON.stringify(b.source)
    && JSON.stringify(a.timeWindow) === JSON.stringify(b.timeWindow)
    && JSON.stringify(a.items) === JSON.stringify(b.items);
}

const asJson = (d: StoredDashboardDocument) => d as unknown as Prisma.InputJsonValue;

export default async function dashboardRoutes(app: FastifyInstance) {
  /** One WIDGET_* row per widget added; used by create, duplicate and save. */
  async function auditWidgetsCreated(tx: Prisma.TransactionClient, req: FastifyRequest, dashboardId: string, title: string, widgets: readonly CustomWidget[]) {
    for (const w of widgets) {
      await auditLog({
        ...who(req), action: 'DASHBOARD_WIDGET_CREATED', targetType: 'dashboard', targetId: dashboardId,
        afterValue: widgetValue(w, title),
        signatureMeaning: meaning(`Widget "${w.title}" added to dashboard "${title}"`),
      }, tx);
    }
  }

  // ─── LIST ──────────────────────────────────────────────
  app.get('/', {
    preHandler: [app.requirePermission('DASHBOARD_VIEW')],
    schema: {
      tags: ['Dashboards'],
      summary: 'The dashboards the caller may see',
      description: 'Active dashboards assigned to the caller or their role (a SUPER_ADMIN sees every active one), ordered by title ignoring case. No paging. `assignments` is sent to a SUPER_ADMIN only.',
      response: listResponse,
    },
  }, async (req) => {
    const rows = await prisma.dashboard.findMany({
      where: visibleDashboardWhere(req.user),
      select: { id: true, title: true, description: true, layout: true, updatedAt: true },
    });
    rows.sort(byTitle);
    const presented = await presentDashboards(rows, req.user.role === 'SUPER_ADMIN');
    return { data: presented.map((p) => p.summary) };
  });

  // ─── ONE ───────────────────────────────────────────────
  app.get('/:id', {
    preHandler: [app.requirePermission('DASHBOARD_VIEW')],
    schema: {
      tags: ['Dashboards'],
      summary: 'One dashboard with its document',
      description: 'The stored document, read forgivingly: a bad widget is dropped with its item, a bad window reads as the default, a bad source reads as null. 404 when the caller may not see it.',
      params: idParams,
      response: detailResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await findVisibleDashboard(req.user, id);
    if (!row) return notFound(reply);
    return presentDetail(row, req.user.role === 'SUPER_ADMIN');
  });

  // ─── CREATE ────────────────────────────────────────────
  app.post('/', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Dashboards'],
      summary: 'Create a dashboard (SUPER_ADMIN)',
      description: 'Without a `document`: no widgets, every instrument, the last 24 hours. Re-auth action UPDATE_DASHBOARD.',
      body: createDashboardBody,
      response: createdResponse,
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const body = req.body as { title: string; description?: string | null; document?: unknown };
    const title = cleanTitle(body.title);
    if (!title) return invalid(reply, 'A dashboard needs a title.');
    const description = cleanDescription(body.description) ?? null;
    let document: DashboardDocument = emptyDashboardDocument();
    if (body.document !== undefined) {
      const parsed = parseDashboardDocument(body.document);
      if (!parsed.ok) return invalid(reply, parsed.message);
      const cleaned = cleanWidgetText(parsed.document.widgets, undefined);
      if (!cleaned.ok) return invalid(reply, cleaned.message);
      document = { ...parsed.document, widgets: cleaned.widgets };
    }

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.dashboard.create({
        data: { title, description, layout: asJson(document), createdBy: req.user.sub },
      });
      await auditLog({
        ...who(req), action: 'DASHBOARD_CREATED', targetType: 'dashboard', targetId: created.id,
        afterValue: dashboardCreatedValue(title, description, document),
        signatureMeaning: meaning(`Dashboard "${title}" created`),
      }, tx);
      await auditWidgetsCreated(tx, req, created.id, title, document.widgets);
      return created;
    }, WRITE_TX);
    return reply.code(201).send(await presentDetail(row, true));
  });

  // ─── DUPLICATE ─────────────────────────────────────────
  app.post('/:id/duplicate', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Dashboards'],
      summary: 'Copy a dashboard (SUPER_ADMIN)',
      description: 'Titled "<title> (copy)". Every widget gets a new id and its item is re-pointed. Assignments are NOT copied. Re-auth action UPDATE_DASHBOARD.',
      params: idParams,
      response: createdResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await findVisibleDashboard(req.user, id))) return notFound(reply);
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;

    const row = await prisma.$transaction(async (tx) => {
      const source = await findVisibleDashboard(req.user, id, tx);
      if (!source) return null;
      const was = readDashboardDocument(source.layout);
      const newIds = new Map(was.widgets.map((w) => [w.id, randomUUID()]));
      const copy: StoredDashboardDocument = {
        ...was,
        widgets: was.widgets.map((w) => ({ ...w, id: newIds.get(w.id)! })),
        items: was.items.map((it) => {
          const old = widgetIdOf(it.i);
          return old && newIds.has(old) ? { ...it, i: widgetItemId(newIds.get(old)!) } : it;
        }),
      };
      const title = copyTitle(source.title);
      const created = await tx.dashboard.create({
        data: { title, description: source.description, layout: asJson(copy), createdBy: req.user.sub },
      });
      await auditLog({
        ...who(req), action: 'DASHBOARD_CREATED', targetType: 'dashboard', targetId: created.id,
        afterValue: { ...dashboardCreatedValue(title, source.description, copy), duplicatedFrom: { id: source.id, name: source.title } },
        signatureMeaning: meaning(`Dashboard "${title}" created as a copy of "${source.title}"`),
      }, tx);
      await auditWidgetsCreated(tx, req, created.id, title, copy.widgets);
      return created;
    }, WRITE_TX);
    if (!row) return notFound(reply);
    return reply.code(201).send(await presentDetail(row, true));
  });

  // ─── SAVE ──────────────────────────────────────────────
  app.put('/:id', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Dashboards'],
      summary: 'Save a dashboard (SUPER_ADMIN)',
      description: 'Any of title, description and the WHOLE document, plus the `updatedAt` the editor loaded. A save against a dashboard changed since is 409 DASHBOARD_CHANGED and writes nothing; a save that changes nothing writes nothing and audits nothing. Re-auth action UPDATE_DASHBOARD.',
      params: idParams,
      body: updateDashboardBody,
      response: detailResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await findVisibleDashboard(req.user, id);
    if (!current) return notFound(reply);
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;

    const body = req.body as { title?: string; description?: string | null; document?: unknown; expectedUpdatedAt: string };
    let title: string | undefined;
    if (body.title !== undefined) {
      const t = cleanTitle(body.title);
      if (!t) return invalid(reply, 'A dashboard needs a title.');
      title = t;
    }
    const description = cleanDescription(body.description);
    let document: DashboardDocument | undefined;
    if (body.document !== undefined) {
      const parsed = parseDashboardDocument(body.document);
      if (!parsed.ok) return invalid(reply, parsed.message);
      // Compared with the widgets of the row just read: a widget sent back as
      // stored is kept as stored, so it is neither rewritten nor audited. A row
      // another save moved on since is a 409 below whatever this decides.
      const cleaned = cleanWidgetText(parsed.document.widgets, readDashboardDocument(current.layout).widgets);
      if (!cleaned.ok) return invalid(reply, cleaned.message);
      document = { ...parsed.document, widgets: cleaned.widgets };
    }
    const expected = new Date(body.expectedUpdatedAt);

    const outcome = await prisma.$transaction(async (tx) => {
      const cur = await findVisibleDashboard(req.user, id, tx);
      if (!cur) return { kind: 'gone' } as const;
      const was = readDashboardDocument(cur.layout);
      const nextTitle = title ?? cur.title;
      const nextDescription = description === undefined ? cur.description : description;
      const next: StoredDashboardDocument = document ?? was;

      // "Changed" is decided by what gets AUDITED, computed before anything is
      // written: a save that would write no audit row writes nothing (a
      // committed change with no record is the failure; so is an honest second
      // save turned into a 409 by a write that changed nothing). The widgets are
      // diffed by id, so a reordered widget list is no change.
      const before = dashboardStateValue(cur.title, cur.description, was);
      const after = dashboardStateValue(nextTitle, nextDescription, next);
      const stateChanged = JSON.stringify(before) !== JSON.stringify(after);
      const diff = document ? diffWidgets(was.widgets, document.widgets) : { created: [], updated: [], deleted: [] };
      const widgetsChanged = diff.created.length + diff.updated.length + diff.deleted.length > 0;
      if (!stateChanged && !widgetsChanged) return { kind: 'unchanged', detail: await presentDetail(cur, true, tx) } as const;
      const layoutChanged = document !== undefined && (widgetsChanged || !sameLayout(was, document));

      // Conditional on the version the editor loaded: a row another save moved
      // on matches nothing, and nothing below runs. The window is the editor's
      // millisecond (GET serialises milliseconds; the column holds
      // microseconds), so a stamp written by anything other than Prisma still
      // matches its own reading. The new stamp is always past that window, so
      // two saves inside one millisecond still leave the second editor stale.
      const { count } = await tx.dashboard.updateMany({
        where: { id, isActive: true, updatedAt: { gte: expected, lt: new Date(expected.getTime() + 1) } },
        data: {
          title: nextTitle,
          description: nextDescription,
          ...(layoutChanged ? { layout: asJson(next) } : {}),
          updatedAt: new Date(Math.max(Date.now(), expected.getTime() + 1)),
        },
      });
      if (count === 0) return { kind: 'conflict' } as const;

      const ctx = who(req);
      if (stateChanged) {
        await auditLog({
          ...ctx, action: 'DASHBOARD_UPDATED', targetType: 'dashboard', targetId: id,
          beforeValue: before, afterValue: after,
          signatureMeaning: meaning(`Dashboard "${nextTitle}" updated`),
        }, tx);
      }
      await auditWidgetsCreated(tx, req, id, nextTitle, diff.created);
      for (const u of diff.updated) {
        await auditLog({
          ...ctx, action: 'DASHBOARD_WIDGET_UPDATED', targetType: 'dashboard', targetId: id,
          beforeValue: widgetValue(u.before, cur.title), afterValue: widgetValue(u.after, nextTitle),
          signatureMeaning: meaning(`Widget "${u.after.title}" updated on dashboard "${nextTitle}"`),
        }, tx);
      }
      for (const w of diff.deleted) {
        await auditLog({
          ...ctx, action: 'DASHBOARD_WIDGET_DELETED', targetType: 'dashboard', targetId: id,
          beforeValue: widgetValue(w, cur.title),
          signatureMeaning: meaning(`Widget "${w.title}" removed from dashboard "${nextTitle}"`),
        }, tx);
      }
      // The response is the version THIS save wrote, read inside its own
      // transaction: a save landing after the commit must not be handed back as ours.
      const saved = await tx.dashboard.findUniqueOrThrow({ where: { id } });
      return { kind: 'saved', detail: await presentDetail(saved, true, tx) } as const;
    }, WRITE_TX);

    if (outcome.kind === 'gone') return notFound(reply);
    if (outcome.kind === 'conflict') return reply.code(409).send({ error: 'DASHBOARD_CHANGED', message: DASHBOARD_CHANGED_MESSAGE });
    return outcome.detail;
  });

  // ─── DELETE ────────────────────────────────────────────
  app.delete('/:id', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Dashboards'],
      summary: 'Delete a dashboard (SUPER_ADMIN)',
      description: 'A soft delete: the row stays, inactive, and is gone from every read. Re-auth action UPDATE_DASHBOARD.',
      params: idParams,
      response: deleteResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await findVisibleDashboard(req.user, id))) return notFound(reply);
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;

    const deleted = await prisma.$transaction(async (tx) => {
      const cur = await findVisibleDashboard(req.user, id, tx);
      if (!cur) return false;
      // Conditional, so two deletes racing write ONE audit row between them.
      const { count } = await tx.dashboard.updateMany({ where: { id, isActive: true }, data: { isActive: false } });
      if (count === 0) return false;
      await auditLog({
        ...who(req), action: 'DASHBOARD_DELETED', targetType: 'dashboard', targetId: id,
        beforeValue: dashboardStateValue(cur.title, cur.description, readDashboardDocument(cur.layout)),
        signatureMeaning: meaning(`Dashboard "${cur.title}" deleted`),
      }, tx);
      return true;
    }, WRITE_TX);
    if (!deleted) return notFound(reply);
    return { success: true };
  });

  // ─── ASSIGNMENTS ───────────────────────────────────────
  app.put('/:id/assignments', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Dashboards'],
      summary: 'Replace who a dashboard is assigned to (SUPER_ADMIN)',
      description: 'The WHOLE set of roles and users. An unknown role or user is a 400 naming the first one. Only the difference is written, one DASHBOARD_ASSIGNED / UNASSIGNED row per role or user. Re-auth action UPDATE_DASHBOARD.',
      params: idParams,
      body: assignmentsBody,
      response: assignmentsResponse,
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await findVisibleDashboard(req.user, id))) return notFound(reply);
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;

    const { roles, userIds } = req.body as { roles: string[]; userIds: string[] };
    const [knownRoles, knownUsers] = await Promise.all([
      roles.length ? prisma.role.findMany({ where: { name: { in: roles } }, select: { name: true } }) : Promise.resolve([]),
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : Promise.resolve([]),
    ]);
    const roleSet = new Set(knownRoles.map((r) => r.name));
    const unknownRole = roles.find((r) => !roleSet.has(r));
    if (unknownRole !== undefined) return invalid(reply, `Unknown role "${unknownRole}".`);
    const usernames = new Map(knownUsers.map((u) => [u.id, u.username]));
    const unknownUser = userIds.find((u) => !usernames.has(u));
    if (unknownUser !== undefined) return invalid(reply, `Unknown user ${unknownUser}.`);

    const done = await prisma.$transaction(async (tx) => {
      // Row lock: two replaces of one set must not both insert the same
      // assignment (the table has no unique key) or both audit it.
      const locked = await tx.$queryRaw<{ title: string }[]>`
        SELECT title FROM dashboards WHERE id = ${id}::uuid AND is_active FOR UPDATE`;
      if (locked.length === 0) return false;
      const title = locked[0].title;
      const stored = await tx.dashboardAssignment.findMany({
        where: { dashboardId: id },
        select: { id: true, assigneeType: true, userId: true, roleValue: true },
      });
      const wantRoles = new Set(roles);
      const wantUsers = new Set(userIds);
      const haveRoles = new Set(stored.flatMap((a) => (a.assigneeType === 'ROLE' && a.roleValue ? [a.roleValue] : [])));
      const haveUsers = new Set(stored.flatMap((a) => (a.assigneeType === 'USER' && a.userId ? [a.userId] : [])));
      const dropped = stored.filter((a) => (a.assigneeType === 'ROLE'
        ? !a.roleValue || !wantRoles.has(a.roleValue)
        : !a.userId || !wantUsers.has(a.userId)));
      const addRoles = roles.filter((r) => !haveRoles.has(r));
      const addUsers = userIds.filter((u) => !haveUsers.has(u));
      if (dropped.length === 0 && addRoles.length === 0 && addUsers.length === 0) return true;

      // A removed user may no longer exist (no foreign key): name it if we can.
      const droppedUserIds = dropped.flatMap((a) => (a.assigneeType === 'USER' && a.userId ? [a.userId] : []));
      const droppedNames = new Map((droppedUserIds.length
        ? await tx.user.findMany({ where: { id: { in: droppedUserIds } }, select: { id: true, username: true } })
        : []).map((u) => [u.id, u.username]));

      if (dropped.length) await tx.dashboardAssignment.deleteMany({ where: { id: { in: dropped.map((a) => a.id) } } });
      if (addRoles.length || addUsers.length) {
        await tx.dashboardAssignment.createMany({
          data: [
            ...addRoles.map((roleValue) => ({ dashboardId: id, assigneeType: 'ROLE' as const, roleValue })),
            ...addUsers.map((userId) => ({ dashboardId: id, assigneeType: 'USER' as const, userId })),
          ],
        });
      }

      const ctx = who(req);
      const added: Assignee[] = [
        ...addRoles.map((role): Assignee => ({ type: 'ROLE', role })),
        ...addUsers.map((userId): Assignee => ({ type: 'USER', userId, username: usernames.get(userId) ?? null })),
      ];
      // One row per role or user, even if the parked module stored one twice.
      const removed = [...new Map(dropped.map((a): [string, Assignee] => (a.assigneeType === 'ROLE'
        ? [`ROLE:${a.roleValue}`, { type: 'ROLE', role: a.roleValue ?? '' }]
        : [`USER:${a.userId}`, { type: 'USER', userId: a.userId ?? '', username: (a.userId && droppedNames.get(a.userId)) || null }]))).values()];
      for (const a of added) {
        await auditLog({
          ...ctx, action: 'DASHBOARD_ASSIGNED', targetType: 'dashboard', targetId: id,
          afterValue: assigneeValue(title, a),
          signatureMeaning: meaning(`Dashboard "${title}" assigned to ${assigneeText(a)}`),
        }, tx);
      }
      for (const a of removed) {
        await auditLog({
          ...ctx, action: 'DASHBOARD_UNASSIGNED', targetType: 'dashboard', targetId: id,
          beforeValue: assigneeValue(title, a),
          signatureMeaning: meaning(`Dashboard "${title}" no longer assigned to ${assigneeText(a)}`),
        }, tx);
      }
      return true;
    }, WRITE_TX);
    if (!done) return notFound(reply);
    return (await readAssignments([id])).get(id)!;
  });
}
