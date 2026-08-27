import type { CSSProperties } from 'react';

/**
 * The app background image layer.
 *
 * Pure, so the one thing that can go wrong here — an unreadable page — is testable
 * without a browser. Playwright cannot authenticate in this repo, so a unit test is
 * the only automated check this layer will ever get.
 *
 * The image is served from `/uploads/branding/`, which is public-GET by necessity:
 * a CSS `background-image` cannot send an Authorization header.
 */

/** `contain`: show the WHOLE image, letterboxed rather than cropped. Operator's choice. */
const FIT: CSSProperties['backgroundSize'] = 'contain';

/**
 * A 6-digit hex colour with an alpha applied, for letting the wallpaper show through
 * the sidebar and header.
 *
 * A malformed colour returns UNCHANGED rather than throwing or producing an invalid
 * value: the chrome then renders at its original opacity, which is merely the
 * previous appearance. An invalid gradient would paint nothing and leave white nav
 * text on the wallpaper.
 */
export function withAlpha(hex: string, alpha: number): string {
  if (!hex) return '';
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const a = Math.min(1, Math.max(0, alpha));
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface BackgroundSource {
  backgroundUrl?: string;
  /** Percentage strength of the image behind the white scrim, 0..100. */
  backgroundOpacity?: number;
}

/**
 * Clamped to 0..100 and floored. An absent or unparseable value falls back.
 *
 * `null` and `''` are checked BEFORE the numeric coercion on purpose: `Number(null)`
 * and `Number('')` are both `0`, not `NaN`, so a config row that has never been set
 * would otherwise resolve to a fully transparent background — which on screen is
 * indistinguishable from an upload that silently failed.
 */
export function resolveOpacity(value: unknown, fallback = 12): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.floor(n)));
}

/**
 * The style for the fixed layer that sits behind every page, or `null` when no
 * background is configured.
 *
 * Returning `null` rather than a transparent layer matters: the layer is
 * `position: fixed` over the whole viewport, and rendering one unconditionally would
 * put an element above the page's own background for every install that never set an
 * image. Absent means absent.
 */
export function backgroundLayerStyle(branding: BackgroundSource | null | undefined): CSSProperties | null {
  const url = branding?.backgroundUrl?.trim();
  if (!url) return null;

  const opacity = resolveOpacity(branding?.backgroundOpacity);

  return {
    backgroundImage: `url(${JSON.stringify(url)})`,
    backgroundSize: FIT,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    // NOT `fixed`. `background-attachment: fixed` positions the image against the
    // VIEWPORT, so with `contain` the image is letterboxed against the whole window
    // and appears to begin partway down the content pane. The layer is already a
    // non-scrolling element sized to the pane, so the default (`scroll`) centres the
    // image within the pane itself, which is where it belongs.
    backgroundAttachment: 'scroll',
    // The image's own strength. The white scrim is a sibling element rather than a
    // filter on this one, because `opacity` on the image would also fade anything
    // painted on top of it.
    opacity: opacity / 100,
  };
}
