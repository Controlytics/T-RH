import { describe, it, expect } from 'vitest';
import {
  PANELS, PANEL_KEYS, isPanelKey, normalizePanels, resolvePanels, panelVisible,
} from './panels.js';

describe('PANELS catalogue', () => {
  it('is frozen — the exact keys, in order', () => {
    // A snapshot in code rather than a .snap file: these keys are stored in the
    // database, so adding or renaming one silently orphans saved rows.
    expect(PANEL_KEYS).toEqual([
      'telemetry_table',
      'telemetry_floorplan',
      'dashboard_trend',
      'dashboard_alarms',
      'trend_gauges',
      'trend_charts',
      'trend_summary',
      'trend_historian_table',
      'trend_alarms',
    ]);
  });

  it('does NOT contain the four retired dashboard keys', () => {
    // total_users / audit_trail / notifications / quick_actions gated sections that
    // were removed from the dashboard. A switch that does nothing on a governance
    // screen is worse than an absent one.
    for (const dead of ['total_users', 'audit_trail', 'notifications', 'quick_actions']) {
      expect(PANEL_KEYS).not.toContain(dead);
    }
  });

  it('gives every panel a page, a label and a description', () => {
    for (const p of PANELS) {
      expect(p.page === 'dashboard' || p.page === 'trend').toBe(true);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(PANEL_KEYS).size).toBe(PANEL_KEYS.length);
  });
});

describe('isPanelKey', () => {
  it('accepts a catalogue key and rejects anything else', () => {
    expect(isPanelKey('trend_charts')).toBe(true);
    expect(isPanelKey('total_users')).toBe(false);
    expect(isPanelKey(7)).toBe(false);
    expect(isPanelKey(null)).toBe(false);
  });
});

describe('normalizePanels', () => {
  it('reads a stored array, dropping keys no longer in the catalogue', () => {
    // A retired key must contribute NOTHING. It must never be read as a wildcard:
    // that would turn a narrow grant into a full one as the catalogue evolves.
    expect(normalizePanels(['trend_charts', 'total_users'])).toEqual(['trend_charts']);
  });

  it('keeps an EMPTY array as an empty array, not as absent', () => {
    // The whole feature rests on this. undefined here would turn "no panels" into
    // "inherit", i.e. into "every panel".
    expect(normalizePanels([])).toEqual([]);
  });

  it('keeps an array whose every member is retired as EMPTY, not absent', () => {
    expect(normalizePanels(['total_users', 'audit_trail'])).toEqual([]);
  });

  it('treats absent and malformed alike as INHERIT, never as deny', () => {
    // A corrupted value must not blank someone's screen: that is an outage
    // presenting as a configuration change, and much harder to diagnose.
    expect(normalizePanels(null)).toBeUndefined();
    expect(normalizePanels(undefined)).toBeUndefined();
    expect(normalizePanels('trend_charts')).toBeUndefined();
    expect(normalizePanels({ panels: [] })).toBeUndefined();
  });

  it('drops non-string members instead of carrying them through', () => {
    expect(normalizePanels(['trend_charts', 7, null])).toEqual(['trend_charts']);
  });
});

describe('resolvePanels', () => {
  it('gives SUPER_ADMIN every panel whatever is stored', () => {
    expect(resolvePanels('SUPER_ADMIN', [], [])).toBeNull();
    expect(resolvePanels('SUPER_ADMIN', ['trend_charts'], [])).toBeNull();
  });

  it('is unrestricted when neither level is set', () => {
    expect(resolvePanels('OPERATOR', null, null)).toBeNull();
    expect(resolvePanels('OPERATOR', undefined, undefined)).toBeNull();
  });

  it('inherits the role list when the user has none', () => {
    expect(resolvePanels('OPERATOR', ['trend_charts'], null)).toEqual(['trend_charts']);
  });

  it('lets the user list REPLACE the role list', () => {
    expect(resolvePanels('OPERATOR', ['trend_charts'], ['trend_alarms'])).toEqual(['trend_alarms']);
  });

  it('lets a user override WIDEN beyond the role, matching effectiveScope', () => {
    expect(resolvePanels('OPERATOR', ['trend_charts'], ['trend_charts', 'trend_alarms']))
      .toEqual(['trend_charts', 'trend_alarms']);
  });

  it('treats an EMPTY user list as NO panels, not as inherit', () => {
    // The deliberate deviation from getMyConfig's `sidebarItems.length > 0` rule.
    expect(resolvePanels('OPERATOR', ['trend_charts'], [])).toEqual([]);
  });

  it('treats an EMPTY role list as NO panels too', () => {
    expect(resolvePanels('OPERATOR', [], null)).toEqual([]);
  });
});

describe('panelVisible', () => {
  it('shows everything when resolution is null', () => {
    expect(panelVisible(null, 'trend_charts')).toBe(true);
  });

  it('shows nothing when the list is empty', () => {
    expect(panelVisible([], 'trend_charts')).toBe(false);
  });

  it('shows only listed panels', () => {
    expect(panelVisible(['trend_charts'], 'trend_charts')).toBe(true);
    expect(panelVisible(['trend_charts'], 'trend_alarms')).toBe(false);
  });
});
