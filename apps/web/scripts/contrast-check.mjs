// WCAG AA contrast for UI v3: white on every preset's gradient ends (the hero
// band, table header band, form plates) and slate-900 on the two theme tints.
// Run: npm run check:contrast   (exit 1 on any failure)
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/lib/themes.ts', import.meta.url), 'utf8');
const presets = [];
for (const block of src.split(/\n\s*\{\s*\n\s*id:/).slice(1)) {
  const id = block.match(/^\s*'([^']+)'/)?.[1];
  const pick = (k) => block.match(new RegExp(`${k}:\\s*'(#[0-9a-fA-F]{6})'`))?.[1];
  presets.push({ id, primary: pick('primary'), from: pick('gradientFrom'), to: pick('gradientTo') });
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const toHex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const mix = (h, pct) => toHex(hex(h).map((v) => v * pct + 1 * (1 - pct)));   // color-mix(in srgb, h pct%, white)
const shade = (h, pct) => toHex(hex(h).map((v) => v * pct));                  // color-mix(in srgb, h pct%, black)

/**
 * The band is NOT the raw gradient. `--band-gradient` in app.css mixes each
 * end with black at BAND_KEEP so that body-size white text (breadcrumbs, tile
 * eyebrows, hints) clears 4.5:1 on every preset. Measured 2026-09-21: the raw
 * ends fail body contrast on Ocean, Emerald, Sunset, Forest and Coral. Keep
 * this constant equal to the percentage in app.css.
 */
const BAND_KEEP = 0.78;

let failed = 0;
for (const p of presets) {
  if (!p.id || !p.primary || !p.from || !p.to) { console.log(`SKIP  could not parse a preset: ${JSON.stringify(p)}`); failed++; continue; }
  const rows = [
    ['white on band start (body >=4.5)', ratio('#ffffff', shade(p.from, BAND_KEEP)), 4.5],
    ['white on band end (body >=4.5)', ratio('#ffffff', shade(p.to, BAND_KEEP)), 4.5],
    ['white on raw gradientFrom (large >=3)', ratio('#ffffff', p.from), 3],
    ['white on raw gradientTo (large >=3)', ratio('#ffffff', p.to), 3],
    ['slate-900 on tint-1 (body >=4.5)', ratio('#0f172a', mix(p.primary, 0.06)), 4.5],
    ['slate-900 on tint-2 (body >=4.5)', ratio('#0f172a', mix(p.primary, 0.12)), 4.5],
  ];
  for (const [label, r, min] of rows) {
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.id.padEnd(9)} ${label.padEnd(40)} ${r.toFixed(2)}`);
  }
}
console.log(failed ? `\n${failed} check(s) below WCAG AA` : '\nall presets pass');
process.exit(failed ? 1 : 0);
