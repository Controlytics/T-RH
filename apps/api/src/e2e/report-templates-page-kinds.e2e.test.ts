/**
 * `/api/report-templates` for the PAGE template kinds (2026-11-03; spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §5, §7).
 *
 * Pins, over HTTP:
 *   - the wire speaks `kind`; an application-wide kind (`page:alarms`,
 *     `page:audit-trail`) stores `profile_id` NULL and returns `profileId: null`
 *     (null, never "" — the response schema declares it nullable);
 *   - scope is the API's rule, both ways, on create, catalogue and resolve:
 *     400 SCOPE_MISMATCH (mutation: drop `scopeMismatch` from the catalogue
 *     route → two cases fail);
 *   - a name is unique per scope × kind IGNORING CASE under the NULL scope too —
 *     the COALESCE index (mutation: drop the COALESCE from the lower-name index
 *     → the 409 case fails);
 *   - one default per application kind under two CONCURRENT set-defaults, both
 *     answered 200 (mutation: skip `clearDefaults` for the application scope →
 *     the concurrency case fails);
 *   - the catalogue of a per-profile page kind is its built-ins then `attr:`
 *     only, of an application kind its built-ins only;
 *   - resolve of an application kind is ONE section with no profile;
 *   - the audit rows name `kind` and the scope; a profile's DELETE never takes
 *     an application-wide template with it.
 *
 * Owns its super admin, reader role and user, profiles and instrument.
 * Application-wide rows are GLOBAL in the shared test database, so every name
 * carries this run's suffix and teardown deletes by id and by that suffix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateProfileMeasurementsCache } from '../modules/instruments/profile-measurements.js';
import {
  builtinReportTemplate, REPORT_TEMPLATE_FIELDS, DEFAULT_PROFILE_MEASUREMENTS,
  type ReportTemplateDocument, type ReportField, type TemplateKind,
} from '@digilog/shared';

const S = Date.now().toString(36).toUpperCase();
const s = S.toLowerCase();
const READER = `RTPK_READ_${S}`;
const PW = 'Rep0rtPageK1nds';
const NAME = { sa: `rtpk_sa_${s}`, rd: `rtpk_rd_${s}` };

let app: FastifyInstance;
type H = Record<string, string>;
let sa: H, rd: H;
const userIds: string[] = [];
const profiles: string[] = [];
const instruments: string[] = [];
const templates: string[] = [];
let P = '', PNAME = '', I = '';

interface Row {
  id: string; profileId: string | null; kind: TemplateKind; name: string; isDefault: boolean;
  document: ReportTemplateDocument; createdAt: string; updatedAt: string; updatedBy: string | null;
}
interface Section { profileId: string | null; profileName: string | null; instrumentIds: string[]; template: Row | null }

// ─── fixtures ────────────────────────────────────────────────────────────────

async function makeUser(username: string, role: string) {
  const u = await prisma.user.create({
    data: {
      username, fullName: `Full ${username}`, role, status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
    },
  });
  userIds.push(u.id);
}

async function makeProfile(name: string, data: Record<string, unknown> = {}) {
  const p = await prisma.instrumentProfile.create({ data: { name, ...data } as never });
  profiles.push(p.id);
  return p.id;
}

/** Measured device keys on the profile, so a `key:` field WOULD exist for a widget kind. */
function measurements() {
  return structuredClone(DEFAULT_PROFILE_MEASUREMENTS).map((m) => ({
    ...m,
    deviceKeys: m.code === 'TEMPERATURE' ? ['t'] : ['rh'],
  }));
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const post = (body: Record<string, unknown>, headers: H = sa) =>
  app.inject({ method: 'POST', url: '/api/report-templates', headers, payload: body as never });
async function create(body: { kind: TemplateKind; name: string; profileId?: string | null; isDefault?: boolean }): Promise<Row> {
  const res = await post({ document: builtinReportTemplate(body.kind), ...body });
  expect(res.statusCode, res.body).toBe(201);
  const row = res.json() as Row;
  templates.push(row.id);
  return row;
}
const setDefault = (id: string, headers: H = sa) =>
  app.inject({ method: 'PUT', url: `/api/report-templates/${id}/default`, headers });
const get = (url: string, headers: H = sa) => app.inject({ method: 'GET', url: `/api/report-templates${url}`, headers });
const fieldsOf = (res: { json: () => unknown }) => (res.json() as { fields: ReportField[] }).fields;

type AuditRow = { action: string; beforeValue: any; afterValue: any; signatureMeaning: string | null };
const auditFor = (templateId: string): Promise<AuditRow[]> => prisma.auditTrail.findMany({
  where: { targetId: templateId },
  orderBy: { chainPosition: 'asc' },
  select: { action: true, beforeValue: true, afterValue: true, signatureMeaning: true },
}) as Promise<AuditRow[]>;

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: READER, displayName: READER, hierarchyLevel: 2, permissions: ['INSTRUMENT_READ'] } });
  invalidateRolePermsCache();
  await makeUser(NAME.sa, 'SUPER_ADMIN');
  await makeUser(NAME.rd, READER);

  PNAME = `RTPK Profile ${S}`;
  P = await makeProfile(PNAME, {
    measurements: measurements(),
    attributeKeys: ['Location', 'Area', 'Temp Off set'].join('\n'),
    displayKeys: [{ source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa' }],
  });
  invalidateProfileMeasurementsCache();
  const inst = await prisma.instrument.create({ data: { name: `RTPK-${S}-I`, code: `RTPK-${S}-I`, profileId: P } });
  instruments.push(inst.id);
  I = inst.id;

  sa = { authorization: `Bearer ${await loginAs(app, NAME.sa, PW)}` };
  rd = { authorization: `Bearer ${await loginAs(app, NAME.rd, PW)}` };
});

afterAll(async () => {
  try {
    await prisma.reportTemplate.deleteMany({
      where: { OR: [{ id: { in: templates } }, { profileId: { in: profiles } }, { name: { contains: S, mode: 'insensitive' } }] },
    });
  } catch (e) { console.error('cleanup templates', e); }
  try { await prisma.instrument.deleteMany({ where: { id: { in: instruments } } }); } catch (e) { console.error('cleanup instruments', e); }
  try { await prisma.instrumentProfile.deleteMany({ where: { id: { in: profiles } } }); } catch (e) { console.error('cleanup profiles', e); }
  try {
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (e) { console.error('cleanup users', e); }
  try {
    await prisma.role.deleteMany({ where: { name: READER } });
    invalidateRolePermsCache();
  } catch (e) { console.error('cleanup roles', e); }
  invalidateProfileMeasurementsCache();
  await app.close();
});

// ─── cases ───────────────────────────────────────────────────────────────────

describe('/api/report-templates — page kinds and the application scope', () => {
  let plant: Row;

  it('an application-wide template: 201, profile_id NULL, kind on the wire, audited with kind and no profile', async () => {
    const res = await post({ kind: 'page:alarms', name: `Plant alarms ${S}`, isDefault: true, document: builtinReportTemplate('page:alarms') });
    expect(res.statusCode, res.body).toBe(201);
    plant = res.json() as Row;
    templates.push(plant.id);
    expect(plant.profileId).toBeNull();
    expect(plant).toMatchObject({ kind: 'page:alarms', name: `Plant alarms ${S}`, isDefault: true, updatedBy: NAME.sa });
    expect(plant).not.toHaveProperty('widgetType');
    expect(plant.document).toEqual(builtinReportTemplate('page:alarms'));

    const stored = await prisma.reportTemplate.findUniqueOrThrow({ where: { id: plant.id } });
    expect(stored.profileId).toBeNull();
    expect(stored.kind).toBe('page:alarms');

    const created = await prisma.auditTrail.findFirst({
      where: { action: 'REPORT_TEMPLATE_CREATED', userId: NAME.sa },
      orderBy: { chainPosition: 'desc' },
      select: { targetId: true, afterValue: true, signatureMeaning: true },
    });
    expect(created?.targetId).toBe(plant.id);
    const after = created?.afterValue as Record<string, unknown>;
    expect(after.kind).toBe('page:alarms');
    expect(after.profileId).toBeNull();
    expect(after.profileName).toBeNull();
    expect(after).not.toHaveProperty('widgetType');
    expect(after.document).toEqual(builtinReportTemplate('page:alarms'));
    expect(created?.signatureMeaning).toContain('application-wide');
    expect(created?.signatureMeaning).toContain('Alarm Report');

    // `profileId: null` is the same as no profile (the wire row's own shape).
    const explicit = await create({ kind: 'page:alarms', profileId: null, name: `Plant spare ${S}` });
    expect(explicit.profileId).toBeNull();
    expect(explicit.isDefault).toBe(false);
  });

  it('a name is unique per application kind IGNORING CASE, under the NULL scope (the COALESCE index): 409', async () => {
    const before = await prisma.reportTemplate.count({ where: { kind: 'page:alarms', profileId: null } });
    const dup = await post({ kind: 'page:alarms', name: `plant ALARMS ${s}`, document: builtinReportTemplate('page:alarms') });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error).toBe('TEMPLATE_NAME_IN_USE');
    expect(dup.json().message).toContain('application-wide');
    // The exact same name too (the plain index).
    const same = await post({ kind: 'page:alarms', name: `Plant alarms ${S}`, document: builtinReportTemplate('page:alarms') });
    expect(same.statusCode, same.body).toBe(409);
    expect(same.json().error).toBe('TEMPLATE_NAME_IN_USE');
    expect(await prisma.reportTemplate.count({ where: { kind: 'page:alarms', profileId: null } })).toBe(before);

    // The same name on the OTHER application kind is another template.
    const other = await create({ kind: 'page:audit-trail', name: `Plant alarms ${S}` });
    expect(other).toMatchObject({ kind: 'page:audit-trail', profileId: null });
  });

  it('scope is refused both ways on create: 400 SCOPE_MISMATCH, nothing written', async () => {
    const withProfile = await post({ kind: 'page:alarms', profileId: P, name: `Scoped ${S}`, document: builtinReportTemplate('page:alarms') });
    expect(withProfile.statusCode, withProfile.body).toBe(400);
    expect(withProfile.json().error).toBe('SCOPE_MISMATCH');
    expect(withProfile.json().message).toContain('Alarm Report');

    const withoutProfile = await post({ kind: 'page:data-report', name: `Scoped ${S}`, document: builtinReportTemplate('page:data-report') });
    expect(withoutProfile.statusCode, withoutProfile.body).toBe(400);
    expect(withoutProfile.json().error).toBe('SCOPE_MISMATCH');
    // A widget type is a profile kind as well.
    const widget = await post({ kind: 'gauge', name: `Scoped ${S}`, document: builtinReportTemplate('gauge') });
    expect(widget.statusCode, widget.body).toBe(400);
    expect(widget.json().error).toBe('SCOPE_MISMATCH');

    expect(await prisma.reportTemplate.count({ where: { name: `Scoped ${S}` } })).toBe(0);

    // A built-in column of ANOTHER kind is still refused (the kind's own field list).
    const foreign = await post({
      kind: 'page:alarms', name: `Foreign ${S}`,
      document: { ...builtinReportTemplate('page:alarms'), columns: [{ id: 'record.date', heading: 'D', show: true }] },
    });
    expect(foreign.statusCode, foreign.body).toBe(400);
    expect(foreign.json().error).toBe('VALIDATION_ERROR');
    expect(foreign.json().message).toContain('record.date');
  });

  it('two CONCURRENT set-defaults on one application kind: both 200, exactly one default, each change audited', async () => {
    const x = await create({ kind: 'page:audit-trail', name: `Audit X ${S}` });
    const y = await create({ kind: 'page:audit-trail', name: `Audit Y ${S}` });

    // Whichever runs first also clears any default the scope already had (its
    // audit row is on THAT template, not counted below).
    const [rx, ry] = await Promise.all([setDefault(x.id), setDefault(y.id)]);
    expect(rx.statusCode, rx.body).toBe(200);
    expect(ry.statusCode, ry.body).toBe(200);

    const defaults = await prisma.reportTemplate.findMany({ where: { kind: 'page:audit-trail', profileId: null, isDefault: true } });
    expect(defaults).toHaveLength(1);
    expect([x.id, y.id]).toContain(defaults[0].id);
    // Two "made the default" and one "no longer the default", whichever ran first.
    const updates = [...await auditFor(x.id), ...await auditFor(y.id)].filter((r) => r.action === 'REPORT_TEMPLATE_UPDATED');
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u.afterValue).toMatchObject({ kind: 'page:audit-trail', profileId: null, profileName: null });
    }
  });

  it('the catalogue: a per-profile page kind = its built-ins then attr: only; an application kind = its built-ins', async () => {
    const dr = await get(`/catalogue?kind=page:data-report&profileId=${P}`);
    expect(dr.statusCode, dr.body).toBe(200);
    const fields = fieldsOf(dr);
    expect(fields.slice(0, 4)).toEqual(REPORT_TEMPLATE_FIELDS('page:data-report'));
    const rest = fields.slice(4);
    expect(rest.length).toBeGreaterThan(0);
    expect(fields.some((f) => f.id.startsWith('key:'))).toBe(false);
    expect(rest.every((f) => f.id.startsWith('attr:') && f.group === 'attribute')).toBe(true);
    expect(rest.map((f) => f.id)).toEqual(['attr:Location', 'attr:Area', 'attr:Temp Off set']);
    // A sensor-offset attribute is a SUPER_ADMIN's only, as on every catalogue.
    const asReader = await get(`/catalogue?kind=page:data-report&profileId=${P}`, rd);
    expect(asReader.statusCode, asReader.body).toBe(200);
    expect(fieldsOf(asReader).map((f) => f.id)).not.toContain('attr:Temp Off set');

    // The trend has no built-in fields: attributes only.
    const trend = await get(`/catalogue?kind=page:trend&profileId=${P}`);
    expect(trend.statusCode, trend.body).toBe(200);
    expect(fieldsOf(trend).map((f) => f.id)).toEqual(['attr:Location', 'attr:Area', 'attr:Temp Off set']);
    // A widget kind keeps its key: fields (unchanged).
    const gauge = await get(`/catalogue?kind=gauge&profileId=${P}`);
    expect(fieldsOf(gauge).some((f) => f.id === 'key:t')).toBe(true);

    const alarms = await get('/catalogue?kind=page:alarms');
    expect(alarms.statusCode, alarms.body).toBe(200);
    expect(fieldsOf(alarms)).toEqual(REPORT_TEMPLATE_FIELDS('page:alarms'));
    expect(fieldsOf(alarms)).toHaveLength(10);

    const nope = await get(`/catalogue?kind=nope&profileId=${P}`);
    expect(nope.statusCode, nope.body).toBe(400);
    expect(nope.json().error).toBe('VALIDATION_ERROR');
    const ghost = await get(`/catalogue?kind=page:data-report&profileId=${randomUUID()}`);
    expect(ghost.statusCode, ghost.body).toBe(404);
    expect(ghost.json().error).toBe('PROFILE_NOT_FOUND');
  });

  it('the catalogue refuses a profile id on an application kind: 400 SCOPE_MISMATCH', async () => {
    const r = await get(`/catalogue?kind=page:alarms&profileId=${P}`);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toBe('SCOPE_MISMATCH');
  });

  it('the catalogue refuses a profile kind with no profile id: 400 SCOPE_MISMATCH', async () => {
    const r = await get('/catalogue?kind=page:data-report');
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toBe('SCOPE_MISMATCH');
  });

  it('resolve: an application kind is ONE section with no profile; ids are refused; a profile kind resolves per profile', async () => {
    const app1 = await get('/resolve?kind=page:alarms');
    expect(app1.statusCode, app1.body).toBe(200);
    const sections = app1.json().sections as Section[];
    expect(sections).toHaveLength(1);
    expect(sections[0].profileId).toBeNull();
    expect(sections[0].profileName).toBeNull();
    expect(sections[0].instrumentIds).toEqual([]);
    expect(sections[0].template).toEqual(plant);

    const withIds = await get(`/resolve?kind=page:alarms&instrumentIds=${I}`);
    expect(withIds.statusCode, withIds.body).toBe(400);
    expect(withIds.json().error).toBe('SCOPE_MISMATCH');

    const none = await get(`/resolve?kind=page:data-report&instrumentIds=${I}`);
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json().sections).toEqual([{ profileId: P, profileName: PNAME, instrumentIds: [I], template: null }]);
    const def = await create({ kind: 'page:data-report', profileId: P, name: `Data ${S}`, isDefault: true });
    expect(def.profileId).toBe(P);
    const withDefault = await get(`/resolve?kind=page:data-report&instrumentIds=${I}`);
    expect((withDefault.json().sections as Section[])[0].template).toEqual(def);

    // A profile kind still needs its instruments (unchanged).
    const missing = await get('/resolve?kind=page:data-report');
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error).toBe('VALIDATION_ERROR');
  });

  it('list and one: kind on every row, application rows with profileId null', async () => {
    const res = await get('/?kind=page:alarms');
    expect(res.statusCode, res.body).toBe(200);
    const rows = (res.json() as { data: Row[] }).data;
    expect(rows.map((r) => r.id)).toContain(plant.id);
    expect(rows.every((r) => r.kind === 'page:alarms' && r.profileId === null)).toBe(true);
    const mine = rows.find((r) => r.id === plant.id);
    expect(mine).toEqual(plant);

    const one = await get(`/${plant.id}`, rd);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toEqual(plant);
    expect(one.json().profileId).toBeNull();

    const byProfile = (await get(`/?profileId=${P}`)).json() as { data: Row[] };
    expect(byProfile.data.every((r) => r.profileId === P)).toBe(true);
    expect(byProfile.data.map((r) => r.kind)).toContain('page:data-report');
  });

  it('rename and delete an application template: audited with kind and no profile', async () => {
    const t = await create({ kind: 'page:audit-trail', name: `Rename me ${S}` });
    const renamed = await app.inject({ method: 'PUT', url: `/api/report-templates/${t.id}`, headers: sa, payload: { name: `Renamed ${S}` } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ id: t.id, name: `Renamed ${S}`, kind: 'page:audit-trail' });
    expect(renamed.json().profileId).toBeNull();
    const del = await app.inject({ method: 'DELETE', url: `/api/report-templates/${t.id}`, headers: sa });
    expect(del.statusCode, del.body).toBe(204);
    const audit = await auditFor(t.id);
    expect(audit.map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_UPDATED', 'REPORT_TEMPLATE_DELETED']);
    expect(audit[1].beforeValue).toMatchObject({ name: `Rename me ${S}`, kind: 'page:audit-trail', profileId: null, profileName: null });
    expect(audit[1].afterValue).toMatchObject({ name: `Renamed ${S}`, kind: 'page:audit-trail', profileId: null, profileName: null });
    expect(audit[2].beforeValue).toMatchObject({ name: `Renamed ${S}`, kind: 'page:audit-trail', profileId: null });
    expect(audit[2].signatureMeaning).toContain('application-wide');
  });

  it("a profile's deletion takes ITS templates (audited with kind) and never an application-wide one", async () => {
    const Q = await makeProfile(`RTPK Doomed ${S}`);
    const t = await create({ kind: 'page:trend', profileId: Q, name: `Doomed trend ${S}` });
    const res = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${Q}`, headers: sa });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.reportTemplate.findUnique({ where: { id: t.id } })).toBeNull();
    const audit = await auditFor(t.id);
    expect(audit.map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_DELETED']);
    expect(audit[1].beforeValue).toMatchObject({ kind: 'page:trend', profileId: Q, profileName: `RTPK Doomed ${S}` });
    expect(audit[1].beforeValue).not.toHaveProperty('widgetType');
    // The application-wide rows are untouched.
    expect(await prisma.reportTemplate.findUnique({ where: { id: plant.id } })).not.toBeNull();
  });
});
