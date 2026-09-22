import { describe, it, expect } from 'vitest';
import { tileLayout, CHIP_HEIGHT_FACTOR, CHIP_GAP, FULL_CODE_GAP, VALUES_TOP_GAP, TILE_HEADER_H, MAX_TILE_FONT } from '../room-geometry';

/**
 * The reading font FILLS the tile (operator, 2026-09-22: "in layouts show
 * instruments live temperature and humidity values"). Before, it was capped at
 * 12 units whatever the room, so a 500-wide room printed a smudge.
 *
 * The renderer's chip geometry from the exported constants it draws with:
 * chipH = fontSize * factor, stacked `gap` apart, the first one a fixed code
 * strip + gap down in FULL and a flat inset down in VALUES_ONLY.
 */
function twoChips(fontSize: number, topGap: number): number {
  return topGap + 2 * fontSize * CHIP_HEIGHT_FACTOR + CHIP_GAP;
}

describe('tileLayout — the font grows to fill the tile', () => {
  it('a single instrument in a big room prints well above the old 12-unit cap', () => {
    const l = tileLayout({ x: 0, y: 0, w: 366, h: 114 }, 1); // Module-E, CWH/RDU/032-00
    expect(l.step).toBe('FULL');
    expect(l.fontSize).toBeGreaterThan(12);
  });

  it('never above the ceiling, however big the room', () => {
    const l = tileLayout({ x: 0, y: 0, w: 491, h: 611 }, 1);
    expect(l.fontSize).toBeLessThanOrEqual(MAX_TILE_FONT);
    // The ceiling itself is the operator's judgement (2026-09-22: 26 was
    // "so large"; 16 stands). Pinned so a "tidy-up" cannot quietly move it.
    expect(MAX_TILE_FONT).toBe(16);
  });

  it('both chips still fit the grown FULL tile (the chip-fit guarantee survives the growth)', () => {
    for (const box of [{ w: 366, h: 114 }, { w: 145, h: 157 }, { w: 253, h: 128 }, { w: 63, h: 204 }]) {
      const l = tileLayout({ x: 0, y: 0, ...box }, 1);
      expect(l.step).toBe('FULL');
      expect(twoChips(l.fontSize, TILE_HEADER_H + FULL_CODE_GAP)).toBeLessThanOrEqual(l.tile.h);
    }
  });

  it('both chips still fit the grown VALUES_ONLY tile', () => {
    const l = tileLayout({ x: 0, y: 0, w: 366, h: 51 }, 1); // Module-E, CWH/RDU/059-00
    expect(l.step).toBe('VALUES_ONLY');
    expect(l.fontSize).toBeGreaterThan(11);
    expect(twoChips(l.fontSize, VALUES_TOP_GAP)).toBeLessThanOrEqual(l.tile.h);
  });

  it('a narrow tile is bound by its width: the height would allow 26, the width refuses any growth', () => {
    const l = tileLayout({ x: 0, y: 0, w: 63, h: 204 }, 1); // Module-F, CWH/RDU/044-00
    // renderer: a nine-glyph label ("100.0 %RH") is 9 × 0.6em + 4 wide inside
    // tile.w − 6, which at 63 wide allows a font under 10 — below the step's own
    // base of 12, so the base stands (the step already proved it fits) and
    // nothing grows.
    expect(l.fontSize).toBeLessThanOrEqual(12);
    expect(l.tile.h).toBeGreaterThan(100); // height was not the constraint
  });

  it('never shrinks below the size the step already fitted', () => {
    const l = tileLayout({ x: 0, y: 0, w: 60, h: 40 }, 1);
    expect(l.fontSize).toBeGreaterThanOrEqual(8);
  });

  it('is monotonic in the box: a bigger room never prints smaller', () => {
    const small = tileLayout({ x: 0, y: 0, w: 120, h: 80 }, 1);
    const big = tileLayout({ x: 0, y: 0, w: 240, h: 160 }, 1);
    expect(big.fontSize).toBeGreaterThanOrEqual(small.fontSize);
  });
});
