/**
 * `/api/report-templates` — report templates per instrument profile per widget
 * type (2026-11-02; spec docs/superpowers/specs/2026-11-02-widget-report-templates-design.md
 * §5, §6, §7, §10, §12).
 *
 * Pins, over HTTP:
 *   - only a SUPER_ADMIN writes, checked by ROLE before the path and the body
 *     are validated, whatever INSTRUMENT_* / CONFIG_* grants the caller holds;
 *   - a name is unique per (profile, widget type) IGNORING CASE — the database
 *     index decides it (mutation: drop the lower() index → the 409 case fails);
 *   - at most one default; setting one clears the other, each change audited
 *     under its own name; deleting the default promotes nothing;
 *   - a profile's deletion takes its templates with it, each one audited
 *     (mutation: FK RESTRICT → the cascade case fails);
 *   - the catalogue is built-in ∪ key:<k> ∪ attr:<k> with every ReportField
 *     property on the wire (Fastify strips undeclared ones, silently);
 *   - resolve groups by profile in instrument order and drops what the caller
 *     cannot see;
 *   - reads need INSTRUMENT_READ, nothing more.
 *
 * Owns its super admin, roles, users, profiles and instruments. The four
 * `system_config` rows it touches (`action-reauth`, `attribute-labels`,
 * `report-downloads`, `report-approvers`) are restored FIRST in afterAll, each
 * guarded on its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { invalidateProfileMeasurementsCache } from '../modules/instruments/profile-measurements.js';
import {
  builtinReportTemplate, WIDGET_REPORT_FIELDS, DEFAULT_PROFILE_MEASUREMENTS, ATTRIBUTE_LABELS_CONFIG_KEY,
  type ReportTemplateDocument, type ReportField, type WidgetType,
} from '@digilog/shared';

const S = Date.now().toString(36).toUpperCase();
const s = S.toLowerCase();
const READER = `RT_READ_${S}`;
const MGR = `RT_MGR_${S}`;
const NOREAD = `RT_NOREAD_${S}`;
const ROLES = [READER, MGR, NOREAD];
const PW = 'Rep0rtTempl@te';
const NAME = { sa: `rt_sa_${s}`, rd: `rt_rd_${s}`, sc: `rt_sc_${s}`, mg: `rt_mg_${s}`, no: `rt_no_${s}` };
const SUPER_ADMIN_ONLY = 'Only a super admin can create, change or delete report templates.';
/** An attribute key of this suite's own, so its display name can be set and restored. */
const ROOM_KEY = `RT_${S}_Room`;
const ROOM_LABEL = 'Room name';
/** A 1 x 1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: FastifyInstance;
type H = Record<string, string>;
let sa: H, rd: H, sc: H, mg: H, no: H;
const userIds: string[] = [];
const profiles: string[] = [];
const instruments: string[] = [];
let P1 = '', P2 = '';
let A1 = '', A2 = '', B1 = '';
let reauthBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;
let labelsBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;
let downloadsBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;
let approversBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;
const reviews: string[] = [];

interface Row {
  id: string; profileId: string; widgetType: WidgetType; name: string; isDefault: boolean;
  document: ReportTemplateDocument; createdAt: string; updatedAt: string; updatedBy: string | null;
}
interface Section { profileId: string; profileName: string; instrumentIds: string[]; template: Row | null }

// ─── fixtures ────────────────────────────────────────────────────────────────

async function makeUser(username: string, role: string) {
  const u = await prisma.user.create({
    data: {
      username, fullName: `Full ${username}`, role, status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
    },
  });
  userIds.push(u.id);
  return u.id;
}

async function makeProfile(name: string, data: Record<string, unknown> = {}) {
  const p = await prisma.instrumentProfile.create({ data: { name, ...data } as never });
  profiles.push(p.id);
  return p.id;
}

async function makeInstrument(code: string, profileId: string) {
  const i = await prisma.instrument.create({ data: { name: code, code, profileId } });
  instruments.push(i.id);
  return i.id;
}

/** The profile's measurements with its own device keys: one temperature key, two humidity keys. */
function measurements() {
  return structuredClone(DEFAULT_PROFILE_MEASUREMENTS).map((m) => ({
    ...m,
    deviceKeys: m.code === 'TEMPERATURE' ? ['t'] : ['rh', 'hum'],
  }));
}

const gaugeDoc = () => builtinReportTemplate('gauge');

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const post = (body: Record<string, unknown>, headers: H = sa) =>
  app.inject({ method: 'POST', url: '/api/report-templates', headers, payload: body as never });
async function create(body: { profileId: string; widgetType: string; name: string; isDefault?: boolean; document?: unknown }): Promise<Row> {
  const res = await post({ document: gaugeDoc(), ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
const put = (id: string, body: Record<string, unknown>, headers: H = sa) =>
  app.inject({ method: 'PUT', url: `/api/report-templates/${id}`, headers, payload: body as never });
const setDefault = (id: string, headers: H = sa) =>
  app.inject({ method: 'PUT', url: `/api/report-templates/${id}/default`, headers });
const remove = (id: string, headers: H = sa) =>
  app.inject({ method: 'DELETE', url: `/api/report-templates/${id}`, headers });
async function list(query: string, headers: H = sa): Promise<Row[]> {
  const res = await app.inject({ method: 'GET', url: `/api/report-templates?${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { data: Row[] }).data;
}
const catalogue = (profileId: string, widgetType: string, headers: H = sa) =>
  app.inject({ method: 'GET', url: `/api/report-templates/catalogue?profileId=${profileId}&widgetType=${widgetType}`, headers });
const resolve = (widgetType: string, ids: string[] | null, headers: H = sa) =>
  app.inject({
    method: 'GET',
    url: `/api/report-templates/resolve?widgetType=${widgetType}${ids === null ? '' : `&instrumentIds=${ids.join(',')}`}`,
    headers,
  });

type AuditRow = { id: string; action: string; targetType: string | null; beforeValue: any; afterValue: any; signatureMeaning: string | null; userId: string | null };
const auditFor = (templateId: string): Promise<AuditRow[]> => prisma.auditTrail.findMany({
  where: { targetId: templateId },
  orderBy: { chainPosition: 'asc' },
  select: { id: true, action: true, targetType: true, beforeValue: true, afterValue: true, signatureMeaning: true, userId: true },
}) as Promise<AuditRow[]>;

async function storeConfig(key: string, value: unknown, configType: string) {
  await prisma.systemConfig.upsert({
    where: { configKey: key },
    update: { configValue: value as never },
    create: { configKey: key, configValue: value as never, configType, requiresReauth: false },
  });
}
async function restoreConfig(key: string, before: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined) {
  if (before === undefined) return;
  if (before) await prisma.systemConfig.update({ where: { configKey: key }, data: before as never });
  else await prisma.systemConfig.deleteMany({ where: { configKey: key } });
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: READER, displayName: READER, hierarchyLevel: 2, permissions: ['INSTRUMENT_READ'] } });
  await prisma.role.create({
    data: {
      name: MGR, displayName: MGR, hierarchyLevel: 5,
      permissions: ['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'INSTRUMENT_DELETE', 'CONFIG_READ', 'CONFIG_UPDATE', 'DOWNLOAD_REPORT'],
    },
  });
  await prisma.role.create({ data: { name: NOREAD, displayName: NOREAD, hierarchyLevel: 2, permissions: ['DASHBOARD_VIEW'] } });
  invalidateRolePermsCache();
  await makeUser(NAME.sa, 'SUPER_ADMIN');
  await makeUser(NAME.rd, READER);
  const scId = await makeUser(NAME.sc, READER);
  await makeUser(NAME.mg, MGR);
  await makeUser(NAME.no, NOREAD);

  P1 = await makeProfile(`RT T&RH ${S}`, {
    measurements: measurements(),
    attributeKeys: ['Location', ROOM_KEY, 'Temp Off set'].join('\n'),
    // `T` folds onto the measured `t`: listed once, as the measured key.
    displayKeys: [
      { source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa' },
      { source: 'telemetry', key: 'T', label: 'Shadow' },
      { source: 'telemetry', key: 'flow' },
    ],
  });
  P2 = await makeProfile(`RT Second ${S}`, { measurements: measurements(), attributeKeys: 'Location' });
  invalidateProfileMeasurementsCache();
  A1 = await makeInstrument(`RT-${S}-A1`, P1);
  A2 = await makeInstrument(`RT-${S}-A2`, P1);
  B1 = await makeInstrument(`RT-${S}-B1`, P2);
  // sc sees A1 and B1 by name, not A2.
  await prisma.userConfig.create({ data: { userId: scId, instrumentScope: { locationIds: [], instrumentIds: [A1, B1] } as never } });

  // A display name for this suite's own attribute key; restored FIRST in afterAll.
  const row = await prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
  labelsBefore = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
  const value = (row?.configValue as Record<string, unknown> | undefined) ?? {};
  const labels = { ...((value.labels as Record<string, string> | undefined) ?? {}), [ROOM_KEY]: ROOM_LABEL };
  await storeConfig(ATTRIBUTE_LABELS_CONFIG_KEY, { ...value, labels }, row?.configType ?? 'json');

  sa = { authorization: `Bearer ${await loginAs(app, NAME.sa, PW)}` };
  rd = { authorization: `Bearer ${await loginAs(app, NAME.rd, PW)}` };
  sc = { authorization: `Bearer ${await loginAs(app, NAME.sc, PW)}` };
  mg = { authorization: `Bearer ${await loginAs(app, NAME.mg, PW)}` };
  no = { authorization: `Bearer ${await loginAs(app, NAME.no, PW)}` };
});

afterAll(async () => {
  // The two config rows FIRST, each guarded on its own: other suites read them.
  try { await restoreConfig('action-reauth', reauthBefore); } catch (e) { console.error('restore action-reauth', e); } finally { invalidateReauthCache(); }
  try { await restoreConfig(ATTRIBUTE_LABELS_CONFIG_KEY, labelsBefore); } catch (e) { console.error('restore attribute-labels', e); }
  try { await restoreConfig('report-downloads', downloadsBefore); } catch (e) { console.error('restore report-downloads', e); }
  try { await restoreConfig('report-approvers', approversBefore); } catch (e) { console.error('restore report-approvers', e); }
  try { await prisma.reportReview.deleteMany({ where: { id: { in: reviews } } }); } catch (e) { console.error('cleanup report reviews', e); }
  try { await prisma.notification.deleteMany({ where: { forUserId: { in: Object.values(NAME) } } }); } catch (e) { console.error('cleanup notifications', e); }
  try { await prisma.reportTemplate.deleteMany({ where: { profileId: { in: profiles } } }); } catch (e) { console.error('cleanup templates', e); }
  try { await prisma.instrument.deleteMany({ where: { id: { in: instruments } } }); } catch (e) { console.error('cleanup instruments', e); }
  try { await prisma.instrumentProfile.deleteMany({ where: { id: { in: profiles } } }); } catch (e) { console.error('cleanup profiles', e); }
  try {
    await prisma.userConfig.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (e) { console.error('cleanup users', e); }
  try {
    await prisma.role.deleteMany({ where: { name: { in: ROLES } } });
    invalidateRolePermsCache();
  } catch (e) { console.error('cleanup roles', e); }
  invalidateProfileMeasurementsCache();
  await app.close();
});

// ─── cases ───────────────────────────────────────────────────────────────────

describe('/api/report-templates', () => {
  it('a super admin creates a template: 201, the row, one audit row with the whole document', async () => {
    const document = gaugeDoc();
    document.header.logo = { mode: 'custom', dataUrl: PNG };
    document.header.accentColor = '#1e40af';
    document.columns[0] = { ...document.columns[0], heading: 'Instrument', decimals: 2, unit: 'x' };
    document.footer.text = 'Controlled copy';
    document.notes = { remarksLabel: 'Comments', legend: 'NMT = not more than' };
    const res = await post({ profileId: P1, widgetType: 'gauge', name: `  Gauge A ${S}  `, document });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json() as Row;
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row).toMatchObject({ profileId: P1, widgetType: 'gauge', name: `Gauge A ${S}`, isDefault: false, updatedBy: NAME.sa });
    // Every inner key survives the response filter.
    expect(row.document).toEqual(document);
    expect(Date.parse(row.createdAt)).not.toBeNaN();
    expect(Date.parse(row.updatedAt)).not.toBeNaN();

    const stored = await prisma.reportTemplate.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.createdBy).toBe(NAME.sa);
    expect(stored.document).toEqual(document);

    const audit = await auditFor(row.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'REPORT_TEMPLATE_CREATED', targetType: 'report_template', userId: NAME.sa });
    expect(audit[0].afterValue).toMatchObject({ profileId: P1, widgetType: 'gauge', name: `Gauge A ${S}`, isDefault: false });
    expect(audit[0].afterValue.document).toEqual(document);
    expect(audit[0].signatureMeaning).toContain(`Gauge A ${S}`);
  });

  it('a name is unique per profile and widget type IGNORING CASE (the database index): 409, nothing written', async () => {
    const first = await create({ profileId: P1, widgetType: 'latest_table', name: `Shift ${S}`, document: builtinReportTemplate('latest_table') });
    const before = await prisma.reportTemplate.count({ where: { profileId: P1 } });
    const dup = await post({ profileId: P1, widgetType: 'latest_table', name: `shift ${s}`, document: builtinReportTemplate('latest_table') });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error).toBe('TEMPLATE_NAME_IN_USE');
    expect(await prisma.reportTemplate.count({ where: { profileId: P1 } })).toBe(before);
    expect(await prisma.auditTrail.count({ where: { action: 'REPORT_TEMPLATE_CREATED', afterValue: { path: ['name'], equals: `shift ${s}` } } })).toBe(0);

    // The same name on another widget type, or another profile, is another template.
    await create({ profileId: P1, widgetType: 'gauge', name: `SHIFT ${S}` });
    await create({ profileId: P2, widgetType: 'latest_table', name: `Shift ${S}`, document: builtinReportTemplate('latest_table') });

    // A rename onto another template's name, in another case, is refused too.
    const other = await create({ profileId: P1, widgetType: 'latest_table', name: `Night ${S}`, document: builtinReportTemplate('latest_table') });
    const rename = await put(other.id, { name: `SHIFT ${S}` });
    expect(rename.statusCode, rename.body).toBe(409);
    expect(rename.json().error).toBe('TEMPLATE_NAME_IN_USE');
    expect((await prisma.reportTemplate.findUniqueOrThrow({ where: { id: other.id } })).name).toBe(`Night ${S}`);
    // Its own name in another case is a rename, not a conflict.
    const recase = await put(first.id, { name: `SHIFT ${S}` });
    expect(recase.statusCode, recase.body).toBe(200);
    expect((recase.json() as Row).name).toBe(`SHIFT ${S}`);
  });

  it('only a super admin writes — the role is checked before the path and the body', async () => {
    const t = await create({ profileId: P1, widgetType: 'pie_chart', name: `Guarded ${S}`, document: builtinReportTemplate('pie_chart') });
    const attempts = [
      await post({ profileId: P1, widgetType: 'pie_chart', name: `Hijack ${S}`, document: builtinReportTemplate('pie_chart') }, mg),
      await post({ profileId: P1, widgetType: 'nope', name: '', document: {} }, mg),
      await post({}, rd),
      await put(t.id, { name: `Hijack ${S}` }, mg),
      await put(t.id, { name: 42 }, rd),
      await app.inject({ method: 'PUT', url: '/api/report-templates/not-a-uuid', headers: mg, payload: { name: 'x' } }),
      await setDefault(t.id, mg),
      await remove(t.id, mg),
      await app.inject({ method: 'DELETE', url: '/api/report-templates/not-a-uuid', headers: rd }),
    ];
    for (const res of attempts) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ error: 'REPORT_TEMPLATES_SUPER_ADMIN_ONLY', message: SUPER_ADMIN_ONLY });
    }
    const after = await prisma.reportTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after).toMatchObject({ name: `Guarded ${S}`, isDefault: false });
    expect(await prisma.reportTemplate.count({ where: { name: { startsWith: `Hijack ${S}` } } })).toBe(0);
    expect((await auditFor(t.id)).map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED']);
  });

  it('refuses what is not a template: 400 VALIDATION_ERROR; an unknown profile or template is a 404', async () => {
    const bad = [
      await post({ profileId: P1, widgetType: 'nope', name: `Bad ${S}`, document: gaugeDoc() }),
      await post({ profileId: P1, widgetType: 'gauge', name: '   ', document: gaugeDoc() }),
      // Markup and nothing else is no name.
      await post({ profileId: P1, widgetType: 'gauge', name: '<b></b>', document: gaugeDoc() }),
      await post({ profileId: P1, widgetType: 'gauge', name: `Bad ${S}`, document: { ...gaugeDoc(), version: 2 } }),
      // A built-in column of ANOTHER widget type.
      await post({
        profileId: P1, widgetType: 'gauge', name: `Bad ${S}`,
        document: { ...gaugeDoc(), columns: [...gaugeDoc().columns, { id: 'alarm.type', heading: 'Type', show: true }] },
      }),
      // A text card has no built-in fields at all.
      await post({
        profileId: P1, widgetType: 'text_card', name: `Bad ${S}`,
        document: { ...builtinReportTemplate('text_card'), columns: [{ id: 'instrument.code', heading: 'ID', show: true }] },
      }),
      // A heading that is nothing but markup is no heading.
      await post({
        profileId: P1, widgetType: 'gauge', name: `Bad ${S}`,
        document: { ...gaugeDoc(), columns: [{ id: 'instrument.code', heading: '<i></i>', show: true }] },
      }),
      await post({ profileId: 'not-a-uuid', widgetType: 'gauge', name: `Bad ${S}`, document: gaugeDoc() }),
    ];
    for (const res of bad) {
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe('VALIDATION_ERROR');
      expect(typeof res.json().message).toBe('string');
    }
    expect(bad[4].json().message).toContain('alarm.type');
    expect(await prisma.reportTemplate.count({ where: { name: `Bad ${S}` } })).toBe(0);

    const ghostProfile = await post({ profileId: randomUUID(), widgetType: 'gauge', name: `Ghost ${S}`, document: gaugeDoc() });
    expect(ghostProfile.statusCode, ghostProfile.body).toBe(404);
    expect(ghostProfile.json().error).toBe('PROFILE_NOT_FOUND');

    const ghost = randomUUID();
    for (const res of [await put(ghost, { name: 'x' }), await setDefault(ghost), await remove(ghost),
      await app.inject({ method: 'GET', url: `/api/report-templates/${ghost}`, headers: sa })]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error).toBe('TEMPLATE_NOT_FOUND');
    }

    // Any key: / attr: column is accepted — a key can be added to the profile later.
    const keyed = await create({
      profileId: P1, widgetType: 'gauge', name: `Keyed ${S}`,
      document: { ...gaugeDoc(), columns: [{ id: 'key:not-yet', heading: 'Later', show: true }, { id: 'attr:Nope', heading: 'N', show: false }] },
    });
    expect(keyed.document.columns.map((c) => c.id)).toEqual(['key:not-yet', 'attr:Nope']);
  });

  it('text is stripped of HTML on write', async () => {
    const document = gaugeDoc();
    document.header.title = '<script>alert(1)</script>Daily <b>gauge</b>';
    document.columns[0].heading = '<em>Instrument</em> ID';
    document.footer.text = 'R&D <img src=x onerror=1>copy';
    const t = await create({ profileId: P1, widgetType: 'gauge', name: `<b>Stripped</b> ${S}`, document });
    expect(t.name).toBe(`Stripped ${S}`);
    expect(t.document.header.title).toBe('Daily gauge');
    expect(t.document.columns[0].heading).toBe('Instrument ID');
    expect(t.document.footer.text).toBe('R&D copy');
    // The logo is not text and is never touched.
    const withLogo = gaugeDoc();
    withLogo.header.logo = { mode: 'custom', dataUrl: PNG };
    const updated = await put(t.id, { document: withLogo });
    expect(updated.statusCode, updated.body).toBe(200);
    expect((updated.json() as Row).document.header.logo).toEqual({ mode: 'custom', dataUrl: PNG });
  });

  it('a save that changes nothing writes and audits nothing; a change is audited before and after', async () => {
    const t = await create({ profileId: P1, widgetType: 'bar_chart', name: `Bars ${S}`, document: builtinReportTemplate('bar_chart') });
    const same = await put(t.id, { name: `Bars ${S}`, document: builtinReportTemplate('bar_chart') });
    expect(same.statusCode, same.body).toBe(200);
    expect((same.json() as Row).updatedAt).toBe(t.updatedAt);
    expect((await auditFor(t.id)).map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED']);

    const next = builtinReportTemplate('bar_chart');
    next.columns[1].show = false;
    next.columns[0].heading = 'Bucket';
    const changed = await put(t.id, { document: next });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((changed.json() as Row).document).toEqual(next);
    const audit = await auditFor(t.id);
    expect(audit.map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_UPDATED']);
    expect(audit[1].beforeValue.document).toEqual(builtinReportTemplate('bar_chart'));
    expect(audit[1].afterValue.document).toEqual(next);
    expect(audit[1].afterValue.name).toBe(`Bars ${S}`);

    const empty = await put(t.id, {});
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.json().error).toBe('VALIDATION_ERROR');
  });

  it('set as default clears the other, each change audited under its own name', async () => {
    const one = await create({ profileId: P1, widgetType: 'alarm_counts', name: `One ${S}`, isDefault: true, document: builtinReportTemplate('alarm_counts') });
    expect(one.isDefault).toBe(true);
    const two = await create({ profileId: P1, widgetType: 'alarm_counts', name: `Two ${S}`, document: builtinReportTemplate('alarm_counts') });
    expect(two.isDefault).toBe(false);

    // The browser's shape (apiClient.put(url, {})): JSON content-type, an empty object.
    const res = await app.inject({
      method: 'PUT', url: `/api/report-templates/${two.id}/default`,
      headers: { ...sa, 'content-type': 'application/json' }, payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: two.id, isDefault: true });
    const rows = await list(`profileId=${P1}&widgetType=alarm_counts`);
    expect(rows.map((r) => [r.name, r.isDefault])).toEqual([[`One ${S}`, false], [`Two ${S}`, true]]);

    const a1 = await auditFor(one.id);
    expect(a1.map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_UPDATED']);
    expect(a1[1].beforeValue).toMatchObject({ name: `One ${S}`, isDefault: true });
    expect(a1[1].afterValue).toMatchObject({ name: `One ${S}`, isDefault: false });
    const a2 = await auditFor(two.id);
    expect(a2.map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_UPDATED']);
    expect(a2[1].afterValue).toMatchObject({ name: `Two ${S}`, isDefault: true });

    // Already the default: nothing written, nothing audited.
    const again = await setDefault(two.id);
    expect(again.statusCode).toBe(200);
    expect((await auditFor(two.id))).toHaveLength(2);

    // A create AS the default clears the current one the same way.
    const three = await create({ profileId: P1, widgetType: 'alarm_counts', name: `Three ${S}`, isDefault: true, document: builtinReportTemplate('alarm_counts') });
    expect(three.isDefault).toBe(true);
    expect((await prisma.reportTemplate.findUniqueOrThrow({ where: { id: two.id } })).isDefault).toBe(false);
    expect((await auditFor(two.id)).map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_UPDATED', 'REPORT_TEMPLATE_UPDATED']);
    expect(await prisma.reportTemplate.count({ where: { profileId: P1, widgetType: 'alarm_counts', isDefault: true } })).toBe(1);
  });

  it('deleting the default promotes nothing — resolve then answers the built-in (null)', async () => {
    const def = await create({ profileId: P2, widgetType: 'status_grid', name: `Default ${S}`, isDefault: true, document: builtinReportTemplate('status_grid') });
    const spare = await create({ profileId: P2, widgetType: 'status_grid', name: `Spare ${S}`, document: builtinReportTemplate('status_grid') });
    const before = await resolve('status_grid', [B1]);
    expect(before.statusCode, before.body).toBe(200);
    expect((before.json().sections as Section[])[0].template?.id).toBe(def.id);

    // The browser's shape (apiClient.delete(url)): JSON content-type, an empty object.
    const res = await app.inject({
      method: 'DELETE', url: `/api/report-templates/${def.id}`,
      headers: { ...sa, 'content-type': 'application/json' }, payload: {},
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe('');
    expect(await prisma.reportTemplate.findUnique({ where: { id: def.id } })).toBeNull();
    expect((await prisma.reportTemplate.findUniqueOrThrow({ where: { id: spare.id } })).isDefault).toBe(false);
    const audit = await auditFor(def.id);
    expect(audit.map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_DELETED']);
    expect(audit[1].beforeValue).toMatchObject({ profileId: P2, widgetType: 'status_grid', name: `Default ${S}`, isDefault: true });
    expect(audit[1].beforeValue.document).toEqual(builtinReportTemplate('status_grid'));

    const after = await resolve('status_grid', [B1]);
    expect(after.json().sections).toEqual([{ profileId: P2, profileName: `RT Second ${S}`, instrumentIds: [B1], template: null }]);
    expect((await list(`profileId=${P2}&widgetType=status_grid`)).map((r) => [r.name, r.isDefault])).toEqual([[`Spare ${S}`, false]]);
  });

  it("a profile's deletion takes its templates with it, each one audited", async () => {
    const P3 = await makeProfile(`RT Doomed ${S}`);
    const x = await create({ profileId: P3, widgetType: 'gauge', name: `Doomed X ${S}`, isDefault: true });
    const y = await create({ profileId: P3, widgetType: 'instrument_list', name: `Doomed Y ${S}`, document: builtinReportTemplate('instrument_list') });
    const res = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${P3}`, headers: sa });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.instrumentProfile.findUnique({ where: { id: P3 } })).toBeNull();
    expect(await prisma.reportTemplate.count({ where: { id: { in: [x.id, y.id] } } })).toBe(0);
    for (const t of [x, y]) {
      const audit = await auditFor(t.id);
      expect(audit.map((r) => r.action)).toEqual(['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_DELETED']);
      expect(audit[1].beforeValue).toMatchObject({ profileId: P3, name: t.name, widgetType: t.widgetType });
      expect(audit[1].beforeValue.document).toEqual(t.document);
      expect(audit[1].signatureMeaning).toContain(`RT Doomed ${S}`);
    }
  });

  it('the catalogue: built-in ∪ key:<k> ∪ attr:<k>, every property on the wire', async () => {
    const res = await catalogue(P1, 'gauge');
    expect(res.statusCode, res.body).toBe(200);
    const fields = (res.json() as { fields: ReportField[] }).fields;
    const builtin = fields.filter((f) => f.group === 'builtin');
    expect(builtin).toEqual(WIDGET_REPORT_FIELDS.gauge);
    expect(builtin.find((f) => f.id === 'reading.value')).toMatchObject({ perKey: true, kind: 'number' });

    const keys = fields.filter((f) => f.group === 'key');
    expect(keys).toEqual([
      { id: 'key:t', label: 'Temperature', group: 'key', kind: 'number', unit: '°C', measured: true },
      { id: 'key:rh', label: 'Humidity (rh)', group: 'key', kind: 'number', unit: expect.any(String), measured: true },
      { id: 'key:hum', label: 'Humidity (hum)', group: 'key', kind: 'number', unit: expect.any(String), measured: true },
      { id: 'key:p', label: 'Pressure', group: 'key', kind: 'number', unit: 'kPa', measured: false },
      { id: 'key:flow', label: 'flow', group: 'key', kind: 'number', measured: false },
    ]);
    expect(keys[1].unit).not.toBe('');

    const attrs = fields.filter((f) => f.group === 'attribute');
    expect(attrs).toEqual([
      { id: 'attr:Location', label: 'Location', group: 'attribute', kind: 'text' },
      { id: `attr:${ROOM_KEY}`, label: ROOM_LABEL, group: 'attribute', kind: 'text' },
      { id: 'attr:Temp Off set', label: 'Temp Off set', group: 'attribute', kind: 'text' },
    ]);
    // In order: built-in, keys, attributes.
    expect(fields.map((f) => f.group)).toEqual([...builtin.map(() => 'builtin'), ...keys.map(() => 'key'), ...attrs.map(() => 'attribute')]);

    // A sensor-offset attribute is a SUPER_ADMIN's only: absent for anyone else.
    const asReader = await catalogue(P1, 'gauge', rd);
    expect(asReader.statusCode, asReader.body).toBe(200);
    const readerIds = (asReader.json() as { fields: ReportField[] }).fields.map((f) => f.id);
    expect(readerIds).toContain('attr:Location');
    expect(readerIds).toContain('key:t');
    expect(readerIds).not.toContain('attr:Temp Off set');

    // A pie and the alarm counts list their built-ins ONLY (fix wave 2, m1): a slice or
    // a figure is never one instrument, so a key or attribute cell there is always empty.
    for (const t of ['pie_chart', 'alarm_counts'] as const) {
      const r = await catalogue(P1, t);
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as { fields: ReportField[] }).fields).toEqual(WIDGET_REPORT_FIELDS[t]);
    }
    // A widget with no field catalogue lists nothing.
    const text = await catalogue(P1, 'text_card');
    expect(text.statusCode, text.body).toBe(200);
    expect(text.json()).toEqual({ fields: [] });
    // Another type: its own built-ins, the same keys and attributes.
    const alarms = (await catalogue(P1, 'alarm_table')).json() as { fields: ReportField[] };
    expect(alarms.fields.filter((f) => f.group === 'builtin')).toEqual(WIDGET_REPORT_FIELDS.alarm_table);
    expect(alarms.fields.filter((f) => f.group === 'key').map((f) => f.id)).toEqual(keys.map((f) => f.id));

    const ghost = await catalogue(randomUUID(), 'gauge');
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error).toBe('PROFILE_NOT_FOUND');
    const nope = await catalogue(P1, 'nope');
    expect(nope.statusCode).toBe(400);
    expect(nope.json().error).toBe('VALIDATION_ERROR');
  });

  it('resolve groups by profile in instrument order and drops what the caller cannot see', async () => {
    const def = await create({ profileId: P1, widgetType: 'value_cards', name: `Cards ${S}`, isDefault: true, document: builtinReportTemplate('value_cards') });
    await create({ profileId: P1, widgetType: 'value_cards', name: `Cards spare ${S}`, document: builtinReportTemplate('value_cards') });

    const res = await resolve('value_cards', [B1, A1, randomUUID(), A2]);
    expect(res.statusCode, res.body).toBe(200);
    const sections = res.json().sections as Section[];
    expect(sections.map((x) => ({ ...x, template: x.template?.id ?? null }))).toEqual([
      { profileId: P2, profileName: `RT Second ${S}`, instrumentIds: [B1], template: null },
      { profileId: P1, profileName: `RT T&RH ${S}`, instrumentIds: [A1, A2], template: def.id },
    ]);
    // The resolved template is the whole row, document included.
    expect(sections[1].template).toEqual(def);

    // sc sees A1 and B1 by name, not A2: A2 is dropped, silently.
    const scoped = await resolve('value_cards', [A2, B1, A1], sc);
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect((scoped.json().sections as Section[]).map((x) => [x.profileId, x.instrumentIds])).toEqual([[P2, [B1]], [P1, [A1]]]);
    const hidden = await resolve('value_cards', [A2], sc);
    expect(hidden.json()).toEqual({ sections: [] });

    expect((await resolve('value_cards', [])).json()).toEqual({ sections: [] });
    for (const r of [
      await resolve('value_cards', null),
      await resolve('value_cards', ['not-a-uuid']),
      await resolve('nope', [A1]),
      await resolve('value_cards', Array.from({ length: 201 }, () => randomUUID())),
    ]) {
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toBe('VALIDATION_ERROR');
    }
  });

  it('reads need INSTRUMENT_READ and nothing more', async () => {
    const t = await create({ profileId: P2, widgetType: 'timeseries_table', name: `Series ${S}`, document: builtinReportTemplate('timeseries_table') });
    const rows = await list(`profileId=${P2}&widgetType=timeseries_table`, rd);
    expect(rows).toEqual([t]);
    const one = await app.inject({ method: 'GET', url: `/api/report-templates/${t.id}`, headers: rd });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toEqual(t);
    // Every widget type of a profile, by widget type then name.
    const all = await list(`profileId=${P2}`, rd);
    expect(all.map((r) => r.profileId).every((p) => p === P2)).toBe(true);
    expect(all.map((r) => r.id)).toContain(t.id);
    expect((await catalogue(P2, 'timeseries_table', rd)).statusCode).toBe(200);
    expect((await resolve('timeseries_table', [B1], rd)).statusCode).toBe(200);

    for (const res of [
      await app.inject({ method: 'GET', url: `/api/report-templates?profileId=${P2}`, headers: no }),
      await app.inject({ method: 'GET', url: `/api/report-templates/${t.id}`, headers: no }),
      await catalogue(P2, 'gauge', no),
      await resolve('gauge', [B1], no),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
    const badType = await app.inject({ method: 'GET', url: `/api/report-templates?widgetType=nope`, headers: rd });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toBe('VALIDATION_ERROR');
  });

  it('every write is behind the UPDATE_REPORT_TEMPLATE re-auth', async () => {
    const t = await create({ profileId: P2, widgetType: 'trend_chart', name: `Reauth ${S}`, document: builtinReportTemplate('trend_chart') });
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
    reauthBefore = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
    const policy = { ...((row?.configValue as Record<string, unknown>) ?? {}), UPDATE_REPORT_TEMPLATE: ['SUPER_ADMIN'] };
    await storeConfig('action-reauth', policy, 'security');
    invalidateReauthCache();
    try {
      const unsigned = [
        await post({ profileId: P2, widgetType: 'trend_chart', name: `Reauth new ${S}`, document: builtinReportTemplate('trend_chart') }),
        await put(t.id, { name: `Reauth B ${S}` }),
        await setDefault(t.id),
        await remove(t.id),
      ];
      for (const res of unsigned) {
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'UPDATE_REPORT_TEMPLATE' });
      }
      expect(await prisma.reportTemplate.count({ where: { name: `Reauth new ${S}` } })).toBe(0);
      expect(await prisma.reportTemplate.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ name: `Reauth ${S}`, isDefault: false });

      const signed = await post(
        { profileId: P2, widgetType: 'trend_chart', name: `Reauth new ${S}`, document: builtinReportTemplate('trend_chart'), _currentPassword: PW },
      );
      expect(signed.statusCode, signed.body).toBe(201);
      const renamed = await put(t.id, { name: `Reauth B ${S}` }, { ...sa, 'x-reauth-password': PW });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((renamed.json() as Row).name).toBe(`Reauth B ${S}`);
      // The two routes with no body schema read the password from the body too.
      const json = { ...sa, 'content-type': 'application/json' };
      const signedDefault = await app.inject({
        method: 'PUT', url: `/api/report-templates/${t.id}/default`, headers: json, payload: { _currentPassword: PW },
      });
      expect(signedDefault.statusCode, signedDefault.body).toBe(200);
      expect((signedDefault.json() as Row).isDefault).toBe(true);
      const signedDelete = await app.inject({
        method: 'DELETE', url: `/api/report-templates/${t.id}`, headers: json, payload: { _currentPassword: PW },
      });
      expect(signedDelete.statusCode, signedDelete.body).toBe(204);
      expect(await prisma.reportTemplate.findUnique({ where: { id: t.id } })).toBeNull();
    } finally {
      await restoreConfig('action-reauth', reauthBefore);
      reauthBefore = undefined;
      invalidateReauthCache();
    }
  });

  it('a widget report goes through both download routes under its own kind (widget:gauge, "Widget: Gauge")', async () => {
    const downloads = await prisma.systemConfig.findUnique({ where: { configKey: 'report-downloads' } });
    downloadsBefore = downloads ? { configValue: downloads.configValue, configType: downloads.configType, requiresReauth: downloads.requiresReauth } : null;
    const approvers = await prisma.systemConfig.findUnique({ where: { configKey: 'report-approvers' } });
    approversBefore = approvers ? { configValue: approvers.configValue, configType: approvers.configType, requiresReauth: approvers.requiresReauth } : null;
    const policyBase = (downloads?.configValue as Record<string, unknown> | undefined) ?? {};
    const signed = { ...sa, 'x-reauth-password': PW };
    try {
      // Request: the kind's policy says Request -> a review row holding the snapshot.
      await storeConfig('report-downloads', { ...policyBase, widgetGaugeMode: 'REQUEST' }, downloads?.configType ?? 'system');
      await storeConfig('report-approvers', { approverRoles: [READER], approverUserIds: [] }, approvers?.configType ?? 'system');
      const dataSnapshot = {
        version: 3, reportType: 'Widget: Gauge', title: `Gauge ${S}`, config: { showAppName: true },
        chrome: { companyName: 'Co', appName: 'App', showAppName: true, logoDataUrl: null, orientation: 'portrait' },
        sections: [{ kind: 'table', head: ['Instrument ID', 'Value'], body: [[`RT-${S}-A1`, '21.5']] }],
      };
      const request = (reportType: string) => app.inject({
        method: 'POST', url: '/api/report-reviews', headers: signed,
        payload: {
          reportKind: 'widget:gauge', reportType, title: `Gauge ${S}`, subtitle: 'Plant - Latest',
          requestMeta: { period: { label: 'Latest' }, search: 'Gauge' }, dataSnapshot, remarks: 'shift check', instrumentIds: [A1],
        },
      });
      const req = await request('Widget: Gauge');
      expect(req.statusCode, req.body).toBe(201);
      reviews.push(req.json().id);
      const stored = await prisma.reportReview.findUniqueOrThrow({ where: { id: req.json().id } });
      expect(stored).toMatchObject({ reportType: 'Widget: Gauge', title: `Gauge ${S}`, status: 'PENDING' });
      expect(stored.dataSnapshot).toEqual(dataSnapshot);
      const mismatched = await request('Widget: Pie chart');
      expect(mismatched.statusCode, mismatched.body).toBe(400);
      expect(mismatched.json().error).toBe('REPORT_TYPE_MISMATCH');

      // Direct: the kind's policy says Direct -> one REPORT_GENERATED row naming the kind.
      await storeConfig('report-downloads', { ...policyBase, widgetGaugeMode: 'DIRECT' }, downloads?.configType ?? 'system');
      const direct = (reportType: string) => app.inject({
        method: 'POST', url: '/api/audit/report-export-log', headers: signed,
        payload: { reportType, reportKind: 'widget:gauge', format: 'PDF', recordCount: 3, period: 'Latest', search: `Gauge ${S}`, remarks: 'shift check' },
      });
      const ok = await direct('Widget: Gauge');
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ success: true });
      const row = await prisma.auditTrail.findFirst({
        where: { action: 'REPORT_GENERATED', userId: NAME.sa, afterValue: { path: ['search'], equals: `Gauge ${S}` } },
        orderBy: { chainPosition: 'desc' },
      });
      expect(row).not.toBeNull();
      expect(row!.targetType).toBe('Widget: Gauge');
      expect(row!.afterValue).toMatchObject({ reportType: 'Widget: Gauge', reportKind: 'widget:gauge', format: 'PDF', recordCount: 3, remarks: 'shift check' });
      const wrong = await direct('Widget: Pie chart');
      expect(wrong.statusCode, wrong.body).toBe(400);
      expect(wrong.json().error).toBe('REPORT_TYPE_MISMATCH');
      // A Direct kind is not sent for approval.
      const notReviewed = await request('Widget: Gauge');
      expect(notReviewed.statusCode, notReviewed.body).toBe(409);
      expect(notReviewed.json().error).toBe('REPORT_IS_DIRECT');
    } finally {
      await restoreConfig('report-downloads', downloadsBefore);
      await restoreConfig('report-approvers', approversBefore);
      downloadsBefore = undefined;
      approversBefore = undefined;
    }
  });
});
