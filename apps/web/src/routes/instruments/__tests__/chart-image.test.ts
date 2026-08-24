import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderChartToPng } from '../chart-image';

/**
 * WHAT THIS TEST CAN AND CANNOT PROVE.
 *
 * jsdom has no 2D canvas, so the rasterising step itself — `drawImage` +
 * `toDataURL` — cannot run here, and no test in this suite has ever seen a real
 * chart PNG. That half is unverified and is stated as such rather than faked
 * with a green assertion.
 *
 * What IS verifiable, and is the part most likely to break silently: that the
 * REAL `TimeSeriesChart` gets mounted and its own SVG serialised — limit band,
 * plotted path and all — rather than a second, divergent redrawing of the same
 * numbers. If that ever regressed into a hand-rolled SVG, the printed chart
 * would stop matching the screen and nothing else would notice.
 */

const points = [
  { ts: '2026-08-24T00:00:00.000Z', value: 22.4 },
  { ts: '2026-08-24T00:05:00.000Z', value: 22.5 },
  { ts: '2026-08-24T00:10:00.000Z', value: 26.9 },
];

const input = {
  title: 'Temperature',
  unit: '°C',
  spanMs: 3_600_000,
  min: 18,
  max: 25,
  series: [{ id: 'temperature', label: 'Temperature', decimals: 1, points }],
};

/** Stand in for the canvas jsdom does not have, capturing what was drawn. */
function stubCanvas(toDataUrl: string | (() => string)) {
  const drawn: any[] = [];
  const proto = HTMLCanvasElement.prototype as any;
  const realCtx = proto.getContext;
  const realUrl = proto.toDataURL;
  proto.getContext = () => ({
    fillStyle: '',
    fillRect: () => {},
    drawImage: (...a: any[]) => drawn.push(a),
  });
  proto.toDataURL = () => (typeof toDataUrl === 'function' ? toDataUrl() : toDataUrl);
  return {
    drawn,
    restore: () => { proto.getContext = realCtx; proto.toDataURL = realUrl; },
  };
}

/** jsdom never fires load/error for a data: URL, so drive `onload` ourselves. */
function stubImageDecode() {
  const proto = Object.getOwnPropertyDescriptor(globalThis.Image.prototype, 'src');
  const seen: string[] = [];
  Object.defineProperty(globalThis.Image.prototype, 'src', {
    configurable: true,
    set(this: any, v: string) {
      seen.push(v);
      setTimeout(() => this.onload?.(), 0);
    },
    get() { return seen[seen.length - 1]; },
  });
  return {
    seen,
    restore: () => {
      if (proto) Object.defineProperty(globalThis.Image.prototype, 'src', proto);
    },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.useRealTimers(); });

describe('renderChartToPng', () => {
  it('serialises the REAL chart — its in-spec band and its plotted path', async () => {
    const canvas = stubCanvas('data:image/png;base64,AAAA');
    const image = stubImageDecode();
    cleanups.push(canvas.restore, image.restore);

    const result = await renderChartToPng(input);
    expect(result).not.toBeNull();

    const svg = decodeURIComponent(image.seen[0].replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    // The band and the dashed limit lines TimeSeriesChart draws from `min`/`max`.
    // Their presence is the evidence the limits travelled into the picture
    // rather than the picture being redrawn without them.
    expect(svg).toContain('#16a34a');
    expect(svg).toContain('stroke-dasharray="4 3"');
    // A plotted line, from the series colour and a path command.
    expect(svg).toContain('#2a78d6');
    expect(svg).toMatch(/<path[^>]+d="M[\d.]+,[\d.]+ L/);
    // Made standalone: namespaced, explicitly sized, on an opaque ground.
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="900"');
    expect(svg).toContain('fill="#ffffff"');
  });

  it('reports the raster size so the caller can place it without distorting it', async () => {
    const canvas = stubCanvas('data:image/png;base64,AAAA');
    const image = stubImageDecode();
    cleanups.push(canvas.restore, image.restore);

    const result = await renderChartToPng(input);
    expect(result!.width).toBe(1800);              // the 900 viewBox at 2x
    expect(result!.height / result!.width).toBeCloseTo(260 / 900, 5);
  });

  it('returns null — never throws — when the environment has no usable canvas', async () => {
    // No stub at all: this is jsdom's real behaviour, and the real behaviour of
    // any browser that refuses a 2D context. The caller prints a stated reason
    // and keeps the table.
    await expect(renderChartToPng(input)).resolves.toBeNull();
  });

  it('returns null when the canvas hands back something that is not a PNG', async () => {
    // A stubbed or blocked toDataURL returns "data:," in some browsers. Feeding
    // that to jsPDF throws halfway through building the document, which would
    // lose the whole report rather than just its picture.
    const canvas = stubCanvas('data:,');
    const image = stubImageDecode();
    cleanups.push(canvas.restore, image.restore);
    await expect(renderChartToPng(input)).resolves.toBeNull();
  });

  it('returns null for a series with no points — there is nothing to plot', async () => {
    const canvas = stubCanvas('data:image/png;base64,AAAA');
    const image = stubImageDecode();
    cleanups.push(canvas.restore, image.restore);
    // TimeSeriesChart renders its "No readings in this window" card instead of
    // an <svg>, so there is no element to serialise.
    const result = await renderChartToPng({
      ...input,
      series: [{ id: 'temperature', label: 'Temperature', decimals: 1, points: [] }],
    });
    expect(result).toBeNull();
  });

  it('leaves no mounted chart behind in the document', async () => {
    const canvas = stubCanvas('data:image/png;base64,AAAA');
    const image = stubImageDecode();
    cleanups.push(canvas.restore, image.restore);

    // Let earlier cases' deferred unmounts drain first, otherwise the baseline
    // counts their hosts and the assertion measures the wrong thing.
    await new Promise((r) => setTimeout(r, 5));
    const before = document.body.childElementCount;
    await renderChartToPng(input);
    await new Promise((r) => setTimeout(r, 5));
    expect(document.body.childElementCount).toBe(before);
  });
});
