import { describe, it, expect } from 'vitest';
import { MODULE_PALETTES, FALLBACK_PALETTE, resolveModulePalette } from '../module-palettes';
import { contrastRatio, mixWithWhite } from '../contrast';

/**
 * These percentages MUST track the --color-surface / --color-surface-alt
 * definitions in app.css. If a tint depth changes there and not here, the test
 * keeps passing while the screen goes out of compliance.
 */
const SURFACE_PCT = 26;
const SURFACE_ALT_PCT = 36;

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

/** What the app actually paints body text with, on the page canvas. */
const BODY_SLATE = '#1e293b';   // text-slate-800
const SECONDARY_SLATE = '#334155'; // slate-700 — slate-600's ceiling is a 32% tint

const cases = MODULE_PALETTES.map((p) => [p.id, p] as const);

describe('resolveModulePalette', () => {
  it('matches the longest prefix, not the first', () => {
    // '/config/floorplans' must not fall through to the '/' dashboard entry
    expect(resolveModulePalette('/config/floorplans').id).toBe('config');
    expect(resolveModulePalette('/config').id).toBe('config');
    expect(resolveModulePalette('/instruments/abc-123').id).toBe('instruments');
    expect(resolveModulePalette('/instruments/profiles/x').id).toBe('instruments');
  });

  it('resolves the dashboard for exactly "/"', () => {
    expect(resolveModulePalette('/').id).toBe('dashboard');
  });

  it('falls back to neutral for an unknown route', () => {
    expect(resolveModulePalette('/not-a-real-route').id).toBe(FALLBACK_PALETTE.id);
  });

  it('does not let the "/" entry swallow every other route', () => {
    // Regression guard: a naive startsWith('/') match makes EVERY page the
    // dashboard palette, which looks like "the feature does nothing".
    const ids = ['/audit', '/users', '/notifications', '/debug/traces']
      .map((p) => resolveModulePalette(p).id);
    expect(ids).toEqual(['audit', 'users', 'notifications', 'debug']);
  });

  it('has no duplicate ids', () => {
    const ids = MODULE_PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate route prefixes', () => {
    const prefixes = MODULE_PALETTES.flatMap((p) => p.prefixes);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('palette contrast (WCAG AA)', () => {
  it.each(cases)('%s: heading + body text clear 4.5:1 on both tinted surfaces', (_id, p) => {
    const surface = mixWithWhite(p.from, SURFACE_PCT);
    const surfaceAlt = mixWithWhite(p.from, SURFACE_ALT_PCT);

    for (const fg of [p.text, p.muted, BODY_SLATE, SECONDARY_SLATE]) {
      expect(contrastRatio(fg, surface)).toBeGreaterThanOrEqual(AA_BODY);
      expect(contrastRatio(fg, surfaceAlt)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it.each(cases)('%s: white body text clears 4.5:1 on the tableHead band', (_id, p) => {
    expect(contrastRatio('#ffffff', p.tableHead)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(cases)('%s: white large text clears 3:1 on both gradient stops', (_id, p) => {
    expect(contrastRatio('#ffffff', p.from)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio('#ffffff', p.to)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it('tableHead is never the gradient "from" — that reintroduces 5 AA failures', () => {
    for (const p of MODULE_PALETTES) {
      // debug/fallback are neutral slate, where `from` is already dark enough.
      if (p.id === 'debug') continue;
      expect(p.tableHead, `${p.id} reused its gradient start as the table head`)
        .not.toBe(p.from);
    }
  });

  it.each([
    ['slate-400', '#94a3b8'],
    ['slate-500', '#64748b'],
    ['slate-600', '#475569'],
  ])('%s is UNUSABLE on the tinted surfaces — this is why app.css remaps it', (_name, hex) => {
    // Documents WHY the remap exists, and fails loudly if a future tint change
    // makes one of these safe again — at which point the remap can be narrowed,
    // deliberately, rather than left in place by inertia. slate-600 was fine at
    // the original 6%/12% depths and was pulled in by deepening to 22%/34%.
    const worst = Math.min(
      ...MODULE_PALETTES.flatMap((p) => [SURFACE_PCT, SURFACE_ALT_PCT]
        .map((pct) => contrastRatio(hex, mixWithWhite(p.from, pct)))),
    );
    expect(worst).toBeLessThan(AA_BODY);
  });

  it('the canvas gradient keeps body text and headings above AA', () => {
    // The canvas is the most saturated surface (46/40/34%). Page-level text sits
    // directly on it, so it needs checking separately from the cards.
    const CANVAS_DARKEST_PCT = 46;
    for (const p of MODULE_PALETTES) {
      const canvas = mixWithWhite(p.from, CANVAS_DARKEST_PCT);
      expect(contrastRatio('#1e293b', canvas), `${p.id} slate-800 on canvas`)
        .toBeGreaterThanOrEqual(AA_BODY);
      expect(contrastRatio(p.text, canvas), `${p.id} heading on canvas`)
        .toBeGreaterThanOrEqual(AA_BODY);
    }
  });
});
