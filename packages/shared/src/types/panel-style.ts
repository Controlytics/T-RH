/**
 * How one dashboard card may be styled.
 *
 * Design: docs/superpowers/specs/2026-08-28-dashboard-layout-design.md (C2).
 *
 * **A BOUNDED palette, not a colour picker.** Operator's decision, and the reason
 * matters: this application's rule is that colour never carries meaning alone —
 * every status is a colour PLUS a glyph PLUS a word. Free hex would let someone
 * paint an out-of-limit card green, or set text the same shade as its background.
 * Each tint here therefore ships with its OWN text colour, and a test asserts
 * WCAG AA contrast for every pair, so the palette cannot grow unsafely.
 *
 * **This styles the card's CHROME only** — its background, border and heading.
 * Status badges, limit lines, out-of-spec highlighting and chart series colours
 * live INSIDE the panels and are deliberately not reachable from here. They encode
 * compliance state, and a §11 record that looks different depending on who
 * arranged their dashboard is not a record.
 */

export interface PanelTint {
  key: string;
  label: string;
  /** Card background. */
  bg: string;
  /** Card border. */
  border: string;
  /** Heading text ON that background. Paired, never chosen independently. */
  text: string;
}

/**
 * Every pair is a light background with dark text, which is what keeps the
 * contrast assertion comfortable rather than marginal. Adding a tint means adding
 * a pair; the test will refuse one that fails AA.
 */
export const PANEL_TINTS: readonly PanelTint[] = [
  { key: 'default', label: 'Default', bg: '#ffffff', border: '#e2e8f0', text: '#1e293b' },
  { key: 'slate', label: 'Slate', bg: '#f1f5f9', border: '#cbd5e1', text: '#1e293b' },
  { key: 'sky', label: 'Sky', bg: '#e0f2fe', border: '#7dd3fc', text: '#075985' },
  { key: 'emerald', label: 'Emerald', bg: '#d1fae5', border: '#6ee7b7', text: '#065f46' },
  { key: 'amber', label: 'Amber', bg: '#fef3c7', border: '#fcd34d', text: '#92400e' },
  { key: 'rose', label: 'Rose', bg: '#ffe4e6', border: '#fda4af', text: '#9f1239' },
  { key: 'violet', label: 'Violet', bg: '#ede9fe', border: '#c4b5fd', text: '#5b21b6' },
] as const;

export const DEFAULT_TINT = 'default';

const TINT_KEYS = new Set(PANEL_TINTS.map((t) => t.key));

export function isTintKey(v: unknown): v is string {
  return typeof v === 'string' && TINT_KEYS.has(v);
}

export function tintFor(key: string | undefined): PanelTint {
  return PANEL_TINTS.find((t) => t.key === key) ?? PANEL_TINTS[0];
}

/** A card's own heading is capped so a long one cannot break the card's chrome. */
export const MAX_PANEL_TITLE = 60;

export interface PanelStyle {
  tint?: string;
  /** Overrides the panel's built-in heading. Absent means "use the built-in". */
  title?: string;
}

/**
 * Read a stored style, or `undefined` when there is nothing usable.
 *
 * Unlike the layout around it, a bad style is simply DROPPED rather than
 * invalidating anything: the card then renders in its default chrome, which is a
 * cosmetic loss. Rejecting the whole layout because one colour was unreadable
 * would move someone's cards over a styling mistake.
 */
export function normalizePanelStyle(v: unknown): PanelStyle | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const style: PanelStyle = {};
  if (isTintKey(o.tint)) style.tint = o.tint;
  if (typeof o.title === 'string') {
    const title = o.title.trim().slice(0, MAX_PANEL_TITLE);
    if (title.length > 0) style.title = title;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]]
    .map((h) => parseInt(h, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two hex colours, 1..21.
 *
 * Exported so the palette's own test can assert it. A bounded palette is only
 * safer than free hex if something actually checks the bound.
 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
