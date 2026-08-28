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

/**
 * Content size, as a CSS `zoom` factor.
 *
 * **`zoom`, not `font-size`, and the label says "Content size" for that reason.**
 * The panels size their text with absolute Tailwind classes (`text-sm`,
 * `text-[11px]`), which do not inherit from a container's font-size — setting one
 * would have produced a control that appears to work and changes nothing. `zoom`
 * scales the whole content: text, spacing and any glyphs with it. That is a
 * blunter instrument than a font control, so the UI calls it what it is rather
 * than promising something narrower.
 *
 * Bounded steps, like the palette: a free number invites 0.4, which is a card
 * nobody can read.
 */
export interface PanelSize {
  key: string;
  label: string;
  zoom: number;
}

export const PANEL_SIZES: readonly PanelSize[] = [
  { key: 'compact', label: 'Compact', zoom: 0.85 },
  { key: 'normal', label: 'Normal', zoom: 1 },
  { key: 'large', label: 'Large', zoom: 1.15 },
  { key: 'xlarge', label: 'Extra large', zoom: 1.3 },
] as const;

export const DEFAULT_SIZE = 'normal';

/** Padding inside the card's content area, in pixels. */
export interface PanelPadding {
  key: string;
  label: string;
  px: number;
}

export const PANEL_PADDINGS: readonly PanelPadding[] = [
  { key: 'none', label: 'None', px: 0 },
  { key: 'tight', label: 'Tight', px: 6 },
  { key: 'normal', label: 'Normal', px: 12 },
  { key: 'roomy', label: 'Roomy', px: 20 },
] as const;

export const DEFAULT_PADDING = 'normal';

const SIZE_KEYS = new Set(PANEL_SIZES.map((x) => x.key));
const PADDING_KEYS = new Set(PANEL_PADDINGS.map((x) => x.key));

export function sizeFor(key: string | undefined): PanelSize {
  return PANEL_SIZES.find((x) => x.key === key) ?? PANEL_SIZES[1];
}

export function paddingFor(key: string | undefined): PanelPadding {
  return PANEL_PADDINGS.find((x) => x.key === key) ?? PANEL_PADDINGS[2];
}


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
  /** A PANEL_SIZES key. Absent means `normal`. */
  size?: string;
  /** A PANEL_PADDINGS key. Absent means `normal`. */
  pad?: string;
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
  // Unknown keys are DROPPED, never defaulted-in as a stored value: a retired
  // size should render at normal, not pin the card to whatever replaced it.
  if (typeof o.size === 'string' && SIZE_KEYS.has(o.size) && o.size !== DEFAULT_SIZE) style.size = o.size;
  if (typeof o.pad === 'string' && PADDING_KEYS.has(o.pad) && o.pad !== DEFAULT_PADDING) style.pad = o.pad;
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
