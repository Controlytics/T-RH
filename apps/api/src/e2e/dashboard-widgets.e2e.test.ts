/**
 * Built dashboard widgets on the two layout routes (widget data keys phase 2).
 *
 * What this pins, over HTTP:
 *   - a widget round-trips through `/api/config/my-config` with every inner key
 *     (Fastify strips undeclared response fields, silently);
 *   - the writer is strict (a bad widget is a 400 and nothing is stored);
 *   - an OMITTED `widgets` key keeps what is stored (an old cached browser, or a
 *     ROLE_MANAGE holder saving a role default, must not delete widgets);
 *   - only a SUPER_ADMIN changes widgets (operator 2026-10-28: "super admin only");
 *   - a role's widgets reach that role only with the `custom_widgets` panel, and
 *     still reach a user who holds a layout of their own;
 *   - on `/` a built widget never widens Panels (phase 2): an alarm counts widget
 *     and an alarm-type pie arrive (definition AND grid item) only with the
 *     `dashboard_alarms` panel, a floor plan only with `telemetry_floorplan`, and a
 *     status pie needs neither;
 *   - one bad stored widget leaves the rest of a dashboard where it was.
 *
 * Owns its roles and users; the seeded `admin` is the super admin, and its own
 * stored layout is put back FIRST in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { LAYOUT_VERSION, widgetItemId, type CustomWidget } from '@digilog/shared';

const S = Date.now().toString(36).toUpperCase();
const VIEW = `DW_VIEW_${S}`;
const MGR = `DW_MGR_${S}`;
const ROLES = [VIEW, MGR];
const PW = 'Widg3t@Passw0rd';
const users: string[] = [];
const reauth = { 'x-reauth-password': 'Admin@123' };

let app: FastifyInstance;
let sa: Record<string, string>;
let viewer: Record<string, string>;
let mgr: Record<string, string>;
let viewerId = '';
let adminId = '';
let adminLayoutBefore: Prisma.JsonValue | null = null;

const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const INSTRUMENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const W = {
  cards: {
    id: uuid(1), type: 'value_cards', title: 'Room pressures', source: { mode: 'selection' },
    keys: [{ source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa', decimals: 2, color: 3 }],
    options: {},
  },
  table: {
    id: uuid(2), type: 'latest_table', title: 'Firmware', source: { mode: 'instruments', ids: [INSTRUMENT] },
    keys: [{ source: 'attribute', key: 'Firmware', label: 'FW' }, { source: 'telemetry', key: 't' }],
    options: { pageSize: 50 },
  },
  chart: {
    id: uuid(3), type: 'trend_chart', title: 'Pressure trend', source: { mode: 'selection' },
    keys: [{ source: 'telemetry', key: 'p', color: 1 }], options: { period: '7d' },
  },
  series: {
    id: uuid(4), type: 'timeseries_table', title: 'Raw pressure', source: { mode: 'selection' },
    keys: [{ source: 'telemetry', key: 'p', decimals: 0 }], options: { period: '24h', pageSize: 10 },
  },
} satisfies Record<string, CustomWidget>;

const panelItem = (i: string, y: number) => ({ i, x: 0, y, w: 12, h: 6 });
const widgetItem = (w: CustomWidget, y: number) => ({ i: widgetItemId(w.id), x: 0, y, w: 6, h: 5 });

function withWidgets(widgets: CustomWidget[] | undefined, panels = ['telemetry_table', 'dashboard_alarms']) {
  const items = [
    ...panels.map((k, n) => panelItem(k, n * 6)),
    ...(widgets ?? []).map((w, n) => widgetItem(w, 100 + n * 5)),
  ];
  return widgets === undefined ? { version: LAYOUT_VERSION, items } : { version: LAYOUT_VERSION, items, widgets };
}

async function myLayout(headers: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url: '/api/config/my-config', headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { layout: { items: { i: string }[]; widgets?: CustomWidget[] } }).layout;
}

const putOwn = (headers: Record<string, string>, layout: unknown) =>
  app.inject({ method: 'PUT', url: '/api/config/my-dashboard-layout', headers, payload: { layout } as never });
const putRole = (headers: Record<string, string>, role: string, layout: unknown) =>
  app.inject({ method: 'PUT', url: `/api/roles/dashboard-layout/role/${role}`, headers: { ...headers, ...reauth }, payload: { layout } as never });

async function makeUser(username: string, role: string) {
  const u = await prisma.user.create({
    data: {
      username, fullName: username, role, status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
    },
  });
  users.push(u.id);
  return u;
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: VIEW, displayName: VIEW, hierarchyLevel: 2, permissions: ['INSTRUMENT_READ'] } });
  await prisma.role.create({ data: { name: MGR, displayName: MGR, hierarchyLevel: 3, permissions: ['ROLE_MANAGE', 'CONFIG_READ'] } });
  invalidateRolePermsCache();
  viewerId = (await makeUser(`dw_view_${S}`.toLowerCase(), VIEW)).id;
  await makeUser(`dw_mgr_${S}`.toLowerCase(), MGR);

  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' }, select: { id: true } });
  adminId = admin.id;
  adminLayoutBefore = (await prisma.userConfig.findUnique({ where: { userId: adminId }, select: { dashboardLayout: true } }))
    ?.dashboardLayout ?? null;

  sa = { authorization: `Bearer ${await loginAs(app)}` };
  viewer = { authorization: `Bearer ${await loginAs(app, `dw_view_${S}`.toLowerCase(), PW)}` };
  mgr = { authorization: `Bearer ${await loginAs(app, `dw_mgr_${S}`.toLowerCase(), PW)}` };
});

afterAll(async () => {
  // The seeded admin's own layout FIRST: other suites read it.
  try {
    await prisma.userConfig.updateMany({
      where: { userId: adminId },
      data: { dashboardLayout: (adminLayoutBefore ?? Prisma.DbNull) as never },
    });
  } catch { /* best effort — the rest must still run */ }
  try {
    await prisma.userConfig.deleteMany({ where: { userId: { in: users } } });
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } catch { /* best effort */ }
  try {
    await prisma.roleConfig.deleteMany({ where: { role: { in: ROLES } } });
    await prisma.role.deleteMany({ where: { name: { in: ROLES } } });
    invalidateRolePermsCache();
  } catch { /* best effort */ }
  await app.close();
});

describe('built widgets on the layout routes', () => {
  it("a super admin's widgets round-trip through my-config, every inner key included", async () => {
    const all = [W.cards, W.table, W.chart, W.series];
    const res = await putOwn(sa, withWidgets(all));
    expect(res.statusCode).toBe(200);
    const layout = await myLayout(sa);
    expect(layout.widgets).toEqual(all);
    for (const w of all) expect(layout.items.map((i) => i.i)).toContain(widgetItemId(w.id));
  });

  it('a malformed widget is a 400, and nothing is stored', async () => {
    const res = await putOwn(sa, withWidgets([W.cards, { ...W.table, title: 'Broken', keys: [] } as never]));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain('Broken');
    expect((await myLayout(sa)).widgets).toHaveLength(4);
  });

  it('an omitted widgets key keeps what is stored', async () => {
    // What an old cached browser sends after the deploy: items, no `widgets`.
    const stored = await myLayout(sa);
    const res = await putOwn(sa, { version: LAYOUT_VERSION, items: stored.items });
    expect(res.statusCode).toBe(200);
    expect((await myLayout(sa)).widgets).toEqual([W.cards, W.table, W.chart, W.series]);
  });

  it('a non-super-admin cannot change widgets, but can save the layout it has', async () => {
    const refused = await putOwn(viewer, withWidgets([W.cards]));
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { error: string }).error).toBe('WIDGETS_SUPER_ADMIN_ONLY');
    const allowed = await putOwn(viewer, withWidgets(undefined));
    expect(allowed.statusCode).toBe(200);
    await prisma.userConfig.updateMany({ where: { userId: viewerId }, data: { dashboardLayout: Prisma.DbNull } });
  });

  it("a role default's widgets reach that role only with the custom_widgets panel", async () => {
    const res = await putRole(sa, VIEW, withWidgets([W.cards]));
    expect(res.statusCode).toBe(200);

    await prisma.roleConfig.update({ where: { role: VIEW }, data: { dashboardCards: ['telemetry_table'] } });
    const without = await myLayout(viewer);
    expect(without.items.map((i) => i.i)).not.toContain(widgetItemId(W.cards.id));
    expect(without.widgets).toBeUndefined();

    await prisma.roleConfig.update({ where: { role: VIEW }, data: { dashboardCards: ['telemetry_table', 'custom_widgets'] } });
    const withPanel = await myLayout(viewer);
    expect(withPanel.items.map((i) => i.i)).toContain(widgetItemId(W.cards.id));
    expect(withPanel.widgets?.[0]?.id).toBe(W.cards.id);
  });

  it("a user holding a layout of their own still sees the role's widgets", async () => {
    // Saved before Arrange became super-admin-only; its owner cannot reset it.
    await prisma.userConfig.upsert({
      where: { userId: viewerId },
      create: { userId: viewerId, dashboardLayout: withWidgets(undefined, ['telemetry_table']) as never, updatedBy: 'test' },
      update: { dashboardLayout: withWidgets(undefined, ['telemetry_table']) as never },
    });
    const layout = await myLayout(viewer);
    expect(layout.items.map((i) => i.i)).toEqual(['telemetry_table', widgetItemId(W.cards.id)]);
    expect(layout.widgets?.map((w) => w.id)).toEqual([W.cards.id]);
  });

  it('a stored layout with one bad widget keeps everything else', async () => {
    const raw = {
      ...withWidgets([W.cards, W.chart], ['telemetry_table', 'telemetry_floorplan', 'dashboard_alarms']),
      widgets: [W.cards, { ...W.chart, type: 'pie' }],
    };
    await prisma.userConfig.update({ where: { userId: adminId }, data: { dashboardLayout: raw as never } });
    const layout = await myLayout(sa);
    expect(layout.widgets).toEqual([W.cards]);
    expect(layout.items.map((i) => i.i)).toEqual(
      expect.arrayContaining(['telemetry_table', 'telemetry_floorplan', 'dashboard_alarms', widgetItemId(W.cards.id)]),
    );
    expect(layout.items.map((i) => i.i)).not.toContain(widgetItemId(W.chart.id));
  });

  it("a ROLE_MANAGE holder who is not a super admin cannot change a role's widgets", async () => {
    const changed = await putRole(mgr, VIEW, withWidgets([{ ...W.cards, title: 'Renamed' }]));
    expect(changed.statusCode).toBe(403);
    const cleared = await putRole(mgr, VIEW, null);
    expect(cleared.statusCode).toBe(403);

    const kept = await putRole(mgr, VIEW, withWidgets(undefined, ['dashboard_alarms']));
    expect(kept.statusCode).toBe(400); // the stored widget would no longer be placed
    const role = await prisma.roleConfig.findUniqueOrThrow({ where: { role: VIEW }, select: { dashboardLayout: true } });
    const stored = role.dashboardLayout as { items: { i: string; y: number }[]; widgets: CustomWidget[] };
    const moved = await putRole(mgr, VIEW, { version: LAYOUT_VERSION, items: stored.items.map((it) => ({ ...it, y: it.y + 1 })) });
    expect(moved.statusCode).toBe(200);
    const after = await prisma.roleConfig.findUniqueOrThrow({ where: { role: VIEW }, select: { dashboardLayout: true } });
    expect((after.dashboardLayout as { widgets: CustomWidget[] }).widgets).toEqual([W.cards]);
  });

  it("a widget's title and a text card's text are stored with their HTML stripped; a widget sent back as stored is kept (R8-1)", async () => {
    const note = {
      id: uuid(5), type: 'text_card', title: '<b>Shift</b> note', source: { mode: 'selection' }, keys: [],
      options: { text: '<script>alert(1)</script>Hand over <i>at</i> 06:00\nLine 2' },
    } satisfies CustomWidget;
    const res = await putOwn(sa, withWidgets([note]));
    expect(res.statusCode, res.body).toBe(200);
    expect((await myLayout(sa)).widgets).toEqual([{ ...note, title: 'Shift note', options: { text: 'Hand over at 06:00\nLine 2' } }]);
    // Nothing but markup is refused, in the schema's words, and nothing is stored.
    const empty = await putOwn(sa, withWidgets([{ ...note, title: '<b></b>' }]));
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { message: string }).message).toBe('Widget "#1": A widget needs a title');

    // A layout stored before this rule, with markup in a widget: its holder (not
    // a super admin) saving it back unchanged is no widget change — never a 403.
    const legacy = withWidgets([{ ...W.cards, title: '<i>Legacy</i>' }]);
    await prisma.userConfig.upsert({
      where: { userId: viewerId },
      create: { userId: viewerId, dashboardLayout: legacy as never, updatedBy: 'test' },
      update: { dashboardLayout: legacy as never },
    });
    const echoed = await putOwn(viewer, legacy);
    expect(echoed.statusCode, echoed.body).toBe(200);
    await prisma.userConfig.updateMany({ where: { userId: viewerId }, data: { dashboardLayout: Prisma.DbNull } });
  });

  it("a role default's widget title and text card text are stored with their HTML stripped (R8-1, the role route)", async () => {
    const note = {
      id: uuid(6), type: 'text_card', title: '<b>Role</b> note', source: { mode: 'selection' }, keys: [],
      options: { text: '<script>alert(1)</script>Shift <i>handover</i>' },
    } satisfies CustomWidget;
    const res = await putRole(sa, VIEW, withWidgets([note]));
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.roleConfig.findUniqueOrThrow({ where: { role: VIEW }, select: { dashboardLayout: true } });
    expect((row.dashboardLayout as { widgets: CustomWidget[] }).widgets)
      .toEqual([{ ...note, title: 'Role note', options: { text: 'Shift handover' } }]);
  });

  it('on / a built widget never widens Panels: alarm counts and an alarm-type pie need dashboard_alarms, a floor plan telemetry_floorplan (phase 2, Review Focus 3)', async () => {
    const sel = { mode: 'selection' } as const;
    const counts = { id: uuid(7), type: 'alarm_counts', title: 'Alarms now', source: sel, keys: [], options: {} } satisfies CustomWidget;
    const alarmPie = { id: uuid(8), type: 'pie_chart', title: 'Alarms by type', source: sel, keys: [], options: { of: 'alarm_types' } } satisfies CustomWidget;
    const statusPie = { id: uuid(9), type: 'pie_chart', title: 'Instrument status', source: sel, keys: [], options: { of: 'status' } } satisfies CustomWidget;
    const floor = {
      id: '0000000a-0000-4000-8000-00000000000a', type: 'floorplan', title: 'QC floor', source: sel, keys: [],
      options: { planId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
    } satisfies CustomWidget;
    // Placed through the layout PUT — the role default, the only way a widget reaches a role.
    const res = await putRole(sa, VIEW, withWidgets([counts, alarmPie, statusPie, floor], ['telemetry_table', 'dashboard_alarms', 'telemetry_floorplan']));
    expect(res.statusCode, res.body).toBe(200);
    // The role's default is what this viewer gets.
    await prisma.userConfig.updateMany({ where: { userId: viewerId }, data: { dashboardLayout: Prisma.DbNull } });

    const shown = async (cards: string[]) => {
      await prisma.roleConfig.update({ where: { role: VIEW }, data: { dashboardCards: cards } });
      const layout = await myLayout(viewer);
      const ids = (layout.widgets ?? []).map((w) => w.id);
      // A widget is drawn only when its definition AND its grid item both arrive.
      expect(layout.items.filter((i) => i.i.startsWith('w:')).map((i) => i.i).sort())
        .toEqual(ids.map((id) => widgetItemId(id)).sort());
      return ids.sort();
    };

    // Built widgets, but no alarms or floor plan panel: only the status pie is drawn.
    expect(await shown(['telemetry_table', 'custom_widgets'])).toEqual([statusPie.id]);
    // With the alarms panel, the alarm counts and the alarm-type pie are drawn too.
    expect(await shown(['telemetry_table', 'custom_widgets', 'dashboard_alarms'])).toEqual([counts.id, alarmPie.id, statusPie.id].sort());
    // With the floor plan panel instead, the floor plan — and still no alarm widget.
    expect(await shown(['telemetry_table', 'custom_widgets', 'telemetry_floorplan'])).toEqual([statusPie.id, floor.id].sort());
  });
});
