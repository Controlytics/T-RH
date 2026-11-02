/**
 * The rules behind `/api/report-templates` (2026-11-02; spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §5, §7,
 * §9, §10, §12).
 *
 * - **One parser for every write** (`parseTemplateWrite`): the shared zod
 *   schema, then HTML stripped from every TEXT field of the name and the
 *   document (never the logo, the ids, the sources or the colour), then the
 *   shared schema AGAIN on the cleaned value — so a heading that is nothing but
 *   markup is refused in the schema's own words, never stored blank — then the
 *   one rule the type-agnostic document schema leaves to the server: a built-in
 *   column must be a field of THIS widget type. `key:` / `attr:` columns are
 *   never checked against the profile: a key can be added later, and a column
 *   the profile lacks prints as "not available" at download (spec §6).
 * - **One reader for every row** (`presentTemplate`): the document goes through
 *   `coerceReportTemplateDocument`, so a corrupt row reads as the built-in.
 * - **Every write that touches `is_default` holds the PROFILE row lock**
 *   (`lockProfile`) and clears the current default BEFORE setting another, so
 *   the partial unique index `report_templates_one_default` never fires on a
 *   legitimate path. A template that loses the default is audited under its
 *   own name.
 * - Audit values carry `name` (the Audit Trail renders `{targetName}` from it)
 *   and the WHOLE document (§12).
 */
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  WIDGET_TYPES, WIDGET_TYPE_SPECS, WIDGET_REPORT_FIELDS,
  coerceReportTemplateDocument, reportTemplateCreateSchema, reportTemplateUpdateSchema,
  type WidgetType, type ReportTemplateDocument,
} from '@digilog/shared';
import type { ZodIssue } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { auditLog, clampSignatureMeaning } from '../../lib/audit.js';
import { stripHtml } from '../../lib/sanitize.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const REAUTH_ACTION = 'UPDATE_REPORT_TEMPLATE';
export const REPORT_TEMPLATES_SUPER_ADMIN_ONLY = 'Only a super admin can create, change or delete report templates.';
export const TEMPLATE_NOT_FOUND_MESSAGE = 'Report template not found.';
export const PROFILE_NOT_FOUND_MESSAGE = 'Instrument profile not found.';

export function isWidgetType(v: unknown): v is WidgetType {
  return typeof v === 'string' && (WIDGET_TYPES as readonly string[]).includes(v);
}

export const widgetLabel = (t: WidgetType) => WIDGET_TYPE_SPECS[t].label;

export function nameInUseMessage(name: string, widgetType: WidgetType): string {
  return `A ${widgetLabel(widgetType)} template named "${name}" already exists for this profile. Names are compared ignoring case.`;
}

// ─── the wire row ────────────────────────────────────────────────────────────

/** What every route returns for a template (`GET /`, `GET /:id`, the writes, `resolve`). */
export interface ReportTemplateRow {
  id: string;
  profileId: string;
  widgetType: WidgetType;
  name: string;
  isDefault: boolean;
  document: ReportTemplateDocument;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export type StoredTemplate = {
  id: string; profileId: string; widgetType: string; name: string; isDefault: boolean;
  document: unknown; createdAt: Date; updatedAt: Date; updatedBy: string | null;
};

/** The ONE reader of a stored row. A row whose widget type is not one this build knows is null. */
export function presentTemplate(row: StoredTemplate): ReportTemplateRow | null {
  if (!isWidgetType(row.widgetType)) return null;
  return {
    id: row.id,
    profileId: row.profileId,
    widgetType: row.widgetType,
    name: row.name,
    isDefault: row.isDefault,
    document: coerceReportTemplateDocument(row.document, row.widgetType),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/** Case-insensitive (`accent`: A = a, a ≠ á), then by id so equal names keep a stable order. */
export function byName(a: { name: string; id: string }, b: { name: string; id: string }): number {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'accent' }) || a.id.localeCompare(b.id);
}

// ─── the write parser ────────────────────────────────────────────────────────

export interface Refusal { ok: false; message: string; details: { path: string; message: string }[] }

function refusal(issues: readonly ZodIssue[], prefix: string[] = []): Refusal {
  const details = issues.map((i) => ({ path: [...prefix, ...i.path].join('.'), message: i.message }));
  return { ok: false, message: details[0]?.message ?? 'Not a report template', details };
}

/** Strip HTML from an optional field, keeping it absent when it was absent. */
function optional<K extends string>(key: K, v: string | undefined): Partial<Record<K, string>> {
  return v === undefined ? {} : ({ [key]: stripHtml(v) } as Record<K, string>);
}

/**
 * HTML stripped from what a document SAYS. Not cut to a length: the second
 * schema pass refuses a value the fail-safe escaping made too long, in the
 * schema's words, rather than storing a silently shortened one. Not touched:
 * the logo data URL, the column ids, the info sources, the colour, the flags.
 */
export function cleanDocumentText(d: ReportTemplateDocument): ReportTemplateDocument {
  return {
    ...d,
    header: {
      ...d.header,
      title: stripHtml(d.header.title),
      ...optional('subtitle', d.header.subtitle),
      ...optional('companyName', d.header.companyName),
      ...optional('appName', d.header.appName),
    },
    infoBlock: d.infoBlock.map((r) => ({ ...r, label: stripHtml(r.label) })),
    columns: d.columns.map((c) => ({ ...c, heading: stripHtml(c.heading), ...optional('unit', c.unit) })),
    footer: { ...d.footer, ...optional('text', d.footer.text) },
    notes: { ...d.notes, ...optional('remarksLabel', d.notes.remarksLabel), ...optional('legend', d.notes.legend) },
  };
}

/** A built-in column must be a field of the template's own widget type. Null = fine. */
export function foreignBuiltinColumn(widgetType: WidgetType, d: ReportTemplateDocument): string | null {
  const allowed = new Set(WIDGET_REPORT_FIELDS[widgetType].map((f) => f.id));
  const foreign = d.columns.find((c) => !c.id.startsWith('key:') && !c.id.startsWith('attr:') && !allowed.has(c.id));
  return foreign ? `"${foreign.id}" is not a field of a ${widgetLabel(widgetType)} report` : null;
}

export type CreateWrite = { profileId: string; widgetType: WidgetType; name: string; isDefault: boolean; document: ReportTemplateDocument };

/** A POST body → the value to store, or the first refusal. */
export function parseCreate(body: unknown): { ok: true; value: CreateWrite } | Refusal {
  const first = reportTemplateCreateSchema.safeParse(body);
  if (!first.success) return refusal(first.error.issues);
  const second = reportTemplateCreateSchema.safeParse({
    ...first.data,
    name: stripHtml(first.data.name),
    document: cleanDocumentText(first.data.document),
  });
  if (!second.success) return refusal(second.error.issues);
  const foreign = foreignBuiltinColumn(second.data.widgetType, second.data.document);
  if (foreign) return { ok: false, message: foreign, details: [{ path: 'document.columns', message: foreign }] };
  return { ok: true, value: second.data };
}

/** A PUT body → what changes, or the first refusal. At least one of the two is required. */
export function parseUpdate(body: unknown, widgetType: WidgetType): { ok: true; value: { name?: string; document?: ReportTemplateDocument } } | Refusal {
  const first = reportTemplateUpdateSchema.safeParse(body);
  if (!first.success) return refusal(first.error.issues);
  if (first.data.name === undefined && first.data.document === undefined) {
    const message = 'Nothing to change: send a name, a document or both.';
    return { ok: false, message, details: [{ path: '', message }] };
  }
  const second = reportTemplateUpdateSchema.safeParse({
    ...(first.data.name === undefined ? {} : { name: stripHtml(first.data.name) }),
    ...(first.data.document === undefined ? {} : { document: cleanDocumentText(first.data.document) }),
  });
  if (!second.success) return refusal(second.error.issues);
  if (second.data.document) {
    const foreign = foreignBuiltinColumn(widgetType, second.data.document);
    if (foreign) return { ok: false, message: foreign, details: [{ path: 'document.columns', message: foreign }] };
  }
  return { ok: true, value: second.data };
}

/**
 * Which unique index a Prisma P2002 came from, read from `meta.target` ONLY:
 * the name — `["profileId","widgetType","name"]` for the plain index,
 * `["profile_id","widget_type","lower(name)"]` for the case-folded one (both
 * measured 2026-11-02) — is a 409 TEMPLATE_NAME_IN_USE; the one-default index
 * — `["profile_id","widget_type"]` — is a bug (every path that sets a default
 * clears the old one first under the profile lock) and is rethrown. Never the
 * error MESSAGE: Prisma quotes the calling source there, `isDefault` and `name`
 * included.
 */
export function uniqueViolation(err: unknown): 'name' | 'default' | null {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return null;
  const t = e.meta?.target;
  const target = Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
  if (/name/i.test(target)) return 'name';
  if (/one_default|widget_?type/i.test(target)) return 'default';
  return null;
}

// ─── locks and defaults ──────────────────────────────────────────────────────

/**
 * Lock the profile row for the rest of the transaction and return its name,
 * or null when there is no such profile. Every template write takes it, so two
 * "set as default" calls on one profile run one after the other, and a profile
 * delete (which takes it too) cannot cascade a template created after it read
 * the list it audits.
 */
export async function lockProfile(tx: Prisma.TransactionClient, profileId: string): Promise<{ id: string; name: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM instrument_profiles WHERE id = ${profileId} FOR UPDATE`;
  return rows[0] ?? null;
}

// ─── audit ───────────────────────────────────────────────────────────────────

export interface AuditContext {
  userId: string; userRole: string; ipAddress?: string; userAgent?: string; sessionId?: string;
}

/** Who, on every audit row this module writes. */
export const who = (req: FastifyRequest): AuditContext => ({
  userId: req.user.username, userRole: req.user.role,
  ipAddress: req.ip, userAgent: req.headers['user-agent'], sessionId: req.user.sessionId,
});

type AuditedTemplate = { profileId: string; widgetType: string; name: string; isDefault: boolean; document: unknown };

/** A template on an audit row: everything it is, the document whole, and its profile by name. */
export function templateAuditValue(t: AuditedTemplate, profileName: string) {
  const widgetType = isWidgetType(t.widgetType) ? t.widgetType : null;
  return {
    name: t.name,
    profileId: t.profileId,
    profileName,
    widgetType: t.widgetType,
    isDefault: t.isDefault,
    document: widgetType ? coerceReportTemplateDocument(t.document, widgetType) : t.document,
  };
}

/** `Report template "<name>" (<widget label>, profile "<profile>") <what>`, within VARCHAR(255). */
export function meaning(t: { name: string; widgetType: string }, profileName: string, what: string): string {
  const label = isWidgetType(t.widgetType) ? widgetLabel(t.widgetType) : t.widgetType;
  return clampSignatureMeaning(`Report template "${t.name}" (${label}, profile "${profileName}") ${what}`) ?? '';
}

/**
 * Clear the current default of (profile, widget type), except `keepId`, each
 * one audited REPORT_TEMPLATE_UPDATED under its own name. The caller holds
 * the profile lock.
 */
export async function clearDefaults(
  tx: Prisma.TransactionClient, ctx: AuditContext, profile: { id: string; name: string },
  widgetType: WidgetType, keepId: string | null,
): Promise<void> {
  const current = await tx.reportTemplate.findMany({
    where: { profileId: profile.id, widgetType, isDefault: true, ...(keepId ? { NOT: { id: keepId } } : {}) },
  });
  for (const was of current) {
    const now = await tx.reportTemplate.update({ where: { id: was.id }, data: { isDefault: false, updatedBy: ctx.userId } });
    await auditLog({
      ...ctx, action: 'REPORT_TEMPLATE_UPDATED', targetType: 'report_template', targetId: was.id,
      beforeValue: templateAuditValue(was, profile.name), afterValue: templateAuditValue(now, profile.name),
      signatureMeaning: meaning(was, profile.name, 'is no longer the default'),
    }, tx);
  }
}

/**
 * A profile's DELETE takes its templates with it (ON DELETE CASCADE). Called
 * by that route inside its transaction, under the profile lock, BEFORE the
 * delete: one REPORT_TEMPLATE_DELETED row per template, the document whole,
 * so the cascade is not a deletion with no record.
 */
export async function auditTemplatesDeletedWithProfile(
  tx: Prisma.TransactionClient, ctx: AuditContext, profile: { id: string; name: string },
): Promise<number> {
  const templates = await tx.reportTemplate.findMany({ where: { profileId: profile.id }, orderBy: [{ widgetType: 'asc' }, { name: 'asc' }] });
  for (const t of templates) {
    await auditLog({
      ...ctx, action: 'REPORT_TEMPLATE_DELETED', targetType: 'report_template', targetId: t.id,
      beforeValue: templateAuditValue(t, profile.name),
      signatureMeaning: meaning(t, profile.name, 'deleted with its profile'),
    }, tx);
  }
  return templates.length;
}

export async function findTemplate(id: string, db: Db = prisma) {
  return db.reportTemplate.findUnique({ where: { id } });
}
