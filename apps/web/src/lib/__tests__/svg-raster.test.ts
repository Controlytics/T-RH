import { describe, it, expect, afterEach, vi } from 'vitest';
import { svgMarkupToPng, svgElementToPng, pictureWithLegend, RASTER_MAX_WIDTH } from '../svg-raster';
import { STUB_PNG, withoutCanvas } from '@/test-support/canvas-stub';

/**
 * WHAT THIS CAN AND CANNOT PROVE (as `chart-image.test.ts` says of its own
 * pipeline): the canvas is the test-setup stub, so these show the pipeline
 * runs — decode, draw, `toDataURL` — at the size asked, and what is handed to
 * the decoder. Never whether the pixels are a chart: the render check does.
 */

/** Record the data URL handed to the decoder, keeping the stub's `onload`. */
function spyOnDecodedSource() {
  const previous = Object.getOwnPropertyDescriptor(globalThis.Image.prototype, 'src')!;
  const seen: string[] = [];
  Object.defineProperty(globalThis.Image.prototype, 'src', {
    configurable: true,
    set(this: HTMLImageElement, value: string) { seen.push(value); previous.set!.call(this, value); },
    get() { return previous.get!.call(this); },
  });
  return { seen, restore: () => Object.defineProperty(globalThis.Image.prototype, 'src', previous) };
}

afterEach(() => vi.restoreAllMocks());

describe('svgMarkupToPng', () => {
  it('rasterises at twice the size, white ground, and hands back a PNG with its pixel size', async () => {
    const spy = spyOnDecodedSource();
    try {
      const out = await svgMarkupToPng('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="10" height="10"/></svg>', { width: 400, height: 200 });
      expect(out).toEqual({ dataUrl: STUB_PNG, width: 800, height: 400 });
      // Decoded as an SVG data URL, encoded (not btoa — "°C" is not Latin-1).
      expect(spy.seen[0].startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    } finally { spy.restore(); }
  });

  it('never rasterises wider than RASTER_MAX_WIDTH, keeping the proportions', async () => {
    const out = await svgMarkupToPng('<svg xmlns="http://www.w3.org/2000/svg"/>', { width: 4000, height: 3000 });
    expect(out).toEqual({ dataUrl: STUB_PNG, width: RASTER_MAX_WIDTH, height: 1350 });
  });

  it('is null — never a throw, never a non-PNG — when the browser gives no 2D canvas', async () => {
    const out = await withoutCanvas(() => svgMarkupToPng('<svg xmlns="http://www.w3.org/2000/svg"/>', { width: 10, height: 10 }));
    expect(out).toBeNull();
  });

  it('is null when the canvas hands back something that is not a PNG', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:,');
    expect(await svgMarkupToPng('<svg xmlns="http://www.w3.org/2000/svg"/>', { width: 10, height: 10 })).toBeNull();
  });
});

describe('pictureWithLegend', () => {
  it("puts a key under the picture — each series' colour beside its name, text escaped — at the picture's width", async () => {
    const spy = spyOnDecodedSource();
    try {
      const out = await pictureWithLegend({ dataUrl: STUB_PNG, width: 1800, height: 840 }, [
        { label: 'CWH/RDU/101-01 · Temperature', color: 'var(--chart-series-1, #2a78d6)' },
        { label: 'A <b> & C', color: '#eb6834' },
      ]);
      expect(out?.dataUrl).toBe(STUB_PNG);
      // 900 user units wide at 2x; taller than the picture by the key's row.
      expect(out?.width).toBe(1800);
      expect(out!.height).toBeGreaterThan(840);
      const markup = decodeURIComponent(spy.seen[0].replace('data:image/svg+xml;charset=utf-8,', ''));
      expect(markup).toContain(`href="${STUB_PNG}"`);
      expect(markup).toContain('CWH/RDU/101-01 · Temperature');
      expect(markup).toContain('A &lt;b&gt; &amp; C');
      // The swatch is the colour's own hex — a CSS variable means nothing outside the page.
      expect(markup).toContain('fill="#2a78d6"');
      expect(markup).not.toContain('var(--');
    } finally { spy.restore(); }
  });

  it('wraps a long key onto more rows rather than running off the picture', async () => {
    const one = await pictureWithLegend({ dataUrl: STUB_PNG, width: 1800, height: 840 }, [{ label: 'x', color: '#000000' }]);
    const many = await pictureWithLegend({ dataUrl: STUB_PNG, width: 1800, height: 840 },
      Array.from({ length: 6 }, (_, n) => ({ label: `CWH/RDU/10${n}-01 · Temperature of the long room`, color: '#000000' })));
    expect(many!.height).toBeGreaterThan(one!.height);
  });
});

describe('svgElementToPng', () => {
  it('serialises a LIVE svg at its viewBox size with the computed paint inlined, the live element untouched', async () => {
    document.body.innerHTML = '<div><svg viewBox="0 0 300 150" class="h-full w-full" role="img"><rect class="room" x="0" y="0" width="10" height="10"></rect><text class="label">QC 3 °C</text></svg></div>';
    const live = document.querySelector('svg')!;
    const real = window.getComputedStyle.bind(window);
    // jsdom resolves no stylesheet paint; stand in for a class the page's CSS paints.
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const s = real(el);
      if (el.classList.contains('room')) {
        return { ...s, getPropertyValue: (p: string) => (p === 'fill' ? 'rgb(1, 2, 3)' : s.getPropertyValue(p)) } as CSSStyleDeclaration;
      }
      return s;
    });
    const spy = spyOnDecodedSource();
    try {
      const out = await svgElementToPng(live);
      expect(out).toEqual({ dataUrl: STUB_PNG, width: 600, height: 300 });
      const markup = decodeURIComponent(spy.seen[0].replace('data:image/svg+xml;charset=utf-8,', ''));
      expect(markup).toContain('fill: rgb(1, 2, 3)');
      expect(markup).toContain('width="300"');
      expect(markup).toContain('height="150"');
      expect(markup).toContain('QC 3 °C');
      // The page's own element keeps its classes and gains no inline paint.
      expect(live.getAttribute('class')).toBe('h-full w-full');
      expect(live.querySelector('rect')!.getAttribute('style')).toBeNull();
    } finally { spy.restore(); }
  });
});
