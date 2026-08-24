import { describe, it, expect, afterEach } from 'vitest';
import { renderChartToPng } from '../chart-image';
import { STUB_PNG, withoutCanvas } from '@/test-support/canvas-stub';

/**
 * WHAT THIS TEST CAN AND CANNOT PROVE.
 *
 * `test-setup.ts` installs a canvas stub, so the rasterising path really runs
 * here — mount, serialise, decode, draw, `toDataURL`. What the stub hands back
 * is a canned 1×1 PNG, so these tests show the PIPELINE works and that a caller
 * receives an image of the right dimensions. **They say nothing about whether
 * the pixels are a chart.** No test in this repo has seen the rendered image;
 * that needs a real browser and a human.
 *
 * What IS verifiable, and is the part most likely to break silently: that the
 * REAL `TimeSeriesChart` gets mounted and its own SVG serialised — limit band,
 * plotted path and all — rather than a second, divergent redrawing of the same
 * numbers. If that regressed into a hand-rolled SVG the printed chart would
 * stop matching the screen and nothing else would notice.
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

/** Record the data URL handed to the decoder, without disturbing the stub's
 *  `onload`, so the serialised SVG can be inspected. */
function spyOnDecodedSource() {
  const previous = Object.getOwnPropertyDescriptor(globalThis.Image.prototype, 'src')!;
  const seen: string[] = [];
  Object.defineProperty(globalThis.Image.prototype, 'src', {
    configurable: true,
    set(this: HTMLImageElement, v: string) {
      seen.push(v);
      previous.set!.call(this, v);
    },
    get(this: HTMLImageElement) { return previous.get!.call(this); },
  });
  return {
    seen,
    restore: () => Object.defineProperty(globalThis.Image.prototype, 'src', previous),
  };
}

/** Make `toDataURL` return something that is not a PNG, for one test. */
function stubBadDataUrl(value: string) {
  const proto = HTMLCanvasElement.prototype as any;
  const previous = Object.getOwnPropertyDescriptor(proto, 'toDataURL')!;
  proto.toDataURL = () => value;
  return { restore: () => Object.defineProperty(proto, 'toDataURL', previous) };
}

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('renderChartToPng', () => {
  it('serialises the REAL chart — its in-spec band and its plotted path', async () => {
    const spy = spyOnDecodedSource();
    cleanups.push(spy.restore);

    const result = await renderChartToPng(input);
    expect(result).not.toBeNull();

    const svg = decodeURIComponent(spy.seen[0].replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    // The band and the dashed limit lines TimeSeriesChart draws from `min`/`max`.
    // Their presence is the evidence the limits travelled into the picture,
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

  it('completes the raster and returns a PNG data URL', async () => {
    const result = await renderChartToPng(input);
    // The stub's canned PNG — proof the path reached `toDataURL`, NOT proof
    // that the image depicts anything.
    expect(result!.dataUrl).toBe(STUB_PNG);
  });

  it('reports the raster size so the caller can place it without distorting it', async () => {
    const result = await renderChartToPng(input);
    expect(result!.width).toBe(1800);              // the 900 viewBox at 2x
    expect(result!.height / result!.width).toBeCloseTo(260 / 900, 5);
  });

  it('returns null — never throws — when the environment has no usable canvas', async () => {
    // jsdom's real behaviour, and the real behaviour of any browser that
    // refuses a 2D context. The caller prints a stated reason and keeps the
    // summary and table.
    await withoutCanvas(async () => {
      await expect(renderChartToPng(input)).resolves.toBeNull();
    });
  });

  it('returns null when the canvas hands back something that is not a PNG', async () => {
    // A stubbed or blocked toDataURL returns "data:," in some browsers. Feeding
    // that to jsPDF throws halfway through building the document, which would
    // lose the whole report rather than just its picture.
    const bad = stubBadDataUrl('data:,');
    cleanups.push(bad.restore);
    await expect(renderChartToPng(input)).resolves.toBeNull();
  });

  it('returns null for a series with no points — there is nothing to plot', async () => {
    // TimeSeriesChart renders its "No readings in this window" card instead of
    // an <svg>, so there is no element to serialise.
    const result = await renderChartToPng({
      ...input,
      series: [{ id: 'temperature', label: 'Temperature', decimals: 1, points: [] }],
    });
    expect(result).toBeNull();
  });

  it('leaves no mounted chart behind in the document', async () => {
    // Let earlier cases' deferred unmounts drain first, otherwise the baseline
    // counts their hosts and the assertion measures the wrong thing.
    await new Promise((r) => setTimeout(r, 5));
    const before = document.body.childElementCount;
    await renderChartToPng(input);
    await new Promise((r) => setTimeout(r, 5));
    expect(document.body.childElementCount).toBe(before);
  });
});
