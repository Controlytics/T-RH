import { describe, it, expect } from 'vitest';
import { FEATURE_TO_PERMISSION_MAP, SIDEBAR_ITEMS, privilegeTogglesFromPermissions, rebuildRolePermissions } from '@digilog/shared';
import { heldToggles, heldCaption } from '../held-toggles';

/**
 * 2026-11-03, operator: "for some permissions, after un-selecting them and
 * saving, those are not updating". What a save will bring back ON, and what
 * holds it — by the server's own two functions.
 */
const IDS = Object.keys(FEATURE_TO_PERMISSION_MAP);
const allOnExcept = (id: string) => Object.fromEntries(IDS.map(t => [t, t !== id]));
const SIDEBAR_IDS = SIDEBAR_ITEMS.map(i => i.id);

describe('heldToggles — which un-selected toggles come straight back ON', () => {
  // Eleven until 2026-11-03; rule chains added `rule_chains.view`, held by
  // `rule_chains.manage` (whose grant carries RULE_CHAIN_READ) like every View.
  it('with every other toggle ON, exactly these twelve come back', () => {
    const back = IDS.filter(id => heldToggles(allOnExcept(id), []).shown[id]).sort();
    expect(back).toEqual([
      'alarm_webhooks.view', 'alarms.view', 'audit.view', 'config.view', 'data_report.view',
      'functional_locations.view', 'instruments.view', 'reports.view', 'rule_chains.view', 'settings.edit', 'settings.view',
      'users.view',
    ]);
  });

  it('`shown` is the server\'s answer: rebuild, then read back', () => {
    const toggles = { 'users.edit': true, 'users.view': false, 'instruments.edit': true };
    const sidebar = ['alarms', 'admin-requests'];
    expect(heldToggles(toggles, sidebar).shown).toEqual(
      privilegeTogglesFromPermissions(rebuildRolePermissions({ currentPermissions: [], toggles, sidebarItems: sidebar })));
  });

  it('a toggle that is ON is never "held", and nothing is held with nothing selected', () => {
    expect(heldToggles({ 'users.view': true, 'users.edit': true }, []).heldBy).toEqual({});
    expect(heldToggles({}, []).heldBy).toEqual({});
  });

  it('the admin-requests menu holds nothing — its Approve / Reject stay revocable', () => {
    expect(heldToggles({}, ['admin-requests']).heldBy).toEqual({});
  });
});

describe('heldToggles — what holds it, named', () => {
  it('names EVERY toggle that holds it, not only one — View Users under Create and Edit Users', () => {
    const h = heldToggles({ 'users.view': false, 'users.create': true, 'users.edit': true }, []);
    expect(h.heldBy['users.view']).toEqual({ toggles: ['users.create', 'users.edit'], sidebarItems: [], outside: [] });
    expect(heldCaption(h.heldBy['users.view'])).toBe('Held by Create Users, Edit Users');
  });

  it('names every sidebar item that holds it — View Instruments under Data Report and Settings', () => {
    const h = heldToggles({}, ['data-report', 'settings']);
    expect(h.heldBy['instruments.view']).toEqual({ toggles: [], sidebarItems: ['data-report', 'settings'], outside: [] });
    expect(heldCaption(h.heldBy['instruments.view'])).toBe('Held by the Data Report, Settings sidebar items');
  });

  it('names toggles and sidebar items together', () => {
    const h = heldToggles({ 'users.edit': true }, ['users']);
    expect(heldCaption(h.heldBy['users.view'])).toBe('Held by Edit Users and the Users sidebar item');
  });

  it('names an implication — Edit Settings under Edit Instruments', () => {
    const h = heldToggles({ 'instruments.edit': true }, []);
    expect(h.heldBy['settings.edit'].toggles).toEqual(['instruments.edit']);
    expect(heldCaption(h.heldBy['settings.edit'])).toBe('Held by Edit Instruments / Manage Token');
  });

  // 2026-11-03: the GET's `permissionsHeld` is passed as currentPermissions. A
  // save keeps every permission no toggle maps, and X_MANAGE covers X_VIEW /
  // X_DELETE — so such a grant holds toggles too, and is named by its name.
  it('names a permission granted outside this tab — NOTIFICATION_MANAGE holds View and Delete Notifications', () => {
    const h = heldToggles({}, [], ['NOTIFICATION_MANAGE', 'AUDIT_READ']);
    expect(h.heldBy['notifications.view']).toEqual({ toggles: [], sidebarItems: [], outside: ['NOTIFICATION_MANAGE'] });
    expect(h.heldBy['notifications.delete'].outside).toEqual(['NOTIFICATION_MANAGE']);
    expect(heldCaption(h.heldBy['notifications.view'])).toBe('Held by a permission granted outside this tab: NOTIFICATION_MANAGE');
    // AUDIT_READ is a toggle's grant: the save rebuilds it, so it holds nothing.
    expect(h.heldBy['audit.view']).toBeUndefined();
  });

  it('a toggle\'s OWN grant is never "outside": ALARM_RULE_MANAGE holds View Alarm Webhooks only through its Manage toggle', () => {
    expect(heldToggles({}, [], ['ALARM_RULE_MANAGE']).heldBy).toEqual({});
    const h = heldToggles({ 'alarm_webhooks.manage': true }, [], ['ALARM_RULE_MANAGE']);
    expect(h.heldBy['alarm_webhooks.view']).toEqual({ toggles: ['alarm_webhooks.manage'], sidebarItems: [], outside: [] });
  });

  it('names all three kinds together, and several outside grants in the plural', () => {
    const h = heldToggles({ 'users.edit': true }, ['users'], ['DASHBOARD_MANAGE']);
    expect(heldCaption(h.heldBy['users.view'])).toBe('Held by Edit Users and the Users sidebar item');
    expect(heldCaption({ toggles: ['users.edit'], sidebarItems: ['users'], outside: ['A_MANAGE', 'B_MANAGE'] }))
      .toBe('Held by Edit Users and the Users sidebar item and permissions granted outside this tab: A_MANAGE, B_MANAGE');
  });

  it('`shown` with stored permissions is still the server\'s answer', () => {
    const current = ['DASHBOARD_MANAGE', 'BACKUP_MANAGE', 'USER_DELETE', 'AUDIT_DELETE'];
    const toggles = { 'users.edit': true, 'audit.delete': false };
    expect(heldToggles(toggles, ['alarms'], current).shown).toEqual(
      privilegeTogglesFromPermissions(rebuildRolePermissions({ currentPermissions: current, toggles, sidebarItems: ['alarms'] })));
  });

  // The property the caption rests on: every held toggle names at least one
  // holder, and each one named holds it BY ITSELF.
  it('every held toggle names a holder, and every holder named holds it alone — every toggle, every menu, every stored grant', () => {
    // The local SUPER_ADMIN's array (2026-11-03): it still carries every unmapped X_MANAGE.
    const STORED = ['USER_DELETE', 'FIELD_ID_UPDATE', 'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_ASSIGN',
      'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_MANAGE', 'BACKUP_MANAGE', 'AUDIT_DELETE', 'USER_READ'];
    type State = [Record<string, boolean>, string[], string[]];
    const states: State[] = [
      ...IDS.map((id): State => [allOnExcept(id), [], []]),
      ...IDS.map((id): State => [allOnExcept(id), SIDEBAR_IDS, []]),
      ...IDS.map((id): State => [allOnExcept(id), SIDEBAR_IDS, STORED]),
      ...IDS.map((id): State => [{ [id]: true }, [], []]),
      ...SIDEBAR_IDS.map((s): State => [{}, [s], []]),
      ...STORED.map((p): State => [{}, [], [p]]),
      [{}, [], STORED],
    ];
    let held = 0;
    let outside = 0;
    for (const [toggles, sidebar, current] of states) {
      const { heldBy } = heldToggles(toggles, sidebar, current);
      for (const [id, holders] of Object.entries(heldBy)) {
        held++;
        outside += holders.outside.length;
        expect(holders.toggles.length + holders.sidebarItems.length + holders.outside.length, `${id} names nobody`).toBeGreaterThan(0);
        for (const t of holders.toggles) expect(heldToggles({ [t]: true }, []).shown[id], `${t} -> ${id}`).toBe(true);
        for (const s of holders.sidebarItems) expect(heldToggles({}, [s]).shown[id], `${s} -> ${id}`).toBe(true);
        for (const p of holders.outside) expect(heldToggles({}, [], [p]).shown[id], `${p} -> ${id}`).toBe(true);
      }
    }
    expect(held).toBeGreaterThan(50);
    expect(outside).toBeGreaterThan(0);
  });
});
