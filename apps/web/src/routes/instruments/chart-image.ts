import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createElement } from 'react';
import { TimeSeriesChart, type ChartSeries } from '@/routes/dashboard/time-series-chart';

/**
 * A trend chart, rasterised, so a PDF can show the picture the operator saw.
 *
 * WHY IT RENDERS THE REAL COMPONENT. The obvious alternative — re-emitting the
 * SVG from the same geometry maths — would be a SECOND derivation of the axis
 * scale, the in-spec band and the plotted path. This repo's whole position on
 * limits and decimals is that a second derivation is how a printed record comes
 * to contradict the screen it documents, and a chart is no different: an axis
 * rounded one way on screen and another way on paper is a §11 record that
 * misdescribes itself. So `TimeSeriesChart` is mounted for real, off-screen,
 * and its own SVG is serialised. One derivation, one picture.
 *
 * `flushSync` is what makes that synchronous — React 19 would otherwise batch
 * the mount and hand back an empty container.
 *
 * The chart is mounted with NO hover state (it is never pointed at), so the
 * crosshair and the hover readout are absent by construction rather than
 * stripped afterwards.
 */

export interface ChartImage {
  /** PNG data URL, ready for `doc.addImage`. */
  dataUrl: string;
  /** Natural width/height, so the caller can size it without distorting it. */
  width: number;
  height: number;
}

export interface ChartImageInput {
  title: string;
  unit: string;
  spanMs: number;
  min?: number | null;
  max?: number | null;
  /** The attribute's own text for each bound, printed beside the limit line
   *  in the number's place (operator, 2026-10-03). */
  minText?: string | null;
  maxText?: string | null;
  series: ChartSeries[];
}

/** Pixel width the SVG is rasterised at. 1800 = the chart's own 900 viewBox at
 *  2x, which is legible when a 900px-wide picture is scaled onto a 182mm page. */
const RASTER_WIDTH = 1800;

/**
 * Mount the chart off-screen, serialise its SVG, and rasterise it to a PNG.
 *
 * Returns `null` rather than throwing when the environment cannot do it (no
 * canvas, a `toDataURL` that is stubbed or blocked, an SVG the image decoder
 * rejects). The caller prints a stated substitute and keeps the table: a report
 * missing its picture is a lesser failure than no report at all, and it must
 * say which it is rather than quietly look complete.
 */
export async function renderChartToPng(input: ChartImageInput): Promise<ChartImage | null> {
  const host = document.createElement('div');
  // Off-screen, not `display:none` — a hidden subtree still lays out for SVG,
  // but width:0 would collapse the container the chart sizes itself against.
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;pointer-events:none;';
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    flushSync(() => {
      root.render(createElement(TimeSeriesChart, input));
    });

    const svg = host.querySelector('svg');
    // No SVG means the component took its "No readings in this window" branch.
    // That is a legitimate outcome, not a failure, and there is nothing to draw.
    if (!svg) return null;

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // The live element sizes itself from CSS classes that will not travel with
    // the serialised markup, so the intrinsic size is stated explicitly.
    const [, , vbW, vbH] = (svg.getAttribute('viewBox') ?? '0 0 900 260').split(/\s+/).map(Number);
    clone.setAttribute('width', String(vbW));
    clone.setAttribute('height', String(vbH));
    clone.removeAttribute('class');
    // The chart draws on the card's white surface; without this the PNG carries
    // a transparent ground that prints as whatever is under it.
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('width', String(vbW)); bg.setAttribute('height', String(vbH));
    bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, clone.firstChild);
    // The text nodes inherit their font from the page; name it so the raster
    // does not fall back to a serif face the operator never saw.
    clone.setAttribute('font-family', 'Helvetica, Arial, sans-serif');

    const markup = new XMLSerializer().serializeToString(clone);
    // encodeURIComponent, not btoa: the axis labels and the unit strings are
    // not Latin-1 (°C alone breaks btoa) and a throw here would lose the chart.
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

    const scale = RASTER_WIDTH / vbW;
    const outW = Math.round(vbW * scale);
    const outH = Math.round(vbH * scale);

    // The canvas is claimed BEFORE the decode is awaited: an environment with
    // no 2D context (jsdom, a browser refusing it) can never produce a PNG, and
    // finding that out first turns an eight-second timeout into an immediate
    // "no chart".
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const img = await loadImage(svgUrl);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);

    const dataUrl = canvas.toDataURL('image/png');
    // A stub canvas (jsdom, a browser refusing the read) hands back something
    // that is not a PNG. Treat it as "no chart" rather than feeding jsPDF a
    // string it will throw on halfway through building the document.
    if (!dataUrl.startsWith('data:image/png')) return null;
    return { dataUrl, width: outW, height: outH };
  } catch {
    return null;
  } finally {
    // Unmount is deferred: React forbids it during the commit that flushSync
    // is still unwinding.
    setTimeout(() => { root.unmount(); host.remove(); }, 0);
  }
}

/**
 * How long to wait for the SVG to decode before giving up on the picture.
 *
 * There IS a third outcome besides load and error: neither. An `Image` handed a
 * source its environment will not decode can simply never fire — jsdom does
 * exactly this — and without a bound the await never returns, the download
 * never reaches its `save()`, and the dialog sits on "Downloading…" forever.
 * That is the same silent non-download this whole change set exists to remove,
 * so the wait is bounded and a timeout is treated as "no chart": the report
 * still prints, and it says the picture is missing.
 */
const DECODE_TIMEOUT_MS = 8_000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(
      () => reject(new Error('The chart image did not decode in time.')),
      DECODE_TIMEOUT_MS,
    );
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('The chart image could not be decoded.')); };
    img.src = src;
  });
}
