import { describe, it, expect } from 'vitest';
import { pixelToTime, normalizeSelection } from '../chart-zoom.js';

/**
 * These unit tests are the ONLY automated check drag-to-zoom will ever get:
 * Playwright cannot authenticate against this app (its browser will not trust
 * the mkcert API certificate for cross-origin XHR), so no browser test can
 * reach the chart. Hence the geometry lives here, pure, and is tested hard.
 */

describe('pixelToTime', () => {
  const t0 = 1_700_000_000_000;
  const t1 = t0 + 3_600_000;

  it('maps the plot edges to the range edges', () => {
    expect(pixelToTime(46, 46, 800, t0, t1)).toBe(t0);
    expect(pixelToTime(846, 46, 800, t0, t1)).toBe(t1);
  });

  it('maps the midpoint to the middle of the range', () => {
    expect(pixelToTime(446, 46, 800, t0, t1)).toBe(t0 + 1_800_000);
  });

  it('clamps outside the plot area rather than extrapolating', () => {
    expect(pixelToTime(0, 46, 800, t0, t1)).toBe(t0);
    expect(pixelToTime(2000, 46, 800, t0, t1)).toBe(t1);
  });

  it('clamps a negative pixel to the range start', () => {
    expect(pixelToTime(-500, 46, 800, t0, t1)).toBe(t0);
  });

  it('returns a whole millisecond, never a fraction', () => {
    // A telemetry instant is an integer ms; a fractional one would round-trip
    // through `new Date(...).toISOString()` with a `.500` the record never had.
    //
    // The inputs are chosen to make `Math.round` LOAD-BEARING: a FRACTIONAL
    // pixel (which is what the chart actually feeds this — `viewX` scales
    // client px into viewBox units and almost never lands on an integer) over
    // a span not divisible by `plotW`. With the tidy 4500 ms/px fixture the
    // other cases use, every integer pixel already yields an integer and this
    // assertion would pass with the rounding deleted.
    const odd = t0 + 3_600_001;
    const t = pixelToTime(123.7, 46, 800, t0, odd);
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBe(t0 + 349_650); // unrounded this is …650.097
  });

  /**
   * All readings at one instant — reachable: the chart's own `sx` guards
   * `t1 === t0` explicitly, which happens with a single reading in the window.
   * Every pixel must resolve to that instant, and the selection that follows
   * must then be rejected rather than setting a zero-width range.
   */
  it('collapses to the single instant when the range has no width', () => {
    expect(pixelToTime(46, 46, 800, t0, t0)).toBe(t0);
    expect(pixelToTime(500, 46, 800, t0, t0)).toBe(t0);
    expect(pixelToTime(846, 46, 800, t0, t0)).toBe(t0);
  });
});

describe('normalizeSelection', () => {
  /**
   * NOTE: the spec wrote this case as `(900, 100, 1000)` → `{100, 900}`, which
   * contradicts itself — that drag spans 800, under its own 1000 floor, so the
   * next case in this file would demand `null` for it. The intent (a backwards
   * drag comes back ordered) is kept; the minimum span is set below the drag's
   * width so the case tests ordering rather than the floor.
   */
  it('orders a right-to-left drag', () => {
    expect(normalizeSelection(900, 100, 100)).toEqual({ from: 100, to: 900 });
  });

  it('leaves a left-to-right drag alone', () => {
    expect(normalizeSelection(100, 900, 500)).toEqual({ from: 100, to: 900 });
  });

  /**
   * A click is a zero-width drag. Without this guard it would set an empty range,
   * the refetch would return nothing, and the chart would go blank on a stray click.
   */
  it('rejects a selection narrower than the minimum span', () => {
    expect(normalizeSelection(500, 500, 1000)).toBeNull();
    expect(normalizeSelection(500, 900, 1000)).toBeNull();
  });

  it('rejects a too-narrow right-to-left drag as well', () => {
    expect(normalizeSelection(900, 500, 1000)).toBeNull();
  });

  it('accepts a selection at exactly the minimum span', () => {
    expect(normalizeSelection(500, 1500, 1000)).toEqual({ from: 500, to: 1500 });
  });

  it('accepts anything when the minimum span is zero and the drag has width', () => {
    expect(normalizeSelection(0, 1, 0)).toEqual({ from: 0, to: 1 });
  });
});

describe('pixelToTime + normalizeSelection composed', () => {
  const t0 = 1_700_000_000_000;
  const t1 = t0 + 3_600_000; // one hour across 800px → 4500 ms per pixel
  const LEFT = 46;
  const PLOT_W = 800;
  const MIN_SPAN = 60_000; // the chart's own floor

  const drag = (aPx: number, bPx: number) =>
    normalizeSelection(
      pixelToTime(aPx, LEFT, PLOT_W, t0, t1),
      pixelToTime(bPx, LEFT, PLOT_W, t0, t1),
      MIN_SPAN,
    );

  it('turns a middle drag into the instants it covers', () => {
    // 246px → 646px is a quarter to three quarters of the hour.
    expect(drag(246, 646)).toEqual({ from: t0 + 900_000, to: t0 + 2_700_000 });
  });

  it('orders a right-to-left drag into the same window', () => {
    expect(drag(646, 246)).toEqual({ from: t0 + 900_000, to: t0 + 2_700_000 });
  });

  /**
   * Dragging past both edges in opposite directions. This is the case the
   * clamp exists for: it must select the whole plotted window, not extrapolate
   * beyond the data into a range the server holds nothing for.
   */
  it('selects the whole window when the drag runs off both ends', () => {
    expect(drag(1500, -300)).toEqual({ from: t0, to: t1 });
  });

  /** A stray click: same pixel twice, so zero width, so no zoom. */
  it('rejects a click', () => {
    expect(drag(400, 400)).toBeNull();
  });

  /**
   * ~13px is under a minute at this scale. Rejected — the guard is on TIME,
   * not on pixels, so the same gesture zooms on a wide window and is ignored
   * on a narrow one, which is the correct behaviour.
   */
  it('rejects a drag shorter than a minute of data', () => {
    expect(drag(400, 410)).toBeNull();
  });

  it('accepts the same pixel drag on a window wide enough for it to matter', () => {
    const wide = t0 + 30 * 24 * 3_600_000; // 30 days
    expect(
      normalizeSelection(
        pixelToTime(400, LEFT, PLOT_W, t0, wide),
        pixelToTime(410, LEFT, PLOT_W, t0, wide),
        MIN_SPAN,
      ),
    ).not.toBeNull();
  });

  it('rejects any drag when every reading sits at one instant', () => {
    expect(
      normalizeSelection(
        pixelToTime(100, LEFT, PLOT_W, t0, t0),
        pixelToTime(800, LEFT, PLOT_W, t0, t0),
        MIN_SPAN,
      ),
    ).toBeNull();
  });
});
