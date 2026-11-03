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
  it('with every other toggle ON, exactly these eleven come back', () => {
    const back = IDS.filter(id => heldToggles(allOnExcept(id), []).shown[id]).sort();
    expect(back).toEqual([
      'alarm_webhooks.view', 'alarms.view', 'audit.view', 'config.view', 'data_report.view',
      'functional_locations.view', 'instruments.view', 'reports.view', 'settings.edit', 'settings.view', 'users.view',
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
    expect(h.heldBy['users.view']).toEqual({ toggles: ['users.create', 'users.edit'], sidebarItems: [] });
    expect(heldCaption(h.heldBy['users.view'])).toBe('Held by Create Users, Edit Users');
  });

  it('names every sidebar item that holds it — View Instruments under Data Report and Settings', () => {
    const h = heldToggles({}, ['data-report', 'settings']);
    expect(h.heldBy['instruments.view']).toEqual({ toggles: [], sidebarItems: ['data-report', 'settings'] });
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

  // The property the caption rests on: every held toggle names at least one
  // holder, and each one named holds it BY ITSELF.
  it('every held toggle names a holder, and every holder named holds it alone — every toggle, every menu', () => {
    const states: Array<[Record<string, boolean>, string[]]> = [
      ...IDS.map((id): [Record<string, boolean>, string[]] => [allOnExcept(id), []]),
      ...IDS.map((id): [Record<string, boolean>, string[]] => [allOnExcept(id), SIDEBAR_IDS]),
      ...IDS.map((id): [Record<string, boolean>, string[]] => [{ [id]: true }, []]),
      ...SIDEBAR_IDS.map((s): [Record<string, boolean>, string[]] => [{}, [s]]),
    ];
    let held = 0;
    for (const [toggles, sidebar] of states) {
      const { heldBy } = heldToggles(toggles, sidebar);
      for (const [id, holders] of Object.entries(heldBy)) {
        held++;
        expect(holders.toggles.length + holders.sidebarItems.length, `${id} names nobody`).toBeGreaterThan(0);
        for (const t of holders.toggles) expect(heldToggles({ [t]: true }, []).shown[id], `${t} -> ${id}`).toBe(true);
        for (const s of holders.sidebarItems) expect(heldToggles({}, [s]).shown[id], `${s} -> ${id}`).toBe(true);
      }
    }
    expect(held).toBeGreaterThan(50);
  });
});
