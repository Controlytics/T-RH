import { describe, it, expect } from 'vitest';
import type { LayoutItem } from '@digilog/shared';
import {
  AUTO_HEIGHT_PANELS, ROW_HEIGHT, MARGIN_Y, MIN_AUTO_ROWS,
  capacityPx, rowsForHeight, nextRows, applyAutoHeights, keepStoredHeights,
} from '../panel-auto-height';

/**
 * Panel height follows content (operator, 2026-09-01): a card ends at its
 * pagination bar, and changing 25 -> 50 rows resizes it with no drag.
 *
 * These are the two properties worth protecting, and they pull in opposite
 * directions:
 *
 *   1. The panel must be TALL ENOUGH — clipped rows are worse than empty space.
 *   2. It must not be TALLER — the empty band under the pagination is the whole
 *      complaint.
 *
 * The hysteresis in `nextRows` is where they meet, and it is the part most likely
 * to be "simplified" into a loop that writes a layout twice a second.
 */

const item = (i: string, h: number): LayoutItem => ({ i, x: 0, y: 0, w: 12, h });

describe('capacityPx', () => {
  it('counts the gaps BETWEEN rows, not one per row', () => {
    // 3 rows = 3 x 40 tall with 2 x 16 gaps. Using `rows` gaps drifts further from
    // the content the taller the panel gets.
    expect(capacityPx(3)).toBe(3 * ROW_HEIGHT + 2 * MARGIN_Y);
    expect(capacityPx(1)).toBe(ROW_HEIGHT);
  });
});

describe('rowsForHeight', () => {
  it('is the inverse of capacityPx — the fewest rows that FIT', () => {
    for (const px of [100, 217, 400, 401, 1000, 2400]) {
      const rows = rowsForHeight(px);
      // Always tall enough: a clipped row is worse than an empty one.
      expect(capacityPx(rows)).toBeGreaterThanOrEqual(px);
      // …and never taller than needed, EXCEPT where the floor is holding it up.
      // 100px asks for 2 rows and gets MIN_AUTO_ROWS; asserting minimality there
      // would be asserting that the floor does not work.
      if (rows > MIN_AUTO_ROWS) expect(capacityPx(rows - 1)).toBeLessThan(px);
    }
  });

  it('is minimal for every height above the floor, exhaustively', () => {
    // The loop above samples; this one leaves no gap for an off-by-one to hide in.
    for (let px = capacityPx(MIN_AUTO_ROWS) + 1; px < 3000; px += 7) {
      const rows = rowsForHeight(px);
      expect(capacityPx(rows)).toBeGreaterThanOrEqual(px);
      expect(capacityPx(rows - 1)).toBeLessThan(px);
    }
  });

  it('never collapses a panel below the floor', () => {
    // The alarms panel is empty whenever the plant is healthy, which is most of
    // the time. A card shrunk to its title bar reads as a broken render.
    expect(rowsForHeight(0)).toBe(MIN_AUTO_ROWS);
    expect(rowsForHeight(10)).toBe(MIN_AUTO_ROWS);
    expect(rowsForHeight(Number.NaN)).toBe(MIN_AUTO_ROWS);
    expect(rowsForHeight(-500)).toBe(MIN_AUTO_ROWS);
  });
});

describe('nextRows — the hysteresis', () => {
  it('takes the measurement outright when nothing is allocated yet', () => {
    expect(nextRows(null, capacityPx(9))).toBe(9);
  });

  it('GROWS as soon as the content overflows', () => {
    // Clipped rows are worse than empty space, so growth is never deadbanded.
    // This is the 25 -> 50 case.
    expect(nextRows(9, capacityPx(9) + 1)).toBeGreaterThan(9);
    expect(nextRows(9, capacityPx(18))).toBe(18);
  });

  it('SHRINKS once a whole row is free', () => {
    // This is the 50 -> 25 case, and it is what closes the empty band.
    expect(nextRows(18, capacityPx(9))).toBe(9);
  });

  it('HOLDS at the taller height when the content sits exactly on a row boundary', () => {
    /**
     * THE assertion of this file. Shrinking is deliberately HARDER than growing,
     * and this is the case that distinguishes real damping from the version that
     * only looks like it: at 9 rows allocated and content of exactly
     * `capacityPx(8)`, the undamped rule shrinks to 8 — and one re-wrapped pixel
     * grows it straight back to 9, forever.
     *
     * `rowsForHeight(capacityPx(8))` IS 8, so this fails for anything that just
     * returns the measurement.
     */
    expect(rowsForHeight(capacityPx(8))).toBe(8);
    expect(nextRows(9, capacityPx(8))).toBe(9);
  });

  it('does not flip between two heights when the content wobbles across a boundary', () => {
    // The `line-clamp-2` / page-scrollbar loop, simulated: the measurement
    // alternates by one pixel around a row boundary. It must settle, not alternate.
    const wobble = [capacityPx(8), capacityPx(8) + 1];
    let rows = nextRows(null, wobble[1]);
    const seen = new Set<number>();
    for (let n = 0; n < 20; n += 1) {
      rows = nextRows(rows, wobble[n % 2]);
      if (n > 2) seen.add(rows);
    }
    expect(seen.size).toBe(1);
  });

  it('still holds inside the band when nothing has changed', () => {
    const settled = capacityPx(9);
    expect(nextRows(9, settled)).toBe(9);
    expect(nextRows(9, settled - 1)).toBe(9);
  });

  it('does not drift when fed its own settled height over and over', () => {
    // The loop this guards against writes a layout on every frame while looking
    // stable on screen.
    let rows = nextRows(null, 500);
    for (let n = 0; n < 25; n += 1) rows = nextRows(rows, 500);
    expect(rows).toBe(rowsForHeight(500));
  });
});

describe('applyAutoHeights', () => {
  it('overrides the height of auto panels only', () => {
    const items = [item('telemetry_table', 8), item('telemetry_floorplan', 12)];
    const out = applyAutoHeights(items, { telemetry_table: 20, telemetry_floorplan: 3 });
    expect(out[0].h).toBe(20);
    // The floorplan has NO natural height — it scales to its box — so a measured
    // value must never reach it even if one is somehow supplied.
    expect(out[1].h).toBe(12);
  });

  it('keeps the stored height until a measurement arrives', () => {
    // The first paint uses the saved arrangement rather than snapping from a
    // default, which would read as the layout having been lost.
    const out = applyAutoHeights([item('telemetry_table', 8)], {});
    expect(out[0].h).toBe(8);
  });

  it('leaves x, y and w alone', () => {
    const out = applyAutoHeights([{ i: 'telemetry_table', x: 3, y: 4, w: 6, h: 8 }], { telemetry_table: 20 });
    expect(out[0]).toEqual({ i: 'telemetry_table', x: 3, y: 4, w: 6, h: 20 });
  });
});

describe('keepStoredHeights', () => {
  it('restores the stored height of an auto panel before saving', () => {
    // Without this, Save writes whatever height was on screen at that moment into
    // `role_configs`, and every viewer inherits one page size's worth of rows.
    const stored = [item('telemetry_table', 8), item('telemetry_floorplan', 12)];
    const reported = [item('telemetry_table', 31), item('telemetry_floorplan', 14)];
    const out = keepStoredHeights(reported, stored);
    expect(out[0].h).toBe(8);
    // The floorplan's dragged height IS the operator's intent and must survive.
    expect(out[1].h).toBe(14);
  });

  it('keeps the moved x/y — only the derived height is discarded', () => {
    const out = keepStoredHeights(
      [{ i: 'telemetry_table', x: 6, y: 9, w: 6, h: 31 }],
      [{ i: 'telemetry_table', x: 0, y: 0, w: 12, h: 8 }],
    );
    expect(out[0]).toEqual({ i: 'telemetry_table', x: 6, y: 9, w: 6, h: 8 });
  });

  it('falls back to the reported height for a panel that was never stored', () => {
    expect(keepStoredHeights([item('dashboard_alarms', 11)], []) [0].h).toBe(11);
  });
});

describe('AUTO_HEIGHT_PANELS', () => {
  it('holds the two panels with a natural content height, and not the floorplan', () => {
    expect(AUTO_HEIGHT_PANELS.has('telemetry_table')).toBe(true);
    expect(AUTO_HEIGHT_PANELS.has('dashboard_alarms')).toBe(true);
    // A drawn plan scales to its box; "fit the content" is undefined for it.
    expect(AUTO_HEIGHT_PANELS.has('telemetry_floorplan')).toBe(false);
  });
});
