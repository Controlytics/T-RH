import { describe, it, expect } from 'vitest';
import { trendCrumbs, originFrom, trailFrom, FALLBACK_ORIGIN } from '../trend-breadcrumbs';

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
    // `main.tsx` routes `/` to the dashboard; there is no Home page (removed 2026-09-19).
    // The old trail called this crumb "Home" and pointed it at `/`.
    const root = trendCrumbs('dashboard', 'i-1', 'X')[0];
    expect(root).toEqual({ label: 'Dashboard', to: '/' });
  });

  it('names the instrument in the trail either way — the trend IS a view of it', () => {
    for (const origin of ['dashboard', 'instruments'] as const) {
      expect(trendCrumbs(origin, 'i-1', 'CWH/RDU/001-00').map((c) => c.label)).toContain('CWH/RDU/001-00');
    }
  });

  /**
   * 2026-10-03, operator: "still its going to instrument page not going to all
   * instruments widget". From the dashboard the detail page was never on the
   * path, and its crumb was the one pressed to go back. So from the dashboard
   * the code is a PLAIN crumb — the only links are the trail before it. From
   * the Instruments list the detail page IS the way in, and the crumb links.
   */
  it('links the instrument crumb to its detail page ONLY when the reader came through Instruments', () => {
    expect(trendCrumbs('instruments', 'i-1', 'CWH/RDU/001-00')).toContainEqual({ label: 'CWH/RDU/001-00', to: '/instruments/i-1' });
    const fromDashboard = trendCrumbs('dashboard', 'i-1', 'CWH/RDU/001-00');
    expect(fromDashboard).toContainEqual({ label: 'CWH/RDU/001-00' });
    expect(fromDashboard.some((c) => c.to === '/instruments/i-1')).toBe(false);
  });

  it('says "Instrument" rather than leaving a gap before the code loads', () => {
    expect(trendCrumbs('dashboard', 'i-1', null)).toContainEqual({ label: 'Instrument' });
    expect(trendCrumbs('instruments', 'i-1', null)).toContainEqual({ label: 'Instrument', to: '/instruments/i-1' });
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

/**
 * 2026-10-03, operator: "in dashboard when i click on all instruments trends
 * option, trends page is opened but when i click on its not going to all
 * instruments page its going to instruments page". The dashboard's selection
 * (All Instruments, or a Block and its Area) lives in its URL as `?fl=`, and
 * the link into this page carried only `from: 'dashboard'` — so the trail
 * here read Dashboard / <code> / Trend with no crumb for the view the reader
 * left, and the code crumb went to the instrument's detail page. The link
 * now carries the dashboard's own breadcrumb TRAIL, and it heads the crumbs.
 */
describe('the dashboard trail', () => {
  const trail = [{ label: 'Dashboard', to: '/' }, { label: 'All Instruments', to: '/?fl=__all__' }];

  it('trailFrom reads a well-formed trail out of router state, and nothing else', () => {
    expect(trailFrom({ from: 'dashboard', trail })).toEqual(trail);
    for (const bad of [null, undefined, {}, { trail: 'x' }, { trail: [{ label: 'A' }] }, { trail: [{ to: '/' }] }, { trail: [{ label: 1, to: '/' }] }]) {
      expect(trailFrom(bad)).toBeNull();
    }
  });

  it('heads the crumbs with the trail when the reader came from the dashboard — All Instruments is the hop back', () => {
    const crumbs = trendCrumbs('dashboard', 'i-1', 'CWH/RDU/001-00', trail);
    expect(crumbs).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'All Instruments', to: '/?fl=__all__' },
      // Plain: the detail page is not on this path, and All Instruments is the way back.
      { label: 'CWH/RDU/001-00' },
      { label: 'Trend' },
    ]);
  });

  it('a Block / Area selection comes through as two linked crumbs', () => {
    const t = [{ label: 'Dashboard', to: '/' }, { label: 'CWH Block', to: '/?fl=b-1' }, { label: 'Stability', to: '/?fl=a-1' }];
    expect(trendCrumbs('dashboard', 'i-1', 'X', t).map((c) => c.label)).toEqual(['Dashboard', 'CWH Block', 'Stability', 'X', 'Trend']);
  });

  it('ignores a trail when the reader came from Instruments, and falls back to the bare Dashboard crumb without one', () => {
    expect(trendCrumbs('instruments', 'i-1', 'X', trail).map((c) => c.label)).toEqual(['Dashboard', 'Instruments', 'X', 'Trend']);
    expect(trendCrumbs('dashboard', 'i-1', 'X', null).map((c) => c.label)).toEqual(['Dashboard', 'X', 'Trend']);
    expect(trendCrumbs('dashboard', 'i-1', 'X', []).map((c) => c.label)).toEqual(['Dashboard', 'X', 'Trend']);
  });
});
