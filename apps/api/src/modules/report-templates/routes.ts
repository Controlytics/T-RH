import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  TEMPLATE_KINDS, REPORT_TEMPLATE_RESOLVE_IDS_MAX, templateKindScope,
  type TemplateKind, type ReportTemplateRow,
} from '@digilog/shared';
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
  isTemplateKindValue, nameInUseMessage, scopeMismatch, resolveIdsMismatch, presentTemplate, byName,
  parseCreate, parseUpdate, uniqueViolation, lockScope, clearDefaults, templateAuditValue, meaning, who, findTemplate,
  type Refusal,
} from './service.js';

/**
 * `/api/report-templates` — what a report prints, per TEMPLATE KIND (a widget
 * type's "Download report", or one of the five page reports), per instrument
 * PROFILE or application-wide (2026-11-02; spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §5–§10, §12;
 * page kinds 2026-11-03, docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §5, §7).
 *
 * - **Scope.** A widget type and the three per-instrument page kinds belong to
 *   one profile; `page:alarms` and `page:audit-trail` are application-wide
 *   (`profileId: null`). `templateKindScope(kind)` decides; a create, a
 *   catalogue or a resolve that names the wrong scope is a 400 SCOPE_MISMATCH
 *   (`scopeMismatch`) — a profile id on an application kind, none on a profile
 *   kind.
 * - **Reading** (`readGate`, controller ruling T2-A 2026-11-03): an
 *   APPLICATION-WIDE kind's templates are read by any signed-in user — the
 *   Alarms and Audit Trail pages' own permissions gate those downloads, and
 *   such a template names no instrument. Everything else — a profile kind, a
 *   list with no `kind` (it mixes both scopes), a kind that is no kind — needs
 *   INSTRUMENT_READ and nothing more: the download needs the list, the
 *   catalogue and `resolve` for any viewer of a report. `GET /:id` decides by
 *   the STORED row's kind, after the row is found (a missing row is 404).
 *   Profiles are not visibility-scoped anywhere in this API (a profile is a
 *   device type, the profile routes' rule), so a profile "out of view" is one
 *   that does not exist: 404. `resolve` IS scoped — it drops an instrument the
 *   caller cannot see, silently (the report never had it). An application
 *   kind's resolve names no instrument.
 * - **Writing** is SUPER_ADMIN only, checked by ROLE in a `preValidation`
 *   hook so a non-super-admin is a 403 whatever they sent (the dashboards
 *   precedent). Then: the row (404) → `enforceReauth('UPDATE_REPORT_TEMPLATE')`
 *   → the shared schema (400) → the scope (400) → ONE transaction holding the
 *   write and every audit row, under the scope's lock (`lockScope`: the profile
 *   row, or an advisory lock on the kind application-wide).
 * - **A name is unique per scope × kind ignoring case** — the database's
 *   COALESCE(profile_id, '') + `lower(name)` index decides it, reported as 409
 *   TEMPLATE_NAME_IN_USE. No application pre-check: the index is the rule.
 * - **At most one default per scope × kind.** Setting one (POST with
 *   `isDefault`, or `PUT /:id/default`) clears the other first, each change
 *   audited. Deleting the default promotes nothing: the download then uses the
 *   built-in.
 * - A save that changes nothing writes nothing and audits nothing.
 */
const WRITE_TX = { timeout: 15_000 } as const;

// ─── JSON schemas (the response schemas are a FILTER: every field is named) ──

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

/** `profileId` is NULLABLE — null = application-wide. Without it the serializer writes "" for null. */
const rowProps = {
  id: { type: 'string' },
  profileId: { type: 'string', nullable: true },
  kind: { type: 'string' },
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

/** One section per profile; an application kind's ONE section has both profile fields null. */
const sectionSchema = {
  type: 'object',
  properties: {
    profileId: { type: 'string', nullable: true },
    profileName: { type: 'string', nullable: true },
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
    // Nullable: null = no profile (application-wide). A plain string type would
    // COERCE null to "" and fail as "Not a profile id".
    profileId: { type: 'string', nullable: true },
    kind: { type: 'string', description: `One of: ${TEMPLATE_KINDS.join(', ')}` },
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

const kindQuery = { type: 'string', description: `One of: ${TEMPLATE_KINDS.join(', ')}` } as const;

// ─── query parsers (zod, so a bad value is VALIDATION_ERROR everywhere) ─────

const kindSchema = z.enum(TEMPLATE_KINDS, { errorMap: () => ({ message: 'Not a report template kind' }) });
const profileIdSchema = z.string().uuid('Not a profile id');
const listQuery = z.object({ profileId: profileIdSchema.optional(), kind: kindSchema.optional() });
/** `profileId` is optional HERE; whether the kind needs one is `scopeMismatch`'s (400 SCOPE_MISMATCH). */
const catalogueQuery = z.object({ kind: kindSchema, profileId: profileIdSchema.optional() });

// ─── replies ─────────────────────────────────────────────────────────────────

const invalid = (reply: FastifyReply, r: Pick<Refusal, 'message'> & { error?: Refusal['error']; details?: Refusal['details'] }) =>
  reply.code(400).send({ error: r.error ?? 'VALIDATION_ERROR', message: r.message, ...(r.details ? { details: r.details } : {}) });
const invalidQuery = (reply: FastifyReply, error: z.ZodError) => invalid(reply, {
  message: error.issues[0]?.message ?? 'Bad query',
  details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
});
const templateNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'TEMPLATE_NOT_FOUND', message: TEMPLATE_NOT_FOUND_MESSAGE });
const profileNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'PROFILE_NOT_FOUND', message: PROFILE_NOT_FOUND_MESSAGE });
const nameInUse = (reply: FastifyReply, name: string, kind: TemplateKind) =>
  reply.code(409).send({ error: 'TEMPLATE_NAME_IN_USE', message: nameInUseMessage(name, kind) });
const wrongScope = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: 'SCOPE_MISMATCH', message });

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

/** `page:alarms` / `page:audit-trail` — read by any signed-in user. Anything else (absent, an array, no kind) is not. */
const isApplicationKind = (k: unknown): boolean => isTemplateKindValue(k) && templateKindScope(k) === 'application';

export default async function reportTemplateRoutes(app: FastifyInstance) {
  /**
   * The READ gate (controller ruling T2-A): INSTRUMENT_READ, by the decorator's
   * OWN check — SUPER_ADMIN and the permission fallbacks cannot drift from
   * every other route — unless the kind is application-wide. The global auth
   * hook has already answered 401 to a caller with no session.
   */
  const instrumentRead = app.requirePermission('INSTRUMENT_READ');
  /** The gate for a read whose kind is in the QUERY: decided on the raw value, before it is parsed. */
  const readGate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (isApplicationKind((req.query as { kind?: unknown }).kind)) return;
    return instrumentRead(req, reply);
  };

  // ─── LIST ──────────────────────────────────────────────
  app.get('/', {
    preHandler: [readGate],
    schema: {
      tags: ['Report Templates'],
      summary: 'Report templates, by profile and / or kind',
      description: 'Both filters optional; `profileId` omitted lists every scope, application-wide rows included (their `profileId` is null). Ordered by kind (TEMPLATE_KINDS order), then name ignoring case. The document is read forgivingly: a corrupt one reads as the kind\'s built-in. Needs INSTRUMENT_READ, except with `kind` an application-wide kind (page:alarms, page:audit-trail): then any signed-in user. A list with no `kind` mixes both scopes and needs INSTRUMENT_READ.',
      querystring: { type: 'object', properties: { profileId: { type: 'string' }, kind: kindQuery } },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: rowSchema } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return invalidQuery(reply, q.error);
    const rows = await prisma.reportTemplate.findMany({
      where: { ...(q.data.profileId ? { profileId: q.data.profileId } : {}), ...(q.data.kind ? { kind: q.data.kind } : {}) },
    });
    const order = (k: string) => (TEMPLATE_KINDS as readonly string[]).indexOf(k);
    const data = rows
      .map(presentTemplate)
      .filter((r): r is ReportTemplateRow => r !== null)
      .sort((a, b) => order(a.kind) - order(b.kind) || byName(a, b));
    return { data };
  });

  // ─── CATALOGUE ─────────────────────────────────────────
  app.get('/catalogue', {
    preHandler: [readGate],
    schema: {
      tags: ['Report Templates'],
      summary: 'The fields a template of this kind (× profile) may print',
      description: 'Built-in (per kind), then by the kind\'s profile fields: a reportable widget type adds key:<k> (the profile\'s measured device keys, measured: true, then its trend-page display keys) and attr:<k> (the profile\'s attribute keys, labelled by Attribute Display Names; sensor-offset keys for a SUPER_ADMIN only); a per-profile page kind adds attr:<k> only; pie_chart, alarm_counts and the application-wide kinds their built-ins only; text_card and floorplan: none. `profileId` is required for a profile kind and refused for an application-wide one (400 SCOPE_MISMATCH). 404 PROFILE_NOT_FOUND for no such profile. Needs INSTRUMENT_READ, except for an application-wide kind (any signed-in user).',
      querystring: { type: 'object', properties: { kind: kindQuery, profileId: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { fields: { type: 'array', items: fieldSchema } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const q = catalogueQuery.safeParse(req.query);
    if (!q.success) return invalidQuery(reply, q.error);
    const { kind } = q.data;
    const mismatch = scopeMismatch(kind, q.data.profileId ?? null);
    if (mismatch) return wrongScope(reply, mismatch);
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN';
    if (q.data.profileId === undefined) return { fields: await buildReportCatalogue(null, kind, isSuperAdmin) };
    const profile = await prisma.instrumentProfile.findUnique({
      where: { id: q.data.profileId },
      select: { attributeKeys: true, measurements: true, displayKeys: true },
    });
    if (!profile) return profileNotFound(reply);
    return { fields: await buildReportCatalogue(profile, kind, isSuperAdmin) };
  });

  // ─── RESOLVE ───────────────────────────────────────────
  app.get('/resolve', {
    preHandler: [readGate],
    schema: {
      tags: ['Report Templates'],
      summary: 'Which template a download uses, per profile (or application-wide)',
      description: `A profile kind (needs INSTRUMENT_READ): the report's instruments grouped by profile, sections in the order each profile first appears in \`instrumentIds\`; each section's template is the profile's DEFAULT for the kind, or null (the built-in). An instrument the caller cannot see, or that does not exist, is dropped silently. \`instrumentIds\` is required (a comma list, at most ${REPORT_TEMPLATE_RESOLVE_IDS_MAX}); empty = no sections. An application-wide kind (page:alarms, page:audit-trail; any signed-in user): NO \`instrumentIds\` (400 SCOPE_MISMATCH if sent) and ONE section { profileId: null, profileName: null, instrumentIds: [], template: the kind's default or null }.`,
      querystring: { type: 'object', properties: { kind: kindQuery, instrumentIds: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { sections: { type: 'array', items: sectionSchema } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const q = req.query as { kind?: string; instrumentIds?: string };
    const parsedKind = kindSchema.safeParse(q.kind);
    if (!parsedKind.success) return invalidQuery(reply, parsedKind.error);
    const kind = parsedKind.data;
    if (templateKindScope(kind) === 'application') {
      if (q.instrumentIds !== undefined) return wrongScope(reply, resolveIdsMismatch(kind));
      const def = await prisma.reportTemplate.findFirst({ where: { profileId: null, kind, isDefault: true } });
      return { sections: [{ profileId: null, profileName: null, instrumentIds: [], template: def ? presentTemplate(def) : null }] };
    }
    if (q.instrumentIds === undefined) return invalid(reply, { message: 'Name the report\'s instruments: instrumentIds is required.' });
    const list = parseUuidList(q.instrumentIds, REPORT_TEMPLATE_RESOLVE_IDS_MAX);
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
      where: { profileId: { in: [...sections.keys()] }, kind, isDefault: true },
    });
    const defaultOf = new Map(defaults.map((t) => [t.profileId, presentTemplate(t)]));
    return { sections: [...sections.values()].map((s) => ({ ...s, template: defaultOf.get(s.profileId) ?? null })) };
  });

  // ─── ONE ───────────────────────────────────────────────
  app.get('/:id', {
    schema: {
      tags: ['Report Templates'],
      summary: 'One report template',
      description: 'Decided by the STORED row\'s kind, after the row is found: an application-wide template is read by any signed-in user, any other needs INSTRUMENT_READ (403). A missing row is 404.',
      params: idParams,
      response: { 200: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await findTemplate(id);
    const out = row ? presentTemplate(row) : null;
    if (!out) return templateNotFound(reply);
    if (!isApplicationKind(out.kind)) {
      await instrumentRead(req, reply);
      if (reply.sent) return reply;
    }
    return out;
  });

  // ─── CREATE ────────────────────────────────────────────
  app.post('/', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Report Templates'],
      summary: 'Create a report template (SUPER_ADMIN)',
      description: 'Body: { profileId?, kind, name, isDefault?, document } — the shared reportTemplateCreateSchema; HTML is stripped from every text field. `profileId` is required for a profile kind and must be absent (or null) for an application-wide kind (page:alarms, page:audit-trail) — 400 SCOPE_MISMATCH otherwise. `isDefault: true` clears the current default of the scope × kind. 404 PROFILE_NOT_FOUND; 409 TEMPLATE_NAME_IN_USE (names compared ignoring case, per scope × kind). Re-auth action UPDATE_REPORT_TEMPLATE.',
      body: createBody,
      response: { 201: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const parsed = parseCreate(req.body);
    if (!parsed.ok) return invalid(reply, parsed);
    const v = parsed.value;
    const mismatch = scopeMismatch(v.kind, v.profileId);
    if (mismatch) return wrongScope(reply, mismatch);
    const ctx = who(req);

    // A P2002 aborts the transaction, so it is caught OUTSIDE it.
    const outcome = await prisma.$transaction(async (tx) => {
      const scope = await lockScope(tx, v.kind, v.profileId);
      if (!scope) return { outcome: 'no-profile' } as const;
      if (v.isDefault) await clearDefaults(tx, ctx, scope, v.kind, null);
      const created = await tx.reportTemplate.create({
        data: {
          profileId: scope.profileId, kind: v.kind, name: v.name, isDefault: v.isDefault,
          document: asJson(v.document), createdBy: ctx.userId, updatedBy: ctx.userId,
        },
      });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_CREATED', targetType: 'report_template', targetId: created.id,
        afterValue: templateAuditValue(created, scope.profileName),
        signatureMeaning: meaning(created, scope.profileName, v.isDefault ? 'created as the default' : 'created'),
      }, tx);
      return { outcome: 'created', row: created } as const;
    }, WRITE_TX).catch((err: unknown) => {
      if (uniqueViolation(err) === 'name') return { outcome: 'name-in-use' } as const;
      throw err;
    });
    if (outcome.outcome === 'name-in-use') return nameInUse(reply, v.name, v.kind);
    if (outcome.outcome === 'no-profile') return profileNotFound(reply);
    return reply.code(201).send(present(outcome.row));
  });

  // ─── SAVE ──────────────────────────────────────────────
  app.put('/:id', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Report Templates'],
      summary: 'Rename a report template and / or replace its document (SUPER_ADMIN)',
      description: 'Body: { name?, document? } — at least one. The scope (profile or application-wide) and the kind never change. A save that changes nothing writes and audits nothing. 409 TEMPLATE_NAME_IN_USE. Re-auth action UPDATE_REPORT_TEMPLATE.',
      params: idParams,
      body: updateBody,
      response: { 200: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await findTemplate(id);
    if (!current || !isTemplateKindValue(current.kind)) return templateNotFound(reply);
    const kind = current.kind;
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const parsed = parseUpdate(req.body, kind);
    if (!parsed.ok) return invalid(reply, parsed);
    const ctx = who(req);

    const outcome = await prisma.$transaction(async (tx) => {
      const scope = await lockScope(tx, kind, current.profileId);
      const was = await tx.reportTemplate.findUnique({ where: { id } });
      if (!scope || !was) return { outcome: 'gone' } as const;
      const before = templateAuditValue(was, scope.profileName);
      const nextName = parsed.value.name ?? was.name;
      const nextDocument = parsed.value.document ?? before.document;
      const after = { ...before, name: nextName, document: nextDocument };
      if (JSON.stringify(before) === JSON.stringify(after)) return { outcome: 'saved', row: was } as const;
      const saved = await tx.reportTemplate.update({
        where: { id },
        data: { name: nextName, document: asJson(nextDocument), updatedBy: ctx.userId },
      });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_UPDATED', targetType: 'report_template', targetId: id,
        beforeValue: before, afterValue: templateAuditValue(saved, scope.profileName),
        signatureMeaning: meaning(saved, scope.profileName, nextName === was.name ? 'updated' : `updated (was "${was.name}")`),
      }, tx);
      return { outcome: 'saved', row: saved } as const;
    }, WRITE_TX).catch((err: unknown) => {
      if (uniqueViolation(err) === 'name') return { outcome: 'name-in-use' } as const;
      throw err;
    });
    if (outcome.outcome === 'name-in-use') return nameInUse(reply, parsed.value.name ?? current.name, kind);
    if (outcome.outcome === 'gone') return templateNotFound(reply);
    return present(outcome.row);
  });

  // ─── SET AS DEFAULT ────────────────────────────────────
  app.put('/:id/default', {
    preValidation: [superAdminOnly],
    schema: {
      tags: ['Report Templates'],
      summary: 'Make a report template its scope × kind\'s default (SUPER_ADMIN)',
      description: 'Clears the current default of the same scope (the profile, or application-wide) and kind in the same transaction, each change audited; the scope is locked, so two concurrent calls run one after the other. Already the default: nothing written. Re-auth action UPDATE_REPORT_TEMPLATE.',
      params: idParams,
      response: { 200: rowSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await findTemplate(id);
    if (!current || !isTemplateKindValue(current.kind)) return templateNotFound(reply);
    const kind = current.kind;
    const { ok } = await enforceReauth(REAUTH_ACTION, req, reply);
    if (!ok) return;
    const ctx = who(req);

    const outcome = await prisma.$transaction(async (tx) => {
      const scope = await lockScope(tx, kind, current.profileId);
      const was = await tx.reportTemplate.findUnique({ where: { id } });
      if (!scope || !was) return { outcome: 'gone' } as const;
      if (was.isDefault) return { outcome: 'saved', row: was } as const;
      await clearDefaults(tx, ctx, scope, kind, id);
      const saved = await tx.reportTemplate.update({ where: { id }, data: { isDefault: true, updatedBy: ctx.userId } });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_UPDATED', targetType: 'report_template', targetId: id,
        beforeValue: templateAuditValue(was, scope.profileName), afterValue: templateAuditValue(saved, scope.profileName),
        signatureMeaning: meaning(saved, scope.profileName, 'made the default'),
      }, tx);
      return { outcome: 'saved', row: saved } as const;
    }, WRITE_TX);
    if (outcome.outcome === 'gone') return templateNotFound(reply);
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
      const scope = await lockScope(tx, current.kind, current.profileId);
      const was = await tx.reportTemplate.findUnique({ where: { id } });
      if (!scope || !was) return false;
      await tx.reportTemplate.delete({ where: { id } });
      await auditLog({
        ...ctx, action: 'REPORT_TEMPLATE_DELETED', targetType: 'report_template', targetId: id,
        beforeValue: templateAuditValue(was, scope.profileName),
        signatureMeaning: meaning(was, scope.profileName, 'deleted'),
      }, tx);
      return true;
    }, WRITE_TX);
    if (!deleted) return templateNotFound(reply);
    return reply.code(204).send();
  });
}
