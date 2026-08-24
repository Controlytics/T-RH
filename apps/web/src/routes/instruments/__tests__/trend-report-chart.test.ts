import { describe, it, expect, vi } from 'vitest';
import { renderTrendReport, type TrendChartSection } from '../trend-report';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * What this guards.
 *
 * Before 2026-08-24 the "Instrument Trend" PDF was the Instrument Time Series
 * PDF with a different title bar: same table, same columns, same rows, no
 * chart. Measured — the two files came out 8661 and 8659 bytes, two bytes
 * apart. A trend report that shows no trend is not a trend report, and an
 * operator who asked for one and got a second copy of the table below it would
 * reasonably report that the download did nothing.
 *
 * So the assertions here are on the PICTURE and on the words actually drawn.
 * A test that only checked `renderTrendReport()` resolves without throwing
 * would pass against exactly the defect it exists to catch — the old renderer
 * resolved fine.
 */

const instrument = {
  code: 'DEMO-TH-142',
  name: 'Demo probe',
  locationText: 'Room CWH-I/142',
  limitsText: '18.0 - 25.0 (from this instrument)',
};
const period = { from: '2026-08-24T00:00:00.000Z', to: '2026-08-24T01:00:00.000Z', label: 'Last hour' };
const formatDateTime = (d: string) => d;
const keys = [{ key: 't', label: 'Temperature (°C)', decimals: 1 }];
const rows = [
  { ts: '2026-08-24T00:10:00.000Z', values: { t: 22.4 } },
  { ts: '2026-08-24T00:20:00.000Z', values: { t: 22.5 } },
];

/** A 1x1 PNG — the smallest thing jsPDF will accept as an image. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const drawnChart: TrendChartSection = {
  title: 'Temperature',
  image: { dataUrl: PNG, width: 1800, height: 520 },
  unavailableReason: '',
};

type Input = Parameters<typeof renderTrendReport>[0];

function baseInput(overrides: Partial<Input> = {}): Input {
  return {
    slotLabel: 'Temperature',
    charts: [drawnChart],
    rows,
    keys,
    instrument,
    period,
    formatDateTime,
    averagedLabel: null,
    ...overrides,
  };
}

/**
 * Render, and read back what the document actually contains.
 *
 * `text` comes out of jsPDF's own uncompressed page content streams rather than
 * from a spy: it is what the PDF holds, not what a call was asked to draw. That
 * matters because the averaging disclosure deliberately does NOT go through
 * `addSectionTitle` (that primitive does not wrap, and a §11 statement the
 * reader cannot finish reading is not a statement), so `getSnapshot()` cannot
 * see it either.
 *
 * `addImage` IS spied, on the prototype — an embedded image leaves no legible
 * trace in the stream. (`text` cannot be spied the same way: jsPDF binds it as
 * an own property of each instance, not on `API`.)
 */
async function capture(input: Input): Promise<{ images: any[][]; text: string; report: any }> {
  const jspdf: any = await import('jspdf');
  const realImage = jspdf.default.API.addImage;
  const images: any[][] = [];
  jspdf.default.API.addImage = function (...args: any[]) { images.push(args); return realImage.apply(this, args); };
  let report: any;
  try {
    report = await renderTrendReport(input);
  } finally {
    jspdf.default.API.addImage = realImage;
  }
  const pages: string[][] = report.doc.internal.pages;
  const raw = pages.filter(Boolean).flat().join('\n');
  // Pull the drawn strings out of the content stream and rejoin them with
  // spaces, so a sentence that `splitTextToSize` wrapped over several lines
  // reads as one sentence again — these assertions are about the words, not
  // about where they happened to break.
  const text = [...raw.matchAll(/\((.*?)\)\s*Tj/gs)]
    .map((m) => m[1].replace(/\\([()\\])/g, '$1'))
    .join(' ');
  return { images, text, report };
}

describe('the trend report shows the trend', () => {
  it('embeds the chart image in the PDF', async () => {
    const { images } = await capture(baseInput());
    // The branding logo loads over fetch, which is unavailable here, so the
    // only image this document can carry is the chart.
    expect(images.some((a) => a[0] === PNG && a[1] === 'PNG')).toBe(true);
  });

  it('draws NO chart image when the slot had nothing to plot', async () => {
    const { images } = await capture(baseInput({
      charts: [{ title: 'Temperature', image: null, unavailableReason: 'No readings in this period, so there is nothing to plot.' }],
    }));
    expect(images.filter((a) => a[0] === PNG)).toHaveLength(0);
  });

  it('sizes the chart to the text column without distorting it', async () => {
    const { images } = await capture(baseInput());
    const [, , x, , w, h] = images.find((a) => a[0] === PNG)!;
    expect(x).toBe(14);                    // the 14mm gutter pdf-report.ts uses
    // A4 less both gutters. Loose: jsPDF's own page width is 210.0016mm, not a
    // round 210, and pinning the slack would be pinning a jsPDF constant.
    expect(w).toBeCloseTo(210 - 28, 2);
    expect(h / w).toBeCloseTo(520 / 1800, 5);
  });

  it('states that the chart is averaged when it is', async () => {
    const { text } = await capture(baseInput({ averagedLabel: '5 minutes' }));
    expect(text).toMatch(/AVERAGED over 5 minutes/);
    expect(text).toMatch(/not a stored reading/);
  });

  it('says nothing about averaging at raw — there is no derived value to disclose', async () => {
    const { text } = await capture(baseInput({ averagedLabel: null }));
    expect(text).not.toMatch(/AVERAGED/);
  });

  it('names the slot in the title, so three trend reports are distinguishable', async () => {
    const t = await capture(baseInput({ slotLabel: 'Temperature' }));
    const h = await capture(baseInput({ slotLabel: 'Humidity' }));
    expect(t.report.getSnapshot().title).toBe('Instrument Trend — Temperature');
    expect(h.report.getSnapshot().title).toBe('Instrument Trend — Humidity');
    expect(t.text).toMatch(/Instrument Trend/);
  });

  it('keeps the readings table beneath the chart — the chart is the picture, the table is the record', async () => {
    const { report } = await capture(baseInput());
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x);
    expect(tables).toHaveLength(1);
    expect(tables[0].head).toEqual(['Timestamp', 'Temperature (°C)']);
    expect(tables[0].body).toEqual([
      ['2026-08-24T00:10:00.000Z', '22.4'],
      ['2026-08-24T00:20:00.000Z', '22.5'],
    ]);
  });

  it('prints the reason for a missing picture, wrapped, rather than leaving a gap that reads as no data', async () => {
    const { text } = await capture(baseInput({
      charts: [{
        title: 'Temperature',
        image: null,
        unavailableReason: 'The chart could not be rendered by this browser. The readings below are the complete record for this period.',
      }],
    }));
    expect(text).toMatch(/Temperature/);
    // splitTextToSize wraps it across drawn lines, so both halves are asserted
    // rather than the whole sentence surviving as one run.
    expect(text).toMatch(/could not be rendered by this browser/);
    expect(text).toMatch(/complete record for this period/);
  });

  it('states the row cap in the report when it truncates', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 7, 24, 0, 0, i)).toISOString(),
      values: { t: 22 + (i % 10) / 10 },
    }));
    const { text, report } = await capture(baseInput({ rows: many }));
    expect(text).toMatch(/Truncated/);
    expect(text).toMatch(/2,500/);
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x);
    expect(tables[0].body).toHaveLength(2000);
  });
});
