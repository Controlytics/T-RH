import { describe, it, expect } from 'vitest';
import { trendCrumbs, originFrom, FALLBACK_ORIGIN } from '../trend-breadcrumbs';

/**
 * A breadcrumb naming a path the reader did not take is worse than none: its
 * whole job is to say where you are, and following it back lands somewhere you
 * were never at. That is what this page did until 2026-09-01 — hardcoded to
 * Home / Instruments / <code> / Trend while both links into it come from the
 * DASHBOARD.
 */
describe('originFrom', () => {
  it('reads the origin a link put in router state', () => {
    expect(originFrom({ from: 'dashboard' })).toBe('dashboard');
    expect(originFrom({ from: 'instruments' })).toBe('instruments');
  });

  it('falls back for a refresh, a pasted URL, or a link that sets nothing', () => {
    // State does not survive a reload. That is precisely the case where there
    // is no journey to describe, so the hierarchy is the honest answer.
    for (const state of [null, undefined, {}, { from: 'nonsense' }, 'garbage', 42]) {
      expect(originFrom(state)).toBe(FALLBACK_ORIGIN);
    }
  });
});

describe('trendCrumbs', () => {
  it('does NOT claim a path through Instruments when the reader came from the dashboard', () => {
    // The defect, stated as a test.
    const crumbs = trendCrumbs('dashboard', 'i-1', 'CWH/RDU/001-00');
    expect(crumbs.map((c) => c.label)).toEqual(['Dashboard', 'CWH/RDU/001-00', 'Trend']);
    expect(crumbs.some((c) => c.label === 'Instruments')).toBe(false);
  });

  it('keeps the full hierarchy when that IS the route in', () => {
    expect(trendCrumbs('instruments', 'i-1', 'CWH/RDU/001-00').map((c) => c.label))
      .toEqual(['Dashboard', 'Instruments', 'CWH/RDU/001-00', 'Trend']);
  });

  it('labels the root crumb Dashboard, because that is what `/` renders', () => {
    // `main.tsx:107` routes `/` to the dashboard; `/home` is a different page.
    // The old trail called this crumb "Home" and pointed it at `/`.
    const root = trendCrumbs('dashboard', 'i-1', 'X')[0];
    expect(root).toEqual({ label: 'Dashboard', to: '/' });
  });

  it('keeps the instrument in the trail either way — the trend IS a view of it', () => {
    for (const origin of ['dashboard', 'instruments'] as const) {
      const crumbs = trendCrumbs(origin, 'i-1', 'CWH/RDU/001-00');
      expect(crumbs).toContainEqual({ label: 'CWH/RDU/001-00', to: '/instruments/i-1' });
    }
  });

  it('says "Instrument" rather than leaving a gap before the code loads', () => {
    const crumbs = trendCrumbs('dashboard', 'i-1', null);
    expect(crumbs).toContainEqual({ label: 'Instrument', to: '/instruments/i-1' });
  });

  it('omits the instrument crumb entirely when there is no id to link to', () => {
    // A crumb with no destination is a dead control.
    expect(trendCrumbs('dashboard', null, null).map((c) => c.label)).toEqual(['Dashboard', 'Trend']);
  });

  it('always ends on Trend, with no link — you are already here', () => {
    for (const origin of ['dashboard', 'instruments'] as const) {
      const last = trendCrumbs(origin, 'i-1', 'X').at(-1)!;
      expect(last).toEqual({ label: 'Trend' });
    }
  });
});
