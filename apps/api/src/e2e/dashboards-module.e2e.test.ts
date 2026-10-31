/**
 * `/api/dashboards` — the server behind the dashboard builder (phase 1,
 * 2026-10-29; spec docs/superpowers/specs/2026-10-29-dashboard-builder-design.md
 * §5, §6.1).
 *
 * This file used to pin the PARKED module's rules — "no assignment sees every
 * dashboard", ADMIN sees all, per-widget routes. Those rules are replaced on
 * purpose (spec §9), so this is a rewrite, not a regression. What it pins now,
 * over HTTP:
 *   - seeing a dashboard = DASHBOARD_VIEW + an assignment to the caller or their
 *     role; a SUPER_ADMIN sees every active one; no assignment means none, and
 *     anything not visible is a 404;
 *   - only a SUPER_ADMIN writes, whatever DASHBOARD_* grants the caller holds;
 *   - a save is the WHOLE document, strictly parsed, and round-trips with every
 *     inner key (Fastify strips undeclared response fields, silently);
 *   - a stale `expectedUpdatedAt` is a 409 that writes nothing;
 *   - every write is audited in its own transaction, every row naming what it
 *     is about, and no signature meaning overflows VARCHAR(255).
 *
 * Owns its super admin, roles, users, profile and locations. The one
 * `system_config` row it touches (`action-reauth`, case 13) is restored FIRST
 * in afterAll, guarded on its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { widgetItemId, type CustomWidget } from '@digilog/shared';

const S = Date.now().toString(36).toUpperCase();
const s = S.toLowerCase();
const VIEW = `DBM_VIEW_${S}`;
const MGR = `DBM_MGR_${S}`;
const ROLES = [VIEW, MGR];
const PROFILE = `DBM_P_${S}`;
const PW = 'Dashb0ard@Passw0rd';
const NAME = { sa: `dbm_sa_${s}`, v1: `dbm_v1_${s}`, v2: `dbm_v2_${s}`, m1: `dbm_m1_${s}`, ad: `dbm_ad_${s}` };
const SUPER_ADMIN_ONLY = 'Only a super admin can create, change, assign or delete dashboards.';
const CHANGED = 'This dashboard was changed by someone else. Reload it and make your change again.';
const INSTRUMENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let app: FastifyInstance;
type H = Record<string, string>;
let sa: H, v1: H, v2: H, m1: H, ad: H;
const id: Record<keyof typeof NAME, string> = { sa: '', v1: '', v2: '', m1: '', ad: '' };
let profileId = '';
const users: string[] = [];
const made: string[] = [];
const profiles: string[] = [];
const locations: string[] = [];
let reauthBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null | undefined;

interface Summary {
  id: string; title: string; description: string | null;
  sourceSummary: { mode: string; label: string }; widgetCount: number; updatedAt: string;
  assignments?: { roles: string[]; users: { id: string; username: string; fullName: string | null }[] };
}
interface Detail extends Summary { document: Record<string, unknown> & { widgets: CustomWidget[]; items: { i: string }[] } }

// ─── fixtures ────────────────────────────────────────────────────────────────

const sel = { mode: 'selection' } as const;
function widgetSet() {
  return {
    cards: {
      id: randomUUID(), type: 'value_cards', title: 'Room pressures', source: sel,
      keys: [{ source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa', decimals: 2, color: 3 }], options: {},
    },
    table: {
      id: randomUUID(), type: 'latest_table', title: 'Firmware', source: { mode: 'instruments', ids: [INSTRUMENT] },
      keys: [{ source: 'attribute', key: 'Firmware', label: 'FW' }, { source: 'telemetry', key: 't' }], options: { pageSize: 50 },
    },
    chart: {
      id: randomUUID(), type: 'trend_chart', title: 'Pressure trend', source: sel,
      keys: [{ source: 'telemetry', key: 'p', color: 1 }], options: { period: '7d' },
    },
    series: {
      id: randomUUID(), type: 'timeseries_table', title: 'Raw pressure', source: sel,
      keys: [{ source: 'telemetry', key: 'p', decimals: 0 }], options: { period: '24h', pageSize: 10 },
    },
    alarms: {
      id: randomUUID(), type: 'alarm_table', title: 'Open alarms', source: sel,
      keys: [], options: { status: 'active-unack', pageSize: 25 },
    },
  } satisfies Record<string, CustomWidget>;
}

const itemFor = (w: CustomWidget, n: number) => ({ i: widgetItemId(w.id), x: (n % 2) * 6, y: Math.floor(n / 2) * 5, w: 6, h: 5 });
function doc(widgets: CustomWidget[], over: Record<string, unknown> = {}) {
  return {
    version: 1, source: { mode: 'all' }, timeWindow: { mode: 'relative', period: '24h' },
    items: widgets.map(itemFor), widgets, ...over,
  };
}

async function makeUser(username: string, role: string) {
  const u = await prisma.user.create({
    data: {
      username, fullName: `Full ${username}`, role, status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
    },
  });
  users.push(u.id);
  return u.id;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function create(title: string, document?: unknown): Promise<Detail> {
  const res = await app.inject({ method: 'POST', url: '/api/dashboards', headers: sa, payload: { title, ...(document ? { document } : {}) } as never });
  expect(res.statusCode, res.body).toBe(201);
  made.push(res.json().id);
  return res.json();
}
const get = (dashboardId: string, headers: H = sa) => app.inject({ method: 'GET', url: `/api/dashboards/${dashboardId}`, headers });
async function detail(dashboardId: string, headers: H = sa): Promise<Detail> {
  const res = await get(dashboardId, headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
async function list(headers: H): Promise<Summary[]> {
  const res = await app.inject({ method: 'GET', url: '/api/dashboards', headers });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { data: Summary[] }).data;
}
const put = (dashboardId: string, body: Record<string, unknown>, headers: H = sa) =>
  app.inject({ method: 'PUT', url: `/api/dashboards/${dashboardId}`, headers, payload: body as never });
const assign = (dashboardId: string, roles: string[], userIds: string[], headers: H = sa) =>
  app.inject({ method: 'PUT', url: `/api/dashboards/${dashboardId}/assignments`, headers, payload: { roles, userIds } });
const remove = (dashboardId: string, headers: H = sa) => app.inject({ method: 'DELETE', url: `/api/dashboards/${dashboardId}`, headers });
const duplicate = (dashboardId: string, headers: H = sa) =>
  app.inject({ method: 'POST', url: `/api/dashboards/${dashboardId}/duplicate`, headers });

type Row = { id: string; action: string; targetType: string | null; beforeValue: any; afterValue: any; signatureMeaning: string | null };
const rowsFor = (dashboardId: string): Promise<Row[]> => prisma.auditTrail.findMany({
  where: { targetId: dashboardId },
  select: { id: true, action: true, targetType: true, beforeValue: true, afterValue: true, signatureMeaning: true },
}) as Promise<Row[]>;
/** The rows written for a dashboard since `before` was taken. */
async function newRows(dashboardId: string, before: Row[]): Promise<Row[]> {
  const seen = new Set(before.map((r) => r.id));
  return (await rowsFor(dashboardId)).filter((r) => !seen.has(r.id));
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: VIEW, displayName: VIEW, hierarchyLevel: 2, permissions: ['DASHBOARD_VIEW', 'INSTRUMENT_READ'] } });
  await prisma.role.create({
    data: { name: MGR, displayName: MGR, hierarchyLevel: 5, permissions: ['DASHBOARD_VIEW', 'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_ASSIGN'] },
  });
  invalidateRolePermsCache();
  id.sa = await makeUser(NAME.sa, 'SUPER_ADMIN');
  id.v1 = await makeUser(NAME.v1, VIEW);
  id.v2 = await makeUser(NAME.v2, VIEW);
  id.m1 = await makeUser(NAME.m1, MGR);
  // The SEEDED ADMIN role, unedited: the parked module's defect was exactly
  // `role === 'ADMIN'` seeing every dashboard. It holds DASHBOARD_VIEW there.
  id.ad = await makeUser(NAME.ad, 'ADMIN');
  profileId = (await prisma.instrumentProfile.create({ data: { name: PROFILE } })).id;
  profiles.push(profileId);

  sa = { authorization: `Bearer ${await loginAs(app, NAME.sa, PW)}` };
  v1 = { authorization: `Bearer ${await loginAs(app, NAME.v1, PW)}` };
  v2 = { authorization: `Bearer ${await loginAs(app, NAME.v2, PW)}` };
  m1 = { authorization: `Bearer ${await loginAs(app, NAME.m1, PW)}` };
  ad = { authorization: `Bearer ${await loginAs(app, NAME.ad, PW)}` };
});

afterAll(async () => {
  // The re-auth policy FIRST, guarded on its own: other suites read it.
  try {
    if (reauthBefore !== undefined) {
      if (reauthBefore) await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: reauthBefore as never });
      else await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
    }
  } catch (e) { console.error('restore action-reauth', e); } finally { invalidateReauthCache(); }
  try {
    await prisma.dashboard.deleteMany({ where: { OR: [{ id: { in: made } }, { title: { contains: S } }] } });
  } catch (e) { console.error('cleanup dashboards', e); }
  try {
    await prisma.userConfig.deleteMany({ where: { userId: { in: users } } });
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } catch (e) { console.error('cleanup users', e); }
  try {
    await prisma.role.deleteMany({ where: { name: { in: ROLES } } });
    invalidateRolePermsCache();
  } catch (e) { console.error('cleanup roles', e); }
  try { await prisma.instrumentProfile.deleteMany({ where: { id: { in: profiles } } }); } catch (e) { console.error('cleanup profiles', e); }
  try { await prisma.functionalLocation.deleteMany({ where: { id: { in: locations } } }); } catch (e) { console.error('cleanup locations', e); }
  await app.close();
});

// ─── cases ───────────────────────────────────────────────────────────────────

describe('/api/dashboards', () => {
  it('a super admin creates and lists a dashboard', async () => {
    const d = await create(`Plant ${S}`);
    expect(d.document).toEqual({ version: 1, source: { mode: 'all' }, timeWindow: { mode: 'relative', period: '24h' }, items: [], widgets: [] });
    expect(d.assignments).toEqual({ roles: [], users: [] });
    const row = (await list(sa)).find((r) => r.id === d.id);
    expect(row).toBeDefined();
    expect(row!.title).toBe(`Plant ${S}`);
    expect(row!.description).toBeNull();
    expect(row!.sourceSummary).toEqual({ mode: 'all', label: 'All instruments' });
    expect(row!.widgetCount).toBe(0);
    expect(row!.assignments).toEqual({ roles: [], users: [] });
    expect(Date.parse(row!.updatedAt)).toBe(Date.parse(d.updatedAt));
    expect(row).not.toHaveProperty('document');

    // Ordered by title, ignoring case.
    const z = await create(`zeta ${S}`);
    const a = await create(`Alpha ${S}`);
    const b = await create(`beta ${S}`);
    const order = (await list(sa)).map((r) => r.id).filter((x) => [z.id, a.id, b.id].includes(x));
    expect(order).toEqual([a.id, b.id, z.id]);
  });

  it('an unassigned viewer sees none', async () => {
    const d = await create(`Unassigned ${S}`);
    expect(await list(v1)).toEqual([]);
    const res = await get(d.id, v1);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('DASHBOARD_NOT_FOUND');
    // Every DASHBOARD_* grant is not an exception, and neither is ADMIN.
    expect((await list(m1)).map((r) => r.id)).not.toContain(d.id);
    expect((await get(d.id, m1)).statusCode).toBe(404);
    expect((await list(ad)).map((r) => r.id)).not.toContain(d.id);
    expect((await get(d.id, ad)).statusCode).toBe(404);
    // Positive control: the super admin sees it.
    expect((await get(d.id, sa)).statusCode).toBe(200);
  });

  it('assignment by role and by user', async () => {
    const d = await create(`Assigned ${S}`);
    const byRole = await assign(d.id, [VIEW], []);
    expect(byRole.statusCode, byRole.body).toBe(200);
    expect(byRole.json()).toEqual({ roles: [VIEW], users: [] });
    for (const h of [v1, v2]) {
      const rows = await list(h);
      expect(rows.map((r) => r.id)).toEqual([d.id]);
      expect(rows[0]).not.toHaveProperty('assignments');
      const one = await detail(d.id, h);
      expect(one).not.toHaveProperty('assignments');
      expect(one.document.version).toBe(1);
    }

    const byUser = await assign(d.id, [], [id.m1]);
    expect(byUser.statusCode, byUser.body).toBe(200);
    expect(byUser.json()).toEqual({ roles: [], users: [{ id: id.m1, username: NAME.m1, fullName: `Full ${NAME.m1}` }] });
    expect(await list(v1)).toEqual([]);
    expect((await get(d.id, v1)).statusCode).toBe(404);
    expect((await list(m1)).map((r) => r.id)).toContain(d.id);
    expect((await get(d.id, m1)).statusCode).toBe(200);
    expect((await detail(d.id)).assignments).toEqual({ roles: [], users: [{ id: id.m1, username: NAME.m1, fullName: `Full ${NAME.m1}` }] });

    // An unknown role or user is a 400 naming the first one, and writes nothing.
    const badRole = await assign(d.id, [VIEW, `NOBODY_${S}`], []);
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json().message).toContain(`NOBODY_${S}`);
    const ghost = randomUUID();
    const badUser = await assign(d.id, [], [ghost]);
    expect(badUser.statusCode).toBe(400);
    expect(badUser.json().message).toContain(ghost);
    expect((await detail(d.id)).assignments!.users.map((u) => u.id)).toEqual([id.m1]);
  });

  it('a manager with every DASHBOARD_* grant still cannot write', async () => {
    const d = await create(`Guarded ${S}`);
    await assign(d.id, [MGR], []);
    const before = await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id } });
    const attempts = [
      await app.inject({ method: 'POST', url: '/api/dashboards', headers: m1, payload: { title: `Hijack ${S}` } }),
      await put(d.id, { title: `Hijack ${S}`, expectedUpdatedAt: d.updatedAt }, m1),
      await duplicate(d.id, m1),
      await remove(d.id, m1),
      await assign(d.id, [MGR, VIEW], [id.m1], m1),
    ];
    for (const res of attempts) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ error: 'DASHBOARDS_SUPER_ADMIN_ONLY', message: SUPER_ADMIN_ONLY });
    }
    const after = await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.title).toBe(`Guarded ${S}`);
    expect(after.isActive).toBe(true);
    expect(await prisma.dashboard.count({ where: { title: { startsWith: `Hijack ${S}` } } })).toBe(0);
    expect(await prisma.dashboard.count({ where: { title: `Guarded ${S} (copy)` } })).toBe(0);
    expect((await detail(d.id)).assignments).toEqual({ roles: [MGR], users: [] });

    // The role check is FIRST: before the 404 on a dashboard m1 cannot see, and
    // before the body and the path are validated.
    const hidden = await create(`Guarded hidden ${S}`);
    const first = [
      await put(hidden.id, { title: `Hijack ${S}`, expectedUpdatedAt: hidden.updatedAt }, m1),
      await duplicate(hidden.id, m1),
      await remove(hidden.id, m1),
      await assign(hidden.id, [MGR], [], m1),
      await put(hidden.id, { title: `Hijack ${S}` }, m1), // no expectedUpdatedAt
      await app.inject({ method: 'PUT', url: '/api/dashboards/not-a-uuid', headers: m1, payload: { title: 'x', expectedUpdatedAt: hidden.updatedAt } }),
      await assign(hidden.id, [MGR], ['not-a-uuid'], m1),
      await app.inject({ method: 'POST', url: '/api/dashboards', headers: m1, payload: { title: '' } }),
    ];
    for (const res of first) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe('DASHBOARDS_SUPER_ADMIN_ONLY');
    }
    expect((await detail(hidden.id)).updatedAt).toBe(hidden.updatedAt);
  });

  it('the document round-trips', async () => {
    const d = await create(`Round trip ${S}`);
    const w = widgetSet();
    const all = [w.cards, w.table, w.chart, w.series, w.alarms];
    const sent = doc(all, {
      source: { mode: 'profile', profileId },
      timeWindow: { mode: 'fixed', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T06:30:00.000Z' },
    });
    (sent.items[1] as Record<string, unknown>).style = { tint: 'sky', title: 'Custom heading' };
    const res = await put(d.id, { document: sent, expectedUpdatedAt: d.updatedAt });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as Detail).document).toEqual(sent);
    const back = await detail(d.id);
    expect(back.document).toEqual(sent);
    expect(back.widgetCount).toBe(5);
    expect(back.sourceSummary).toEqual({ mode: 'profile', label: PROFILE });
  });

  it('an unchanged save of an item with a multi-key style writes nothing, whatever order the database keeps the keys in', async () => {
    const d = await create(`Style order ${S}`);
    const w = widgetSet();
    const sent = doc([w.cards]);
    // Sent in the reverse of the canonical order; JSONB then keeps its own (length, then alphabet).
    (sent.items[0] as Record<string, unknown>).style = { title: 'Custom', pad: 'tight', size: 'large', tint: 'sky' };
    const first = await put(d.id, { document: sent, expectedUpdatedAt: d.updatedAt });
    expect(first.statusCode, first.body).toBe(200);
    const saved = first.json() as Detail;
    expect(Object.keys((saved.document.items[0] as { style: object }).style)).toHaveLength(4);
    const rowBefore = await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id }, select: { layout: true, updatedAt: true } });
    const auditBefore = (await rowsFor(d.id)).length;

    // The editor sends back what it loaded: the same document, the same keys.
    const again = await put(d.id, { document: (await detail(d.id)).document, expectedUpdatedAt: saved.updatedAt });
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as Detail).updatedAt).toBe(saved.updatedAt);
    expect((await rowsFor(d.id)).length).toBe(auditBefore);
    const rowAfter = await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id }, select: { layout: true, updatedAt: true } });
    expect(rowAfter.updatedAt.getTime()).toBe(rowBefore.updatedAt.getTime());
  });

  it('a bad document is a 400 and nothing is stored', async () => {
    const w = widgetSet();
    const d = await create(`Bad doc ${S}`, doc([w.cards]));
    const stored = await detail(d.id);
    const storedRow = await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id }, select: { layout: true, updatedAt: true } });
    const cases: [unknown, string][] = [
      [doc([], { items: [{ i: 'telemetry_table', x: 0, y: 0, w: 6, h: 5 }] }), 'Only widgets can be placed on a dashboard'],
      [doc([w.cards, w.chart], { items: [itemFor(w.cards, 0)] }), `Widget "${w.chart.title}" is not placed`],
      [doc([w.cards], { source: { mode: 'profile', profileId: 'not-a-uuid' } }), 'Dashboard profile: Not a profile id'],
    ];
    for (const [document, message] of cases) {
      const res = await put(d.id, { document, expectedUpdatedAt: d.updatedAt });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', message });
    }
    const now = await detail(d.id);
    expect(now.document).toEqual(stored.document);
    expect(now.updatedAt).toBe(stored.updatedAt);
    // At the row too, so this cannot pass on what the response schema lets through.
    expect(await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id }, select: { layout: true, updatedAt: true } })).toEqual(storedRow);

    // A create with a bad document creates nothing.
    const refused = await app.inject({ method: 'POST', url: '/api/dashboards', headers: sa, payload: { title: `Bad create ${S}`, document: cases[0][0] } as never });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'VALIDATION_ERROR', message: 'Only widgets can be placed on a dashboard' });
    expect(await prisma.dashboard.count({ where: { title: `Bad create ${S}` } })).toBe(0);
    // A title that is blank once trimmed is refused too.
    expect((await put(d.id, { title: '   ', expectedUpdatedAt: d.updatedAt })).statusCode).toBe(400);
  });

  it("a widget's title and a text card's text are stored with their HTML stripped (R8-1)", async () => {
    const note = {
      id: randomUUID(), type: 'text_card', title: '<b>Shift</b> note', source: sel, keys: [],
      options: { text: '<script>alert(1)</script>Hand over <i>at</i> 06:00\nLine 2' },
    } satisfies CustomWidget;
    const clean = { ...note, title: 'Shift note', options: { text: 'Hand over at 06:00\nLine 2' } };
    // A create carrying a document, and a save.
    const made = await create(`Strip ${S}`, doc([note]));
    expect((await detail(made.id)).document.widgets).toEqual([clean]);
    const d = await create(`Strip save ${S}`);
    const res = await put(d.id, { document: doc([note]), expectedUpdatedAt: d.updatedAt });
    expect(res.statusCode, res.body).toBe(200);
    expect((await detail(d.id)).document.widgets).toEqual([clean]);
    // At the row too, so this cannot pass on what the response schema lets through.
    const row = await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id }, select: { layout: true } });
    expect((row.layout as { widgets: CustomWidget[] }).widgets).toEqual([clean]);
    // Nothing but markup is refused, in the schema's words.
    const empty = await put(d.id, { document: doc([{ ...note, options: { text: '<b></b>' } }]), expectedUpdatedAt: res.json().updatedAt });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: 'VALIDATION_ERROR', message: 'Widget "Shift note": Write the card\'s text' });
  });

  it('a stale expectedUpdatedAt is a 409', async () => {
    const d = await create(`Stale ${S}`);
    const first = await put(d.id, { title: `Stale A ${S}`, expectedUpdatedAt: d.updatedAt });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().updatedAt).not.toBe(d.updatedAt);
    const before = await rowsFor(d.id);

    const w = widgetSet();
    const stale = await put(d.id, { title: `Stale B ${S}`, document: doc([w.cards]), expectedUpdatedAt: d.updatedAt });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'DASHBOARD_CHANGED', message: CHANGED });
    const now = await detail(d.id);
    expect(now.title).toBe(`Stale A ${S}`);
    expect(now.widgetCount).toBe(0);
    expect(now.updatedAt).toBe(first.json().updatedAt);
    expect(await newRows(d.id, before)).toEqual([]);

    // The current one is accepted.
    expect((await put(d.id, { title: `Stale C ${S}`, expectedUpdatedAt: now.updatedAt })).statusCode).toBe(200);

    // A stamp with microseconds (any writer but Prisma) still matches the
    // millisecond the GET served: the column is TIMESTAMPTZ(6), the wire is ms.
    await prisma.$executeRaw`UPDATE dashboards SET updated_at = date_trunc('milliseconds', now()) + interval '437 microseconds' WHERE id = ${d.id}::uuid`;
    const micro = await detail(d.id);
    const ok = await put(d.id, { title: `Stale D ${S}`, expectedUpdatedAt: micro.updatedAt });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().title).toBe(`Stale D ${S}`);
  });

  it('every write is audited with a name', async () => {
    const w = widgetSet();
    const W1 = w.cards;
    const W2 = w.chart;
    const W3 = w.series;
    const title = `Audited ${S}`;
    const d = await create(title, doc([W2, W3]));

    const created = await rowsFor(d.id);
    const createdRow = created.filter((r) => r.action === 'DASHBOARD_CREATED');
    expect(createdRow).toHaveLength(1);
    expect(createdRow[0].afterValue).toMatchObject({ name: title, description: null, source: { mode: 'all' }, widgetCount: 2 });
    const initialWidgets = created.filter((r) => r.action === 'DASHBOARD_WIDGET_CREATED');
    expect(initialWidgets.map((r) => r.afterValue.name).sort()).toEqual([W2.title, W3.title].sort());
    for (const r of initialWidgets) expect(r.afterValue.dashboard).toBe(title);

    // Add W1, relabel W2, remove W3.
    let cur = await detail(d.id);
    let before = await rowsFor(d.id);
    const W2b = { ...W2, keys: [{ ...W2.keys[0], label: 'Relabelled' }] };
    const edit = await put(d.id, { document: doc([W2b, W1]), expectedUpdatedAt: cur.updatedAt });
    expect(edit.statusCode, edit.body).toBe(200);
    let rows = await newRows(d.id, before);
    const of = (action: string) => rows.filter((r) => r.action === action);
    expect(of('DASHBOARD_WIDGET_CREATED')).toHaveLength(1);
    expect(of('DASHBOARD_WIDGET_CREATED')[0].afterValue).toMatchObject({ name: W1.title, dashboard: title, widget: { id: W1.id } });
    expect(of('DASHBOARD_WIDGET_UPDATED')).toHaveLength(1);
    expect(of('DASHBOARD_WIDGET_UPDATED')[0].beforeValue).toMatchObject({ name: W2.title, widget: { id: W2.id } });
    expect(of('DASHBOARD_WIDGET_UPDATED')[0].afterValue).toMatchObject({ name: W2.title, widget: { keys: [{ label: 'Relabelled' }] } });
    expect(of('DASHBOARD_WIDGET_DELETED')).toHaveLength(1);
    expect(of('DASHBOARD_WIDGET_DELETED')[0].beforeValue).toMatchObject({ name: W3.title, dashboard: title, widget: { id: W3.id } });
    expect(of('DASHBOARD_UPDATED')).toHaveLength(1);
    expect(of('DASHBOARD_UPDATED')[0].beforeValue).toMatchObject({ name: title, widgetCount: 2 });
    expect(of('DASHBOARD_UPDATED')[0].afterValue).toMatchObject({ name: title, widgetCount: 2 });

    // A move-only save writes DASHBOARD_UPDATED alone.
    cur = await detail(d.id);
    before = await rowsFor(d.id);
    const moved = doc([W2b, W1]);
    moved.items = moved.items.map((it) => ({ ...it, y: it.y + 10 }));
    expect((await put(d.id, { document: moved, expectedUpdatedAt: cur.updatedAt })).statusCode).toBe(200);
    rows = await newRows(d.id, before);
    expect(rows.map((r) => r.action)).toEqual(['DASHBOARD_UPDATED']);
    expect(rows[0].beforeValue.name).toBe(title);
    expect(rows[0].afterValue.name).toBe(title);
    expect(rows[0].afterValue.items).not.toEqual(rows[0].beforeValue.items);

    // An unchanged save writes nothing.
    cur = await detail(d.id);
    before = await rowsFor(d.id);
    const same = await put(d.id, { title, description: null, document: moved, expectedUpdatedAt: cur.updatedAt });
    expect(same.statusCode).toBe(200);
    expect(same.json().updatedAt).toBe(cur.updatedAt);
    expect(await newRows(d.id, before)).toEqual([]);

    // Assignments: one row per role or user added or removed.
    before = await rowsFor(d.id);
    expect((await assign(d.id, [VIEW, MGR], [id.v1])).statusCode).toBe(200);
    rows = await newRows(d.id, before);
    expect(rows.map((r) => r.action)).toEqual(['DASHBOARD_ASSIGNED', 'DASHBOARD_ASSIGNED', 'DASHBOARD_ASSIGNED']);
    for (const r of rows) expect(r.afterValue.name).toBe(title);
    expect(rows.map((r) => r.afterValue.assignee)).toEqual(expect.arrayContaining([
      { type: 'ROLE', role: VIEW }, { type: 'ROLE', role: MGR }, { type: 'USER', userId: id.v1, username: NAME.v1 },
    ]));
    before = await rowsFor(d.id);
    expect((await assign(d.id, [MGR], [id.v2])).statusCode).toBe(200);
    rows = await newRows(d.id, before);
    const added = rows.filter((r) => r.action === 'DASHBOARD_ASSIGNED');
    const removed = rows.filter((r) => r.action === 'DASHBOARD_UNASSIGNED');
    expect(rows).toHaveLength(3);
    expect(added.map((r) => r.afterValue)).toEqual([{ name: title, assignee: { type: 'USER', userId: id.v2, username: NAME.v2 } }]);
    expect(removed.map((r) => r.beforeValue)).toEqual(expect.arrayContaining([
      { name: title, assignee: { type: 'ROLE', role: VIEW } },
      { name: title, assignee: { type: 'USER', userId: id.v1, username: NAME.v1 } },
    ]));
    expect(removed).toHaveLength(2);
    before = await rowsFor(d.id);
    expect((await assign(d.id, [MGR], [id.v2])).statusCode).toBe(200);
    expect(await newRows(d.id, before)).toEqual([]);

    // Delete.
    before = await rowsFor(d.id);
    const del = await remove(d.id);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });
    rows = await newRows(d.id, before);
    expect(rows.map((r) => r.action)).toEqual(['DASHBOARD_DELETED']);
    expect(rows[0].beforeValue.name).toBe(title);

    for (const r of await rowsFor(d.id)) {
      expect(r.targetType).toBe('dashboard');
      expect(r.signatureMeaning!.length).toBeLessThanOrEqual(255);
    }
  });

  it('a save that only reorders the widget list writes nothing', async () => {
    // The order of `widgets` means nothing (the items place them) and nothing
    // audits it, so a save that changes only that order must not write: a
    // committed change with no audit row, and a second editor's honest save
    // turned into a 409.
    const w = widgetSet();
    const sent = doc([w.cards, w.chart, w.alarms]);
    const d = await create(`Reordered ${S}`, sent);
    const rowBefore = await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id }, select: { layout: true, updatedAt: true } });
    const before = await rowsFor(d.id);
    const res = await put(d.id, { document: { ...sent, widgets: [...sent.widgets].reverse() }, expectedUpdatedAt: d.updatedAt });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updatedAt).toBe(d.updatedAt);
    expect(await newRows(d.id, before)).toEqual([]);
    expect(await prisma.dashboard.findUniqueOrThrow({ where: { id: d.id }, select: { layout: true, updatedAt: true } })).toEqual(rowBefore);
  });

  it('a deleted dashboard is gone', async () => {
    const d = await create(`Deleted ${S}`);
    expect((await remove(d.id)).statusCode).toBe(200);
    for (const res of [await get(d.id, sa), await put(d.id, { title: `X ${S}`, expectedUpdatedAt: d.updatedAt }), await remove(d.id), await assign(d.id, [VIEW], []), await duplicate(d.id)]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error).toBe('DASHBOARD_NOT_FOUND');
    }
    expect((await list(sa)).map((r) => r.id)).not.toContain(d.id);
    expect((await rowsFor(d.id)).filter((r) => r.action === 'DASHBOARD_DELETED')).toHaveLength(1);
    expect(await prisma.dashboardAssignment.count({ where: { dashboardId: d.id } })).toBe(0);
  });

  it('duplicate', async () => {
    const w = widgetSet();
    const title = `Original ${S}`;
    const d = await create(title, doc([w.cards, w.chart, w.alarms], { source: { mode: 'profile', profileId } }));
    await assign(d.id, [MGR], [id.v2]);
    const original = await detail(d.id);

    const res = await duplicate(d.id);
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json() as Detail;
    made.push(copy.id);
    expect(copy.id).not.toBe(d.id);
    expect(copy.title).toBe(`${title} (copy)`);
    expect(copy.assignments).toEqual({ roles: [], users: [] });
    expect(copy.sourceSummary).toEqual(original.sourceSummary);
    const oldIds = new Set(original.document.widgets.map((x) => x.id));
    expect(copy.document.widgets).toHaveLength(3);
    for (const cw of copy.document.widgets) expect(oldIds.has(cw.id)).toBe(false);
    expect(new Set(copy.document.widgets.map((x) => x.id)).size).toBe(3);
    expect(copy.document.items.map((it) => it.i).sort()).toEqual(copy.document.widgets.map((x) => widgetItemId(x.id)).sort());
    // Everything but the ids is the original's, in the same places.
    const strip = (x: Detail) => ({
      ...x.document,
      widgets: x.document.widgets.map(({ id: _id, ...rest }) => rest),
      items: x.document.items.map(({ i: _i, ...rest }) => rest),
    });
    expect(strip(copy)).toEqual(strip(original));
    expect((await detail(copy.id)).document).toEqual(copy.document);

    const after = await detail(d.id);
    expect(after.document).toEqual(original.document);
    expect(after.updatedAt).toBe(original.updatedAt);
    expect(after.assignments).toEqual(original.assignments);

    const createdRow = (await rowsFor(copy.id)).filter((r) => r.action === 'DASHBOARD_CREATED');
    expect(createdRow).toHaveLength(1);
    expect(createdRow[0].afterValue.name).toBe(`${title} (copy)`);
    expect((await rowsFor(copy.id)).filter((r) => r.action === 'DASHBOARD_WIDGET_CREATED')).toHaveLength(3);

    // A copy of a 200-character title stays within 200 and still says so.
    const long = await create(`${S}${'L'.repeat(200 - S.length)}`);
    const longCopy = await duplicate(long.id);
    expect(longCopy.statusCode, longCopy.body).toBe(201);
    made.push(longCopy.json().id);
    expect(longCopy.json().title).toHaveLength(200);
    expect(longCopy.json().title.endsWith(' (copy)')).toBe(true);
  });

  it('a duplicate is a NEW write: legacy markup is stripped from the copy and its audit row, the source untouched (fix round 1, M-8)', async () => {
    // A row stored before widget text was stripped on write, seeded directly.
    const note = {
      id: randomUUID(), type: 'text_card', title: '<b>Legacy</b> note', source: sel, keys: [],
      options: { text: '<i>Hand over</i> at 06:00' },
    } satisfies CustomWidget;
    const legacy = doc([note]);
    const src = await prisma.dashboard.create({ data: { title: `Legacy ${S}`, layout: legacy as never, createdBy: id.sa } });
    made.push(src.id);

    const res = await duplicate(src.id);
    expect(res.statusCode, res.body).toBe(201);
    const copyId = (res.json() as Detail).id;
    made.push(copyId);
    const [copied] = (await detail(copyId)).document.widgets;
    expect(copied).toMatchObject({ type: 'text_card', title: 'Legacy note', options: { text: 'Hand over at 06:00' } });
    expect(copied.id).not.toBe(note.id);
    const widgetRow = (await rowsFor(copyId)).find((r) => r.action === 'DASHBOARD_WIDGET_CREATED')!;
    expect(widgetRow.afterValue.name).toBe('Legacy note');
    expect(widgetRow.afterValue.widget.options.text).toBe('Hand over at 06:00');
    // The source keeps exactly what it had.
    const srcRow = await prisma.dashboard.findUniqueOrThrow({ where: { id: src.id }, select: { layout: true } });
    expect((srcRow.layout as { widgets: CustomWidget[] }).widgets).toEqual([note]);

    // A legacy widget that is nothing but markup cannot be copied: a 400, and nothing is created.
    const bad = await prisma.dashboard.create({
      data: { title: `Legacy bad ${S}`, layout: doc([{ ...note, id: randomUUID(), title: '<b></b>' }]) as never, createdBy: id.sa },
    });
    made.push(bad.id);
    const refused = await duplicate(bad.id);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'VALIDATION_ERROR', message: 'Widget "#1": A widget needs a title' });
    expect(await prisma.dashboard.count({ where: { title: `Legacy bad ${S} (copy)` } })).toBe(0);
  });

  it('a source naming a deleted profile is summarised as gone', async () => {
    const temp = await prisma.instrumentProfile.create({ data: { name: `DBM_TMP_${S}` } });
    profiles.push(temp.id);
    const d = await create(`Temp profile ${S}`, doc([], { source: { mode: 'profile', profileId: temp.id } }));
    expect(d.sourceSummary).toEqual({ mode: 'profile', label: `DBM_TMP_${S}` });
    await prisma.instrumentProfile.delete({ where: { id: temp.id } });
    expect((await list(sa)).find((r) => r.id === d.id)!.sourceSummary).toEqual({ mode: 'profile', label: 'Profile no longer exists' });
    expect((await detail(d.id)).sourceSummary).toEqual({ mode: 'profile', label: 'Profile no longer exists' });
  });

  it('long titles never overflow signature_meaning', async () => {
    const title = `${S}${'T'.repeat(200 - S.length)}`;
    const w = widgetSet();
    const big = { ...w.cards, title: `${'W'.repeat(79)}1` };
    const res = await app.inject({ method: 'POST', url: '/api/dashboards', headers: sa, payload: { title, document: doc([big]) } as never });
    expect(res.statusCode, res.body).toBe(201);
    const d = res.json() as Detail;
    made.push(d.id);
    expect(d.title).toBe(title);

    const title2 = `${S}${'U'.repeat(200 - S.length)}`;
    const big2 = { ...big, title: `${'V'.repeat(79)}2` };
    const big3 = { ...w.chart, title: `${'X'.repeat(79)}3` };
    const upd = await put(d.id, { title: title2, document: doc([big2, big3]), expectedUpdatedAt: d.updatedAt });
    expect(upd.statusCode, upd.body).toBe(200);
    const after = await detail(d.id);
    expect((await assign(d.id, [VIEW], [id.v2])).statusCode).toBe(200);
    expect((await duplicate(d.id)).statusCode).toBe(201);
    expect((await put(d.id, { document: doc([]), expectedUpdatedAt: after.updatedAt })).statusCode).toBe(200);
    expect((await assign(d.id, [], [])).statusCode).toBe(200);
    expect((await remove(d.id)).statusCode).toBe(200);
    for (const r of await rowsFor(d.id)) expect(r.signatureMeaning!.length, r.action).toBeLessThanOrEqual(255);
  });

  it('re-auth', async () => {
    const d = await create(`Reauth ${S}`);
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
    reauthBefore = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
    const policy = { ...((row?.configValue as Record<string, unknown>) ?? {}), UPDATE_DASHBOARD: ['SUPER_ADMIN'] };
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      update: { configValue: policy as never },
      create: { configKey: 'action-reauth', configValue: policy as never, configType: 'security', requiresReauth: false },
    });
    invalidateReauthCache();
    try {
      const refused = await put(d.id, { title: `Reauth B ${S}`, expectedUpdatedAt: d.updatedAt });
      expect(refused.statusCode, refused.body).toBe(401);
      expect(refused.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'UPDATE_DASHBOARD' });
      expect((await detail(d.id)).title).toBe(`Reauth ${S}`);
      // Every other write route is behind the same action.
      const unsigned = [
        await app.inject({ method: 'POST', url: '/api/dashboards', headers: sa, payload: { title: `Reauth new ${S}` } }),
        await duplicate(d.id),
        await assign(d.id, [VIEW], []),
        await remove(d.id),
      ];
      for (const res of unsigned) {
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'UPDATE_DASHBOARD' });
      }
      expect(await prisma.dashboard.count({ where: { title: { in: [`Reauth new ${S}`, `Reauth ${S} (copy)`] } } })).toBe(0);
      expect((await detail(d.id)).assignments).toEqual({ roles: [], users: [] });

      const signed = await put(d.id, { title: `Reauth B ${S}`, expectedUpdatedAt: d.updatedAt }, { ...sa, 'x-reauth-password': PW });
      expect(signed.statusCode, signed.body).toBe(200);
      expect((await detail(d.id)).title).toBe(`Reauth B ${S}`);
    } finally {
      if (reauthBefore) await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: reauthBefore as never });
      else await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
      reauthBefore = undefined;
      invalidateReauthCache();
    }
  });

  it('every source mode is summarised', async () => {
    const block = await prisma.functionalLocation.create({ data: { name: `DBM Block ${S}`, type: 'BLOCK' } });
    locations.push(block.id);
    const gone = await prisma.functionalLocation.create({ data: { name: `DBM Gone ${S}`, type: 'BLOCK' } });
    locations.push(gone.id);
    const cases: [unknown, { mode: string; label: string }][] = [
      [{ mode: 'location', functionalLocationId: block.id }, { mode: 'location', label: `DBM Block ${S}` }],
      [{ mode: 'location', functionalLocationId: block.id, directOnly: true }, { mode: 'location', label: `DBM Block ${S} (direct only)` }],
      [{ mode: 'location', functionalLocationId: gone.id }, { mode: 'location', label: 'Location no longer exists' }],
      [{ mode: 'instruments', ids: [INSTRUMENT, randomUUID()] }, { mode: 'instruments', label: '2 instruments' }],
      [{ mode: 'instruments', ids: [INSTRUMENT] }, { mode: 'instruments', label: '1 instrument' }],
    ];
    const ids: string[] = [];
    for (const [n, [source]] of cases.entries()) ids.push((await create(`Source ${n} ${S}`, doc([], { source }))).id);
    await prisma.functionalLocation.delete({ where: { id: gone.id } });
    // An unreadable stored source reads as unreadable, never as every instrument.
    const corrupt = await create(`Source corrupt ${S}`);
    await prisma.dashboard.update({ where: { id: corrupt.id }, data: { layout: { version: 1, source: { mode: 'nope' }, items: [], widgets: [] } } });

    const rows = await list(sa);
    for (const [n, [, summary]] of cases.entries()) expect(rows.find((r) => r.id === ids[n])!.sourceSummary).toEqual(summary);
    expect(rows.find((r) => r.id === corrupt.id)!.sourceSummary).toEqual({ mode: 'unreadable', label: 'Instruments could not be read' });
    const c = await detail(corrupt.id);
    expect(c.sourceSummary).toEqual({ mode: 'unreadable', label: 'Instruments could not be read' });
    expect(c.document.source).toBeNull();
  });
});
