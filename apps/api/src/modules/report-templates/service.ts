/**
 * The rules behind `/api/report-templates` (2026-11-02; spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §5, §7,
 * §9, §10, §12; 2026-11-03 page kinds and the application scope:
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §5, §7).
 *
 * - **A template is for a KIND** (`TemplateKind`: a widget type or a `page:`
 *   kind) and belongs to a SCOPE: one instrument profile, or — for the two
 *   application-wide kinds (`page:alarms`, `page:audit-trail`) — the whole
 *   application, `profile_id` NULL. `templateKindScope(kind)` decides which;
 *   `scopeMismatch` is the ONE check (400 SCOPE_MISMATCH both ways), called by
 *   create, the catalogue and resolve. There is no database CHECK.
 * - **One parser for every write** (`parseCreate` / `parseUpdate`): the shared
 *   zod schema, then HTML stripped from every TEXT field of the name and the
 *   document (never the logo, the ids, the sources or the colour), then the
 *   shared schema AGAIN on the cleaned value — so a heading that is nothing but
 *   markup is refused in the schema's own words, never stored blank — then the
 *   one rule the kind-agnostic document schema leaves to the server: a built-in
 *   column must be a field of THIS kind (`REPORT_TEMPLATE_FIELDS`). `key:` /
 *   `attr:` columns are never checked against the profile: a key can be added
 *   later, and a column the profile lacks prints as "not available" at
 *   download (spec §6).
 * - **One reader for every row** (`presentTemplate`): the document goes through
 *   `coerceReportTemplateDocument`, so a corrupt row reads as the built-in.
 * - **Every write holds its SCOPE's lock** (`lockScope`): the profile row lock
 *   for a profile scope, `pg_advisory_xact_lock(hashtext('report_templates:' ||
 *   kind))` for the application scope (there is no row to lock). A write that
 *   sets a default clears the scope's current default BEFORE setting another
 *   (`clearDefaults`), so the partial unique index `report_templates_one_default`
 *   never fires on a legitimate path. A template that loses the default is
 *   audited under its own name.
 * - Audit values carry `name` (the Audit Trail renders `{targetName}` from it),
 *   `kind`, the scope (`profileId` / `profileName`, both null application-wide)
 *   and the WHOLE document (§12).
 */
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  REPORT_TEMPLATE_FIELDS, isTemplateKind, templateKindLabel, templateKindScope,
  coerceReportTemplateDocument, reportTemplateCreateSchema, reportTemplateUpdateSchema,
  type TemplateKind, type ReportTemplateDocument, type ReportTemplateRow,
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

/** A stored `kind` this build knows. */
export const isTemplateKindValue = (v: unknown): v is TemplateKind => isTemplateKind(v);

export const kindLabel = (kind: TemplateKind) => templateKindLabel(kind);

/** "A" or "An" before a label ("An Alarm Report", "A Gauge"). */
const article = (label: string) => (/^[aeiou]/i.test(label) ? 'An' : 'A');

/** Where a template's name is unique: its profile, or the whole application. */
const scopeWords = (kind: TemplateKind) => (templateKindScope(kind) === 'application' ? 'application-wide' : 'for this profile');

export function nameInUseMessage(name: string, kind: TemplateKind): string {
  const label = kindLabel(kind);
  return `${article(label)} ${label} template named "${name}" already exists ${scopeWords(kind)}. Names are compared ignoring case.`;
}

/**
 * The ONE scope check: null when `profileId` fits the kind, else the reason —
 * an application-wide kind takes no profile, a profile kind needs one.
 */
export function scopeMismatch(kind: TemplateKind, profileId: string | null): string | null {
  const label = kindLabel(kind);
  if (templateKindScope(kind) === 'application') {
    return profileId === null ? null : `${label} templates are application-wide: they belong to no instrument profile, so send no profileId.`;
  }
  return profileId !== null ? null : `${article(label)} ${label} template belongs to an instrument profile: profileId is required.`;
}

/** Resolve of an application-wide kind names no instruments. */
export function resolveIdsMismatch(kind: TemplateKind): string {
  return `${kindLabel(kind)} templates are application-wide: resolve takes no instrumentIds for them.`;
}

// ─── the wire row (`ReportTemplateRow`, @digilog/shared) ─────────────────────

export type StoredTemplate = {
  id: string; profileId: string | null; kind: string; name: string; isDefault: boolean;
  document: unknown; createdAt: Date; updatedAt: Date; updatedBy: string | null;
};

/** The ONE reader of a stored row. A row whose kind is not one this build knows is null. */
export function presentTemplate(row: StoredTemplate): ReportTemplateRow | null {
  if (!isTemplateKindValue(row.kind)) return null;
  return {
    id: row.id,
    profileId: row.profileId,
    kind: row.kind,
    name: row.name,
    isDefault: row.isDefault,
    document: coerceReportTemplateDocument(row.document, row.kind),
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

/** A built-in column must be a field of the template's own kind. Null = fine. */
export function foreignBuiltinColumn(kind: TemplateKind, d: ReportTemplateDocument): string | null {
  const allowed = new Set(REPORT_TEMPLATE_FIELDS(kind).map((f) => f.id));
  const foreign = d.columns.find((c) => !c.id.startsWith('key:') && !c.id.startsWith('attr:') && !allowed.has(c.id));
  const label = kindLabel(kind);
  return foreign ? `"${foreign.id}" is not a field of ${article(label).toLowerCase()} ${label} template` : null;
}

/** What a create stores. `profileId` null = application-wide (whether it FITS the kind is `scopeMismatch`'s). */
export type CreateWrite = { profileId: string | null; kind: TemplateKind; name: string; isDefault: boolean; document: ReportTemplateDocument };

/** `profileId: null` → no `profileId` (the shared schema takes a uuid or nothing). */
function withoutNullProfile(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || (body as Record<string, unknown>).profileId !== null) return body;
  const copy = { ...(body as Record<string, unknown>) };
  delete copy.profileId;
  return copy;
}

/**
 * A POST body → the value to store, or the first refusal. `profileId: null` is
 * read as no profile — the wire row's own shape for an application template —
 * so a client may send back what it was given.
 */
export function parseCreate(body: unknown): { ok: true; value: CreateWrite } | Refusal {
  const first = reportTemplateCreateSchema.safeParse(withoutNullProfile(body));
  if (!first.success) return refusal(first.error.issues);
  const second = reportTemplateCreateSchema.safeParse({
    ...first.data,
    name: stripHtml(first.data.name),
    document: cleanDocumentText(first.data.document),
  });
  if (!second.success) return refusal(second.error.issues);
  const foreign = foreignBuiltinColumn(second.data.kind, second.data.document);
  if (foreign) return { ok: false, message: foreign, details: [{ path: 'document.columns', message: foreign }] };
  return { ok: true, value: { ...second.data, profileId: second.data.profileId ?? null } };
}

/** A PUT body → what changes, or the first refusal. At least one of the two is required. */
export function parseUpdate(body: unknown, kind: TemplateKind): { ok: true; value: { name?: string; document?: ReportTemplateDocument } } | Refusal {
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
    const foreign = foreignBuiltinColumn(kind, second.data.document);
    if (foreign) return { ok: false, message: foreign, details: [{ path: 'document.columns', message: foreign }] };
  }
  return { ok: true, value: second.data };
}

/**
 * Which unique index a Prisma P2002 came from, read from `meta.target` ONLY.
 * Since migration 20261103120000 all three key on COALESCE(profile_id, ''):
 * the two NAME indexes — `report_templates_scope_kind_name_key` and
 * `report_templates_scope_kind_lower_name_key` — are a 409
 * TEMPLATE_NAME_IN_USE; the one-default index — `report_templates_one_default`
 * on (COALESCE(profile_id, ''), kind) — is a bug (every path that sets a
 * default clears the old one first under the scope lock) and is rethrown.
 * `name` is tested FIRST because the name indexes carry `kind` as well. What
 * Prisma 6 puts in `target` for these expression indexes is pinned by
 * `__tests__/unique-violation.test.ts` with the values measured on 2026-11-03.
 * Never the error MESSAGE: Prisma quotes the calling source there, `isDefault`
 * and `name` included.
 */
export function uniqueViolation(err: unknown): 'name' | 'default' | null {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return null;
  const t = e.meta?.target;
  const target = Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
  if (/name/i.test(target)) return 'name';
  if (/one_default|kind/i.test(target)) return 'default';
  return null;
}

// ─── locks and defaults ──────────────────────────────────────────────────────

/**
 * Lock the profile row for the rest of the transaction and return its name,
 * or null when there is no such profile. Every profile-scope template write
 * takes it (through `lockScope`), so two "set as default" calls on one profile
 * run one after the other, and a profile delete (which takes it too) cannot
 * cascade a template created after it read the list it audits.
 */
export async function lockProfile(tx: Prisma.TransactionClient, profileId: string): Promise<{ id: string; name: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM instrument_profiles WHERE id = ${profileId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** A template's scope, locked: one profile (by id and name), or the application (both null). */
export type Scope = { profileId: string; profileName: string } | { profileId: null; profileName: null };

/**
 * Lock a template's scope for the rest of the transaction. A profile scope
 * takes the profile row lock (null when the profile is gone); the application
 * scope has no row, so it takes a transaction-scoped advisory lock on the KIND
 * — two "set as default" calls on one application kind run one after the
 * other, and the second clears the first's default instead of colliding with
 * it on `report_templates_one_default`. `$executeRaw`, not `$queryRaw`: the
 * lock function returns void, which Prisma cannot deserialize.
 */
export async function lockScope(tx: Prisma.TransactionClient, kind: string, profileId: string | null): Promise<Scope | null> {
  if (profileId === null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`report_templates:${kind}`}::text))`;
    return { profileId: null, profileName: null };
  }
  const profile = await lockProfile(tx, profileId);
  return profile ? { profileId: profile.id, profileName: profile.name } : null;
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

type AuditedTemplate = { profileId: string | null; kind: string; name: string; isDefault: boolean; document: unknown };

/**
 * A template on an audit row: everything it is, the document whole, its kind
 * and its scope — the profile by id and name, both null application-wide.
 * (Rows written before 2026-11-03 carry `widgetType` instead of `kind`;
 * history, never read back.)
 */
export function templateAuditValue(t: AuditedTemplate, profileName: string | null) {
  return {
    name: t.name,
    kind: t.kind,
    profileId: t.profileId,
    profileName,
    isDefault: t.isDefault,
    document: isTemplateKindValue(t.kind) ? coerceReportTemplateDocument(t.document, t.kind) : t.document,
  };
}

/**
 * `Report template "<name>" (<kind label>, profile "<profile>") <what>` — or
 * `(<kind label>, application-wide)` — within VARCHAR(255).
 */
export function meaning(t: { name: string; kind: string }, profileName: string | null, what: string): string {
  const label = isTemplateKindValue(t.kind) ? kindLabel(t.kind) : t.kind;
  const scope = profileName === null ? 'application-wide' : `profile "${profileName}"`;
  return clampSignatureMeaning(`Report template "${t.name}" (${label}, ${scope}) ${what}`) ?? '';
}

/**
 * Clear the current default of (scope, kind), except `keepId`, each one
 * audited REPORT_TEMPLATE_UPDATED under its own name. `scope.profileId` null
 * matches the application scope (`profile_id IS NULL`). The caller holds the
 * scope's lock (`lockScope`).
 */
export async function clearDefaults(
  tx: Prisma.TransactionClient, ctx: AuditContext, scope: Scope,
  kind: TemplateKind, keepId: string | null,
): Promise<void> {
  const current = await tx.reportTemplate.findMany({
    where: { profileId: scope.profileId, kind, isDefault: true, ...(keepId ? { NOT: { id: keepId } } : {}) },
  });
  for (const was of current) {
    const now = await tx.reportTemplate.update({ where: { id: was.id }, data: { isDefault: false, updatedBy: ctx.userId } });
    await auditLog({
      ...ctx, action: 'REPORT_TEMPLATE_UPDATED', targetType: 'report_template', targetId: was.id,
      beforeValue: templateAuditValue(was, scope.profileName), afterValue: templateAuditValue(now, scope.profileName),
      signatureMeaning: meaning(was, scope.profileName, 'is no longer the default'),
    }, tx);
  }
}

/**
 * A profile's DELETE takes its templates with it (ON DELETE CASCADE). Called
 * by that route inside its transaction, under the profile lock, BEFORE the
 * delete: one REPORT_TEMPLATE_DELETED row per template, the document whole,
 * so the cascade is not a deletion with no record. An application-wide
 * template (`profile_id` NULL) belongs to no profile and is never in this list.
 */
export async function auditTemplatesDeletedWithProfile(
  tx: Prisma.TransactionClient, ctx: AuditContext, profile: { id: string; name: string },
): Promise<number> {
  const templates = await tx.reportTemplate.findMany({ where: { profileId: profile.id }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
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
