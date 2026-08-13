import { contrastRatio } from './contrast';
import type { ThemeColors } from './themes';

/**
 * Derives the page-surface colours from the ACTIVE THEME.
 *
 * One hue for the whole application, chosen on Config → Branding. This replaced
 * an earlier per-route palette set (2026-08-13): on screen, a different hue per
 * module read as eleven unrelated apps rather than one themed one, which is not
 * what the operator wanted once they saw it rendered.
 *
 * DIVISION OF RESPONSIBILITY — now a single source:
 *   --theme-*  (themes.ts)  chrome: sidebar, login, primary buttons.
 *   --ui-*     (this file)  page:   canvas, cards, tables, stat tiles, bands.
 * Both are written by `applyTheme()`, so they cannot disagree about which theme
 * is active. That is the point of deriving rather than declaring.
 *
 * Everything here is DERIVED, not hand-picked, because there are 10 themes and
 * hand-picking 10 x 4 values is how contrast failures get in. `text` and `muted`
 * are darkened until they measurably clear WCAG AA against the tinted surfaces
 * they will actually sit on. `theme-surfaces.test.ts` asserts it for all 10.
 */

export interface SurfacePalette {
  /** Gradient start — canvas, bands, tiles. */
  from: string;
  /** Gradient end. Large text only; some theme pairs sit near 3:1. */
  to: string;
  /** Solid table-header band. Must clear 4.5:1 against white. */
  tableHead: string;
  /** Heading text on tinted surfaces. */
  text: string;
  /** Secondary heading text. */
  muted: string;
}

/** MUST track --color-surface / --color-surface-alt in app.css. */
export const SURFACE_PCT = 26;
export const SURFACE_ALT_PCT = 36;
/** Darkest stop of .bg-app-canvas. */
export const CANVAS_PCT = 46;

const AA_BODY = 4.5;

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (rgb: number[]) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

/** Mirrors `color-mix(in srgb, hex pct%, white)` — what app.css paints. */
export function mixWithWhite(hex: string, pct: number): string {
  return toHex(toRgb(hex).map((c) => (c * pct) / 100 + 255 * (1 - pct / 100)));
}

/** Mixes toward black. Used to manufacture the dark text tones themes don't carry. */
function darken(hex: string, pct: number): string {
  return toHex(toRgb(hex).map((c) => (c * (100 - pct)) / 100));
}

/**
 * Darkens `hex` in 4% steps until it clears `target` against `bg`. Returns near
 * black rather than giving up, so a pathological theme degrades to readable
 * instead of to invisible.
 */
function darkenUntil(hex: string, bg: string, target: number): string {
  for (let pct = 0; pct <= 92; pct += 4) {
    const candidate = darken(hex, pct);
    if (contrastRatio(candidate, bg) >= target) return candidate;
  }
  return '#0a0a0a';
}

export function deriveSurfacePalette(colors: ThemeColors): SurfacePalette {
  const from = colors.gradientFrom;
  const to = colors.gradientTo;

  const surface = mixWithWhite(from, SURFACE_PCT);
  const surfaceAlt = mixWithWhite(from, SURFACE_ALT_PCT);

  return {
    from,
    to,
    // primaryDark is the theme's own 700-level tone and clears 4.5:1 against
    // white for all 10 presets; darkenUntil is the guard for a custom theme.
    tableHead: darkenUntil(colors.primaryDark, '#ffffff', AA_BODY),
    // Headings get extra headroom (7:1) so they read as emphasis, not as body.
    text: darkenUntil(colors.primary, surface, 7),
    // Secondary text is checked against the DARKER of the two surfaces it can
    // land on, which is the alt tint.
    muted: darkenUntil(colors.primary, surfaceAlt, AA_BODY),
  };
}

/** Writes the derived surfaces as CSS custom properties. Called by applyTheme(). */
export function applySurfacePalette(colors: ThemeColors): SurfacePalette {
  const p = deriveSurfacePalette(colors);
  const root = document.documentElement;
  root.style.setProperty('--ui-from', p.from);
  root.style.setProperty('--ui-to', p.to);
  root.style.setProperty('--ui-table-head', p.tableHead);
  root.style.setProperty('--ui-text', p.text);
  root.style.setProperty('--ui-muted', p.muted);
  return p;
}
