import { describe, it, expect } from 'vitest';
import { THEMES } from '../themes';
import {
  deriveSurfacePalette,
  mixWithWhite,
  SURFACE_PCT,
  SURFACE_ALT_PCT,
  CANVAS_PCT,
} from '../theme-surfaces';
import { contrastRatio } from '../contrast';

/**
 * The app has ONE hue, chosen on Config → Branding, and 10 presets to choose
 * from. Every preset therefore has to produce readable page surfaces — this is
 * the only automated check on that, because the rendered UI cannot be opened in a
 * browser from this dev environment.
 */

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

const BODY_SLATE = '#1e293b';      // text-slate-800
const SECONDARY_SLATE = '#334155'; // text-slate-700, after the app.css remap

const cases = THEMES.map((t) => [t.name, t] as const);

describe('theme-derived page surfaces', () => {
  it('covers every preset the Branding page offers', () => {
    // If a theme is added and this number is not updated, the new theme has never
    // been contrast-checked. Failing here is the point.
    expect(THEMES).toHaveLength(10);
  });

  it.each(cases)('%s: body + secondary text clear 4.5:1 on card and alt surfaces', (_name, theme) => {
    const p = deriveSurfacePalette(theme.colors);
    const surface = mixWithWhite(p.from, SURFACE_PCT);
    const surfaceAlt = mixWithWhite(p.from, SURFACE_ALT_PCT);

    for (const fg of [BODY_SLATE, SECONDARY_SLATE, p.text, p.muted]) {
      expect(contrastRatio(fg, surface)).toBeGreaterThanOrEqual(AA_BODY);
      expect(contrastRatio(fg, surfaceAlt)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it.each(cases)('%s: body text and headings clear 4.5:1 on the canvas', (_name, theme) => {
    // The canvas is the most saturated surface, and page-level text sits directly
    // on it, so it needs checking separately from the cards.
    const p = deriveSurfacePalette(theme.colors);
    const canvas = mixWithWhite(p.from, CANVAS_PCT);
    expect(contrastRatio(BODY_SLATE, canvas)).toBeGreaterThanOrEqual(AA_BODY);
    expect(contrastRatio(p.text, canvas)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(cases)('%s: white body text clears 4.5:1 on the table-header band', (_name, theme) => {
    const p = deriveSurfacePalette(theme.colors);
    expect(contrastRatio('#ffffff', p.tableHead)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(cases)('%s: white large text clears 3:1 on both gradient stops', (_name, theme) => {
    const p = deriveSurfacePalette(theme.colors);
    expect(contrastRatio('#ffffff', p.from)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio('#ffffff', p.to)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it.each(cases)('%s: headings are darker than secondary text, not just different', (_name, theme) => {
    const p = deriveSurfacePalette(theme.colors);
    const surface = mixWithWhite(p.from, SURFACE_PCT);
    // A heading that reads the same weight as the body defeats the hierarchy the
    // 7:1 target exists to create.
    expect(contrastRatio(p.text, surface)).toBeGreaterThan(contrastRatio(p.muted, surface));
  });

  it.each([
    ['slate-400', '#94a3b8'],
    ['slate-500', '#64748b'],
    ['slate-600', '#475569'],
  ])('%s stays unusable on the tinted surfaces — this is why app.css remaps it', (_n, hex) => {
    // Fails loudly if a tint change makes one of these safe again, so the remap is
    // narrowed deliberately rather than left in place by inertia.
    const worst = Math.min(
      ...THEMES.flatMap((t) => {
        const p = deriveSurfacePalette(t.colors);
        return [SURFACE_PCT, SURFACE_ALT_PCT].map((pct) => contrastRatio(hex, mixWithWhite(p.from, pct)));
      }),
    );
    expect(worst).toBeLessThan(AA_BODY);
  });

  it('derives deterministically — same theme in, same colours out', () => {
    // applyTheme() runs on every branding load; a non-deterministic derivation
    // would make the page flicker between near-identical tones.
    for (const t of THEMES) {
      expect(deriveSurfacePalette(t.colors)).toEqual(deriveSurfacePalette(t.colors));
    }
  });
});
