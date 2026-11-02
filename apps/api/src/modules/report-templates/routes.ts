import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { WIDGET_TYPES, type WidgetType } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { buildContext } from '../../lib/build-context.js';
import { parseUuidList } from '../../lib/uuid-list.js';
import { resolveVisibility, withVisibility } from '../instruments/visibility.js';
import { buildReportCatalogue } from './catalogue.js';
import {
  REAUTH_ACTION, REPORT_TEMPLATES_SUPER_ADMIN_ONLY, TEMPLATE_NOT_FOUND_MESSAGE, PROFILE_NOT_FOUND_MESSAGE,
  isWidgetType, nameInUseMessage, presentTemplate, byName, parseCreate, parseUpdate, uniqueViolation,
  lockProfile, clearDefaults, templateAuditValue, meaning, who, findTemplate,
  type ReportTemplateRow, type Refusal,
} from './service.js';

/**
 * `/api/report-templates` — what a dashboard widget's "Download report"
 * prints, per instrument PROFILE per widget TYPE (2026-11-02; spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §5–§10, §12).
 *
 * - **Reading** needs INSTRUMENT_READ and nothing more: the download needs the
 *   list, the catalogue and `resolve` for any viewer of a widget. Profiles are
 *   not visibility-scoped anywhere in this API (a profile is a device type, the
 *   profile routes' rule), so a profile "out of view" is one that does not
 *   exist: 404. `resolve` IS scoped — it drops an instrument the caller cannot
 *   see, silently (the widget never had it).
 * - **Writing** is SUPER_ADMIN only, checked by ROLE in a `preValidation`
 *   hook so a non-super-admin is a 403 whatever they sent (the dashboards
 *   precedent). Then: the row (404) → `enforceReauth('UPDATE_REPORT_TEMPLATE')`
 *   → the shared schema (400) → ONE transaction holding the write and every
 *   audit row, under the profile row lock.
 * - **A name is unique per (profile, widget type) ignoring case** — the
 *   database's `lower(name)` index decides it, reported as 409
 *   TEMPLATE_NAME_IN_USE. No application pre-check: the index is the rule.
 * - **At most one default.** Setting one (POST with `isDefault`, or
 *   `PUT /:id/default`) clears the other first, each change audited. Deleting
 *   the default promotes nothing: the download then uses the built-in.
 * - A save that changes nothing writes nothing and audits nothing.
 */
const WRITE_TX = { timeout: 15_000 } as const;
/** As many as `GET /api/instruments/telemetry-overview` takes; a GET cannot carry many more ids. */
const RESOLVE_IDS_MAX = 200;

// ─── JSON schemas (the response schemas are a FILTER: every field is named) ──

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const rowProps = {
  id: { type: 'string' },
  profileId: { type: 'string' },
  widgetType: { type: 'string' },
  name: { type: 'string' },
  isDefault: { type: 'boolean' },
  // The shared zod contract is the shape; declared free so no inner key is stripped.
  document: { type: 'object', additionalProperties: true },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  updatedBy: { type: 'string', nullable: true },
} as const;
const rowSchema = { type: 'object', properties: rowProps } as const;

/** Every `ReportField` property — `unit`, `measured` and `perKey` included (ruling T1-C4). */
const fieldSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    group: { type: 'string', enum: ['builtin', 'key', 'attribute'] },
    kind: { type: 'string', enum: ['text', 'number', 'datetime', 'status'] },
    unit: { type: 'string' },
    measured: { type: 'boolean' },
    perKey: { type: 'boolean' },
  },
} as const;

const sectionSchema = {
  type: 'object',
  properties: {
    profileId: { type: 'string' },
    profileName: { type: 'string' },
    instrumentIds: { type: 'array', items: { type: 'string' } },
    template: { type: 'object', nullable: true, properties: rowProps },
  },
} as const;

/** The web client sends the re-auth password in the body as well as the header. */
const reauthPassword = { _currentPassword: { type: 'string' } } as const;

/**
 * Shape only — the shared zod schemas run in the handler, after the role, the
 * 404 and the re-auth, so a bad value is a 400 VALIDATION_ERROR in the
 * schema's own words. `additionalProperties: false` strips anything else
 * (`createdBy`, `updatedAt` …) before the handler sees it.
 */
const createBody = {
  type: 'object',
  properties: {
    profileId: { type: 'string' },
    widgetType: { type: 'string', description: `One of: ${WIDGET_TYPES.join(', ')}` },
    name: { type: 'string' },
    isDefault: { type: 'boolean' },
    document: { type: 'object', additionalProperties: true },
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;

const updateBody = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    document: { type: 'object', additionalProperties: true },
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;

const widgetTypeQuery = { type: 'string', description: `One of: ${WIDGET_TYPES.join(', ')}` } as const;

// ─── query parsers (zod, so a bad value is VALIDATION_ERROR everywhere) ─────

const widgetTypeSchema = z.enum(WIDGET_TYPES, { errorMap: () => ({ message: 'Not a widget type' }) });
const profileIdSchema = z.string().uuid('Not a profile id');
const listQuery = z.object({ profileId: profileIdSchema.optional(), widgetType: widgetTypeSchema.optional() });
const catalogueQuery = z.object({ profileId: profileIdSchema, widgetType: widgetTypeSchema });

// ─── replies ─────────────────────────────────────────────────────────────────

const invalid = (reply: FastifyReply, r: Pick<Refusal, 'message'> & { details?: Refusal['details'] }) =>
  reply.code(400).send({ error: 'VALIDATION_ERROR', message: r.message, ...(r.details ? { details: r.details } : {}) });
const invalidQuery = (reply: FastifyReply, error: z.ZodError) => invalid(reply, {
  message: error.issues[0]?.message ?? 'Bad query',
  details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
});
const templateNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'TEMPLATE_NOT_FOUND', message: TEMPLATE_NOT_FOUND_MESSAGE });
const profileNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'PROFILE_NOT_FOUND', message: PROFILE_NOT_FOUND_MESSAGE });
const nameInUse = (reply: FastifyReply, name: string, widgetType: WidgetType) =>
  reply.code(409).send({ error: 'TEMPLATE_NAME_IN_USE', message: nameInUseMessage(name, widgetType) });

/**
 * Step 1 of every write, as a `preValidation` hook so it runs BEFORE the path
 * and the body are validated: a non-SUPER_ADMIN is a 403 whatever they sent,
 * never a 400 or a 404. `req.user` is set by the global `onRequest` auth hook.
 */
async function superAdminOnly(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role === 'SUPER_ADMIN') return;
  return reply.code(403).send({ error: 'REPORT_TEMPLATES_SUPER_ADMIN_ONLY', message: REPORT_TEMPLATES_SUPER_ADMIN_ONLY });
}

const asJson = (d: unknown) => d as Prisma.InputJsonValue;
const present = (row: Parameters<typeof presentTemplate>[0]) => presentTemplate(row) as ReportTemplateRow;

export default async function reportTemplateRoutes(app: FastifyInstance) {
  // ─── LIST ──────────────────────────────────────────────
  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Report Templates'],
      summary: 'Report templates, by profile and / or widget type',
      description: 'Both filters optional. Ordered by widget type (WIDGET_TYPES order), then name ignoring case. The document is read forgivingly: a corrupt one reads as the widget type\'s built-in.',
      querystring: { type: 'object', properties: { profileId: { type: 'string' }, widgetType: widgetTypeQuery } },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: rowSchema } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return invalidQuery(reply, q.error);
    const rows = await prisma.reportTemplate.findMany({
      where: { ...(q.data.profileId ? { profileId: q.data.profileId } : {}), ...(q.data.widgetType ? { widgetType: q.data.widgetType } : {}) },
    });
    const order = (t: string) => (WIDGET_TYPES as readonly string[]).indexOf(t);
    const data = rows
      .map(presentTemplate)
      .filter((r): r is ReportTemplateRow => r !== null)
      .sort((a, b) => order(a.widgetType) - order(b.widgetType) || byName(a, b));
    return { data };
  });

  // ─── CATALOGUE ─────────────────────────────────────────
  app.get('/catalogue', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Report Templates'],
      summary: 'The fields a template of this profile × widget type may print',
      description: 'Built-in (per widget type) ∪ key:<k> (the profile\'s measured device keys, measured: true, then its trend-page display keys) ∪ attr:<k> (the profile\'s attribute keys, labelled by Attribute Display Names; sensor-offset keys for a SUPER_ADMIN only). text_card and floorplan: none. 404 PROFILE_NOT_FOUND for no such profile.',
      querystring: { type: 'object', properties: { profileId: { type: 'string' }, widgetType: widgetTypeQuery } },
      response: { 200: { type: 'object', properties: { fields: { type: 'array', items: fieldSchema } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const q = catalogueQuery.safeParse(req.query);
    if (!q.success) return invalidQuery(reply, q.error);
    const profile = await prisma.instrumentProfile.findUnique({
      where: { id: q.data.profileId },
      select: { attributeKeys: true, measurements: true, displayKeys: true },
    });
    if (!profile) return profileNotFound(reply);
    return { fields: await buildReportCatalogue(profile, q.data.widgetType, req.user.role === 'SUPER_ADMIN') };
  });

  // ─── RESOLVE ───────────────────────────────────────────
  app.get('/resolve', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Report Templates'],
      summary: 'Which template a widget\'s download uses, per profile',
      description: `The widget's instruments grouped by profile, sections in the order each profile first appears in \`instrumentIds\`; each section's template is the profile's DEFAULT for the widget type, or null (the built-in). An instrument the caller cannot see, or that does not exist, is dropped silently. \`instrumentIds\` is required (a comma list, at most ${RESOLVE_IDS_MAX}); empty = no sections.`,
      querystring: { type: 'object', properties: { widgetType: widgetTypeQuery, instrumentIds: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { sections: { type: 'array', items: sectionSchema } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const q = req.query as { widgetType?: string; instrumentIds?: string };
    const type = widgetTypeSchema.safeParse(q.widgetType);
    if (!type.success) return invalidQuery(reply, type.error);
    if (q.instrumentIds === undefined) return invalid(reply, { message: 'Name the widget\'s instruments: instrumentIds is required.' });
    const list = parseUuidList(q.instrumentIds, RESOLVE_IDS_MAX);
    if (list.error) return invalid(reply, { message: list.error });
    const ids = list.ids ?? [];
    if (ids.length === 0) return { sections: [] };

    const { where: visibility } = await resolveVisibility(buildContext(req));
    const instruments = await prisma.instrument.findMany({
      where: withVisibility({ id: { in: ids } }, visibility) as Prisma.InstrumentWhereInput,
      select: { id: true, profileId: true, profile: { select: { name: true } } },
    });
    const byId = new Map(instruments.map((i) => [i.id, i]));
    const sections = new Map<string, { profileId: string; profileName: string; instrumentIds: string[] }>();
    for (const id of ids) {
      const inst = byId.get(id);
      if (!inst) continue;
      const s = sections.get(inst.profileId);
      if (s) s.instrumentIds.push(id);
      else sections.set(inst.profileId, { profileId: inst.profileId, profileName: inst.profile.name, instrumentIds: [id] });
    }
    const defaults = sections.size === 0 ? [] : await prisma.reportTemplate.findMany({
      where: { profileId: { in: [...sections.keys()] }, widgetType: type.data, isDefault: true },
    });
    const defaultOf = new Map(defaults.map((t) => [t.profileId, presentTemplate(t)]));
    return { sections: [...sections.values()].map((s) => ({ ...s, template: defaultOf.get(s.profileId) ?? null })) };
  });

  // ─── ONE ───────────────────────────────────────────────
  app.get('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Report Templates'],
      summary: 'One report template',
      params: idParams,
      response: { 200: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await findTemplate(id);
    const out = row ? presentTemplate(row) : null;
    if (!out) return templateNotFound(reply);
    return out;
  });

  // ─── CREATE ────────────────────────────────────────────
  app.post('/', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Report Templates'],
      summary: 'Create a report template (SUPER_ADMIN)',
      description: 'Body: { profileId, widgetType, name, isDefault?, document } — the shared reportTemplateCreateSchema; HTML is stripped from every text field. `isDefault: true` clears the current default of the profile × widget type. 404 PROFILE_NOT_FOUND; 409 TEMPLATE_NAME_IN_USE (names compared ignoring case). Re-auth action UPDATE_REPORT_TEMPLATE.',
      body: createBody,
      response: { 201: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const parsed = parseCreate(req.body);
    if (!parsed.ok) return invalid(reply, parsed);
    const v = parsed.value;
    const ctx = who(req);

    // A P2002 aborts the transaction, so it is caught OUTSIDE it.
    const outcome = await prisma.$transaction(async (tx) => {
      const profile = await lockProfile(tx, v.profileId);
      if (!profile) return { kind: 'no-profile' } as const;
      if (v.isDefault) await clearDefaults(tx, ctx, profile, v.widgetType, null);
      const created = await tx.reportTemplate.create({
        data: {
          profileId: v.profileId, widgetType: v.widgetType, name: v.name, isDefault: v.isDefault,
          document: asJson(v.document), createdBy: ctx.userId, updatedBy: ctx.userId,
        },
      });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_CREATED', targetType: 'report_template', targetId: created.id,
        afterValue: templateAuditValue(created, profile.name),
        signatureMeaning: meaning(created, profile.name, v.isDefault ? 'created as the default' : 'created'),
      }, tx);
      return { kind: 'created', row: created } as const;
    }, WRITE_TX).catch((err: unknown) => {
      if (uniqueViolation(err) === 'name') return { kind: 'name-in-use' } as const;
      throw err;
    });
    if (outcome.kind === 'name-in-use') return nameInUse(reply, v.name, v.widgetType);
    if (outcome.kind === 'no-profile') return profileNotFound(reply);
    return reply.code(201).send(present(outcome.row));
  });

  // ─── SAVE ──────────────────────────────────────────────
  app.put('/:id', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Report Templates'],
      summary: 'Rename a report template and / or replace its document (SUPER_ADMIN)',
      description: 'Body: { name?, document? } — at least one. The profile and the widget type never change. A save that changes nothing writes and audits nothing. 409 TEMPLATE_NAME_IN_USE. Re-auth action UPDATE_REPORT_TEMPLATE.',
      params: idParams,
      body: updateBody,
      response: { 200: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await findTemplate(id);
    if (!current || !isWidgetType(current.widgetType)) return templateNotFound(reply);
    const widgetType = current.widgetType;
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const parsed = parseUpdate(req.body, widgetType);
    if (!parsed.ok) return invalid(reply, parsed);
    const ctx = who(req);

    const outcome = await prisma.$transaction(async (tx) => {
      const profile = await lockProfile(tx, current.profileId);
      const was = await tx.reportTemplate.findUnique({ where: { id } });
      if (!profile || !was) return { kind: 'gone' } as const;
      const before = templateAuditValue(was, profile.name);
      const nextName = parsed.value.name ?? was.name;
      const nextDocument = parsed.value.document ?? before.document;
      const after = { ...before, name: nextName, document: nextDocument };
      if (JSON.stringify(before) === JSON.stringify(after)) return { kind: 'saved', row: was } as const;
      const saved = await tx.reportTemplate.update({
        where: { id },
        data: { name: nextName, document: asJson(nextDocument), updatedBy: ctx.userId },
      });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_UPDATED', targetType: 'report_template', targetId: id,
        beforeValue: before, afterValue: templateAuditValue(saved, profile.name),
        signatureMeaning: meaning(saved, profile.name, nextName === was.name ? 'updated' : `updated (was "${was.name}")`),
      }, tx);
      return { kind: 'saved', row: saved } as const;
    }, WRITE_TX).catch((err: unknown) => {
      if (uniqueViolation(err) === 'name') return { kind: 'name-in-use' } as const;
      throw err;
    });
    if (outcome.kind === 'name-in-use') return nameInUse(reply, parsed.value.name ?? current.name, widgetType);
    if (outcome.kind === 'gone') return templateNotFound(reply);
    return present(outcome.row);
  });

  // ─── SET AS DEFAULT ────────────────────────────────────
  app.put('/:id/default', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Report Templates'],
      summary: 'Make a report template its profile × widget type\'s default (SUPER_ADMIN)',
      description: 'Clears the current default in the same transaction, each change audited. Already the default: nothing written. Re-auth action UPDATE_REPORT_TEMPLATE.',
      params: idParams,
      response: { 200: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await findTemplate(id);
    if (!current || !isWidgetType(current.widgetType)) return templateNotFound(reply);
    const widgetType = current.widgetType;
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const ctx = who(req);

    const outcome = await prisma.$transaction(async (tx) => {
      const profile = await lockProfile(tx, current.profileId);
      const was = await tx.reportTemplate.findUnique({ where: { id } });
      if (!profile || !was) return { kind: 'gone' } as const;
      if (was.isDefault) return { kind: 'saved', row: was } as const;
      await clearDefaults(tx, ctx, profile, widgetType, id);
      const saved = await tx.reportTemplate.update({ where: { id }, data: { isDefault: true, updatedBy: ctx.userId } });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_UPDATED', targetType: 'report_template', targetId: id,
        beforeValue: templateAuditValue(was, profile.name), afterValue: templateAuditValue(saved, profile.name),
        signatureMeaning: meaning(saved, profile.name, 'made the default'),
      }, tx);
      return { kind: 'saved', row: saved } as const;
    }, WRITE_TX);
    if (outcome.kind === 'gone') return templateNotFound(reply);
    return present(outcome.row);
  });

  // ─── DELETE ────────────────────────────────────────────
  app.delete('/:id', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Report Templates'],
      summary: 'Delete a report template (SUPER_ADMIN)',
      description: 'A hard delete, audited with the whole document. Deleting the default promotes nothing — the download then uses the built-in. 204, no body. Re-auth action UPDATE_REPORT_TEMPLATE.',
      params: idParams,
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await findTemplate(id);
    if (!current) return templateNotFound(reply);
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const ctx = who(req);

    const deleted = await prisma.$transaction(async (tx) => {
      const profile = await lockProfile(tx, current.profileId);
      const was = await tx.reportTemplate.findUnique({ where: { id } });
      if (!profile || !was) return false;
      await tx.reportTemplate.delete({ where: { id } });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_DELETED', targetType: 'report_template', targetId: id,
        beforeValue: templateAuditValue(was, profile.name),
        signatureMeaning: meaning(was, profile.name, 'deleted'),
      }, tx);
      return true;
    }, WRITE_TX);
    if (!deleted) return templateNotFound(reply);
    return reply.code(204).send();
  });
}
