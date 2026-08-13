/**
 * sRGB relative luminance + WCAG contrast ratios.
 *
 * Exists so the module palettes in `module-palettes.ts` are MEASURED rather than
 * eyeballed. The first draft of that file reused each palette's gradient start as
 * its table-header band; white body text on those 600-level mid-tones measured
 * 2.94-3.77:1 and failed WCAG AA on five of eleven palettes. Nothing about that
 * is visible by looking at a swatch, and this repo has no browser-based
 * verification path, so it is asserted in `module-palettes.test.ts` instead.
 */

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1..21. Order of arguments does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Mirrors `color-mix(in srgb, <hex> <pct>%, white)` so a test measures the same
 * value the browser paints. Deliberately srgb, not oklab: the surface tokens in
 * `app.css` are declared `in srgb`, and mixing in a different space here would
 * make the assertions measure a colour that never reaches the screen.
 */
export function mixWithWhite(hex: string, pct: number): string {
  const mixed = toRgb(hex).map((c) => Math.round((c * pct) / 100 + 255 * (1 - pct / 100)));
  return '#' + mixed.map((c) => c.toString(16).padStart(2, '0')).join('');
}
