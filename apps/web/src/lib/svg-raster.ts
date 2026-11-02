/**
 * An SVG, rasterised to a PNG a PDF can print (2026-11-02, widget reports).
 *
 * jsPDF's `addImage` takes PNG or JPEG, never SVG — and every chart on the
 * dashboards is SVG (the hand-rolled `TimeSeriesChart`, ECharts' SVG renderer,
 * the drawn floor plan). This is the one step from an SVG to a PNG for the
 * widget reports: decode the SVG as an image, draw it on a white canvas at up
 * to twice its size, read the PNG back.
 *
 * `routes/instruments/chart-image.ts` does the same last step for the trend
 * page's printed charts and keeps its own copy (it is not this task's file);
 * folding it onto this one is a follow-up.
 *
 * Returns `null` rather than throwing when the environment cannot do it (no 2D
 * canvas, a stubbed or blocked `toDataURL`, an SVG the decoder refuses or
 * never answers). The caller prints a stated substitute — a report missing its
 * picture says so; it never quietly looks complete.
 */

export interface RasterImage {
  /** `data:image/png;base64,…`, ready for `addImage`. */
  dataUrl: string;
  /** Its size in pixels, so a caller can keep its proportions. */
  width: number;
  height: number;
}

/**
 * The widest PNG this makes, in px. A report snapshot carries its pictures
 * (and its logo) inside the request body, which the server caps at 8 MB, so a
 * floor plan with a huge viewBox must not become a huge PNG. 1800 = a 900 px
 * chart at 2x, legible on a 182 mm column (chart-image.ts's figure).
 */
export const RASTER_MAX_WIDTH = 1800;

/** How long a decode may take before the picture is given up (jsdom, a blocked decoder: neither event fires). */
const DECODE_TIMEOUT_MS = 8_000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('The picture did not decode in time.')), DECODE_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('The picture could not be decoded.')); };
    img.src = src;
  });
}

/**
 * SVG markup (a whole document, its size in user units) → a PNG, at twice
 * that size or `RASTER_MAX_WIDTH`, whichever is narrower; proportions kept.
 */
export async function svgMarkupToPng(markup: string, size: { width: number; height: number }): Promise<RasterImage | null> {
  if (!(size.width > 0) || !(size.height > 0)) return null;
  const scale = Math.min(2, RASTER_MAX_WIDTH / size.width);
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  // The canvas is claimed BEFORE the decode is awaited: with no 2D context
  // there can never be a PNG, and finding that out first is immediate.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    // encodeURIComponent, not btoa: labels carry "°C", which is not Latin-1.
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith('data:image/png')) return null;
    return { dataUrl, width, height };
  } catch (e) {
    // Said, not hidden: the caller prints that the picture is missing.
    console.warn('[report] a picture could not be rasterised:', e);
    return null;
  }
}

/**
 * The paint and type properties a page's stylesheet may give an SVG element
 * through a CLASS — lost when the markup leaves the page, so copied inline.
 */
const INLINED = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'opacity', 'visibility', 'display',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline',
  'paint-order',
] as const;

/**
 * A LIVE svg on the page (the floor plan a widget draws) → a PNG, at its
 * viewBox size. The element is CLONED, the clone carries each element's
 * computed paint inline (the page's classes do not travel with the markup), a
 * white ground, and the page's font named — the page's own element is never
 * touched.
 */
export async function svgElementToPng(svg: SVGSVGElement): Promise<RasterImage | null> {
  const [, , vbW, vbH] = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const box = svg.getBoundingClientRect();
  const width = vbW > 0 ? vbW : box.width;
  const height = vbH > 0 ? vbH : box.height;
  if (!(width > 0) || !(height > 0)) return null;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const liveEls = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll('*'))];
  liveEls.forEach((el, n) => {
    const target = cloneEls[n] as SVGElement | undefined;
    if (!target) return;
    const computed = window.getComputedStyle(el);
    const inline = INLINED
      .map((p) => [p, computed.getPropertyValue(p)] as const)
      .filter(([, v]) => v !== '' && v !== undefined && v !== null)
      .map(([p, v]) => `${p}: ${v}`)
      .join('; ');
    const own = target.getAttribute('style');
    if (inline) target.setAttribute('style', own ? `${inline}; ${own}` : inline);
  });
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.removeAttribute('class');
  clone.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
  const [x, y] = (svg.getAttribute('viewBox') ?? '0 0').split(/[\s,]+/).map(Number);
  const ground = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  ground.setAttribute('x', String(Number.isFinite(x) ? x : 0));
  ground.setAttribute('y', String(Number.isFinite(y) ? y : 0));
  ground.setAttribute('width', String(width));
  ground.setAttribute('height', String(height));
  ground.setAttribute('fill', '#ffffff');
  clone.insertBefore(ground, clone.firstChild);
  return svgMarkupToPng(withSvgNamespace(new XMLSerializer().serializeToString(clone)), { width, height });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The SVG namespace on the root tag, ONCE: a decoder refuses a document that
 * lacks it, and an XML parser refuses one that carries it twice (jsdom's
 * serializer writes it; a browser's may, too).
 */
function withSvgNamespace(markup: string): string {
  return /^<svg\b[^>]*\sxmlns=/.test(markup) ? markup : markup.replace(/^<svg\b/, `<svg xmlns="${SVG_NS}"`);
}

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** A colour as a printed picture can use it: the hex inside `var(--x, #hex)`, else the value as given. */
function plainColor(color: string): string {
  return color.match(/#[0-9a-f]{3,8}\b/i)?.[0] ?? color;
}

/**
 * A picture with its KEY under it: each series' colour beside its name, in
 * rows that wrap at the picture's width (2026-11-02). The trend chart's legend
 * is HTML beside its SVG, so its raster has none; a printed chart of several
 * series must still say which line is which — identity is never colour alone.
 */
export async function pictureWithLegend(
  image: RasterImage,
  items: readonly { label: string; color: string }[],
): Promise<RasterImage | null> {
  const width = 900;
  const chartH = Math.round((image.height * width) / image.width);
  const pad = 12;
  const rowH = 20;
  const charPx = 6.4; // 11 px Helvetica, generously
  let x = pad;
  let row = 0;
  const parts: string[] = [];
  for (const item of items) {
    const w = 14 + item.label.length * charPx + 22;
    if (x > pad && x + w > width - pad) { x = pad; row += 1; }
    const y = chartH + 8 + row * rowH;
    parts.push(
      `<rect x="${x}" y="${y}" width="10" height="10" rx="2" fill="${escapeXml(plainColor(item.color))}"/>`,
      `<text x="${x + 14}" y="${y + 9}">${escapeXml(item.label)}</text>`,
    );
    x += w;
  }
  const height = chartH + 8 + (row + 1) * rowH + 4;
  const markup = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`
    + `<image href="${image.dataUrl}" x="0" y="0" width="${width}" height="${chartH}"/>`
    + `<g font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#334155">${parts.join('')}</g></svg>`;
  return svgMarkupToPng(markup, { width, height });
}
