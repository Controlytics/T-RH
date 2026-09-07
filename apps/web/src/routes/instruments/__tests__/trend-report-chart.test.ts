import { describe, it, expect, vi } from 'vitest';
import { renderTrendReport, renderDataReport, type TrendChartSection } from '../trend-report';
import { summariseSlot, withServerSummary } from '../trend-summary';
import { scheduleRows } from '../data-report';

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

const readings = [
  { key: 't', value: 22.4, ts: '2026-08-24T00:10:00.000Z' },
  { key: 't', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
  { key: 't', value: 26.9, ts: '2026-08-24T00:30:00.000Z' },
];

const drawnChart: TrendChartSection = {
  title: 'Temperature',
  image: { dataUrl: PNG, width: 1800, height: 520 },
  unavailableReason: '',
  summary: summariseSlot(readings, 't', 'Temperature', '°C', 1, 18, 25),
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
    tableIsAveraged: false,
    coverage: { returned: 3, total: 3 },
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
      charts: [{ title: 'Temperature', image: null, summary: null, unavailableReason: 'No readings in this period, so there is nothing to plot.' }],
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
    // Two now: the period summary, then the readings.
    expect(tables).toHaveLength(2);
    const readingsTable = tables.find((t: any) => t.head[0] === 'Timestamp')!;
    expect(readingsTable.head).toEqual(['Timestamp', 'Temperature (°C)']);
    expect(readingsTable.body).toEqual([
      ['2026-08-24T00:10:00.000Z', '22.4'],
      ['2026-08-24T00:20:00.000Z', '22.5'],
    ]);
  });

  it('prints the reason for a missing picture, wrapped, rather than leaving a gap that reads as no data', async () => {
    const { text } = await capture(baseInput({
      charts: [{
        title: 'Temperature',
        image: null,
        summary: null,
        unavailableReason: 'The chart could not be rendered by this browser. The summary and the readings below still describe this period.',
      }],
    }));
    expect(text).toMatch(/Temperature/);
    // splitTextToSize wraps it across drawn lines, so both halves are asserted
    // rather than the whole sentence surviving as one run.
    expect(text).toMatch(/could not be rendered by this browser/);
    expect(text).toMatch(/still describe this period/);
  });

  it('prints the period summary under the chart', async () => {
    const { report } = await capture(baseInput());
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x);
    const summary = tables.find((t: any) => t.head[0] === 'Temperature — period summary')!;
    expect(summary).toBeTruthy();
    const byLabel = Object.fromEntries(summary.body.map((r: string[]) => [r[0], r[1]]));
    expect(byLabel['Readings']).toBe('3');
    expect(byLabel['Minimum']).toBe('22.4 °C');
    expect(byLabel['Maximum']).toBe('26.9 °C');
    expect(byLabel['Mean']).toBe('23.9 °C');
    expect(byLabel['First reading']).toContain('22.4');
    expect(byLabel['Last reading']).toContain('26.9');
    // One of the three readings is above the 25 limit.
    expect(byLabel['Out of limit']).toBe('1 of 3 readings (33.3%)');
    expect(byLabel['— below / above limit']).toBe('0 below 18.0  /  1 above 25.0');
  });

  it('says "not assessed" rather than "0 out of spec" when no limits are set', async () => {
    // Zero would read as a clean period. Nothing was checked, which is
    // a different claim entirely and the one a §11 reader needs.
    const { report } = await capture(baseInput({
      charts: [{
        ...drawnChart,
        summary: summariseSlot(readings, 't', 'Temperature', '°C', 1, null, null),
      }],
    }));
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x);
    const summary = tables.find((t: any) => t.head[0] === 'Temperature — period summary')!;
    const byLabel = Object.fromEntries(summary.body.map((r: string[]) => [r[0], r[1]]));
    expect(byLabel['Out of limit']).toMatch(/Not assessed/);
    expect(summary.body.map((r: string[]) => r[0])).not.toContain('— below / above limit');
    // And no extremes: an extreme prints only for a bound in force (operator,
    // 2026-09-07, "same in trends page also"), the Data Report's rule.
    expect(summary.body.map((r: string[]) => r[0])).not.toContain('Minimum');
    expect(summary.body.map((r: string[]) => r[0])).not.toContain('Maximum');
  });

  it('states its own coverage when the period holds more than the report received', async () => {
    const { text } = await capture(baseInput({ coverage: { returned: 500, total: 7646 } }));
    expect(text).toMatch(/REPRESENTATIVE SAMPLE/);
    expect(text).toMatch(/500 of the 7,646 stored values/);
    // Scoped to the two blocks that ARE sampled...
    expect(text).toMatch(/the chart and the readings table below/);
    // ...and saying exactly which figures below are over the whole period and
    // which are not. Since 2026-08-27 that is every figure in the summary
    // EXCEPT the first/last pair, which the sampler preserves verbatim.
    expect(text).toMatch(/readings count, minimum, maximum, mean and out-of-limit counts are all/);
    expect(text).toMatch(/computed over EVERY reading in the period, not over this sample/);
    expect(text).toMatch(/Only its first and last readings are read from this sample/);
  });

  it('offers a remedy that exists — not the Time Series report, which samples identically', async () => {
    // The Time Series branch calls the SAME `points=` fetch this report does, so
    // whenever this note prints because the sampler sampled, that report sampled
    // too. "Use the Instrument Time Series report for every stored reading" was
    // therefore false in essentially every instance it appeared — the same
    // defect class as the coverage claim, displaced onto the remedy.
    const { text } = await capture(baseInput({ coverage: { returned: 500, total: 7646 } }));
    expect(text).toMatch(/NARROW THE PERIOD/);
    expect(text).toMatch(/Instrument Time Series report is built from the same sample as this one/);
    expect(text).not.toMatch(/narrow the period or use the Instrument Time Series report/);
  });

  it('does not call the Time Series report the complete raw record anywhere', async () => {
    const { text, report } = await capture(baseInput({ averagedLabel: '5 minutes' }));
    expect(report.getSnapshot().subtitle).not.toMatch(/complete raw record/);
    expect(report.getSnapshot().subtitle).toMatch(/same readings unaveraged/);
    expect(text).not.toMatch(/complete unaveraged record/);
    // What IS true of it: unaveraged, and sampled the same way.
    expect(text).toMatch(/same period UNAVERAGED/);
    expect(text).toMatch(/built from the same sample as this report/);
  });

  it('attributes the all-keys count to the FETCH, not to a single-slot table', async () => {
    // `coverage.returned` spans every key, while a Temperature-only report's
    // table holds one slot's points. Saying "the table below holds 500 of 7,646"
    // is a count of a population that table does not have.
    const { text } = await capture(baseInput({ coverage: { returned: 500, total: 7646 } }));
    expect(text).toMatch(/this report was built from 500 of the 7,646 stored values across all keys/);
    expect(text).not.toMatch(/readings table below hold 500/);
  });

  it('does NOT claim the report covers only the most recent portion of the period', async () => {
    // It did say exactly that, and it was true while the fetch used `limit=` and
    // the server answered ORDER BY ts DESC. Under `points=` the rows are spread
    // across the whole period, so that sentence became a false statement about
    // the document's own coverage — in a signed §11 record, worse than the
    // truncation it was written to disclose.
    const { text } = await capture(baseInput({ coverage: { returned: 500, total: 7646 } }));
    expect(text).not.toMatch(/INCOMPLETE PERIOD/);
    expect(text).not.toMatch(/most recent/);
    expect(text).not.toMatch(/portion only/);
  });

  it('says nothing about coverage when the report holds the whole period', async () => {
    const { text } = await capture(baseInput({ coverage: { returned: 3, total: 3 } }));
    expect(text).not.toMatch(/REPRESENTATIVE SAMPLE/);
  });

  it('says "no limit set" for an absent bound, never "0 below —"', async () => {
    // The instrument declares a high limit and no low one. A "0 below" here
    // claims the readings were checked against a low limit and passed; nothing
    // was checked. `?? 0` in the renderer used to produce exactly that.
    const { report } = await capture(baseInput({
      charts: [{
        ...drawnChart,
        summary: withServerSummary(
          summariseSlot(readings, 't', 'Temperature', '°C', 1, null, 25),
          {
            numericCount: 3, min: 22.4, max: 26.9, avg: 23.933333,
            belowCount: null, aboveCount: 1, outOfSpecCount: 1,
            limitMin: null, limitMax: 25,
          },
        ),
      }],
    }));
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x);
    const summary = tables.find((t: any) => t.head[0] === 'Temperature — period summary')!;
    const byLabel = Object.fromEntries(summary.body.map((r: string[]) => [r[0], r[1]]));
    // The absent side is NOT narrated ("no low limit set — not assessed" until
    // 2026-09-07): a bound not in force is not shown at all, the Data Report's
    // rule applied here at the operator's "same in trends page also". The
    // Minimum goes with it; the Maximum stays.
    expect(byLabel['— below / above limit']).toBe('1 above 25.0');
    expect(byLabel['Maximum']).toBe('26.9 °C');
    expect(summary.body.map((r: string[]) => r[0])).not.toContain('Minimum');
    // And the total says what it was assessed against, so half an assessment
    // is not printed as a whole one.
    expect(byLabel['Out of limit']).toBe('1 of 3 readings (33.3%) — against the high limit only');
  });

  it('prints the SERVER\'s whole-range figures, not the sampled ones', async () => {
    // The three `readings` above are the sample the report was built from; the
    // period holds 2,500 readings and nine breaches the sampler did not draw.
    // Counted over the sample this block would say "0 out of limit".
    const { report } = await capture(baseInput({
      charts: [{
        ...drawnChart,
        summary: withServerSummary(
          summariseSlot(readings, 't', 'Temperature', '°C', 1, 18, 25),
          {
            numericCount: 2500, min: 17.0, max: 99.9, avg: 20.2,
            belowCount: 2, aboveCount: 7, outOfSpecCount: 9,
            limitMin: 18, limitMax: 25,
          },
        ),
      }],
      coverage: { returned: 3, total: 2500 },
    }));
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x);
    const summary = tables.find((t: any) => t.head[0] === 'Temperature — period summary')!;
    const byLabel = Object.fromEntries(summary.body.map((r: string[]) => [r[0], r[1]]));
    expect(byLabel['Readings']).toBe('2,500');
    expect(byLabel['Out of limit']).toBe('9 of 2,500 readings (0.4%)');
    expect(byLabel['— below / above limit']).toBe('2 below 18.0  /  7 above 25.0');
    // THE EXTREMES COME FROM THE RANGE TOO (2026-08-27). The sample's own
    // maximum is 26.9 °C, which would print directly above "7 above 25.0" — a
    // maximum below a limit the same block reports seven breaches of. The
    // printed maximum must be the range's, so a reader who cannot see the
    // readings can reconcile the two figures.
    expect(byLabel['Maximum']).toBe('99.9 °C');
    expect(byLabel['Minimum']).toBe('17.0 °C');
    expect(byLabel['Mean']).toBe('20.2 °C');
    // `first`/`last` stay row-derived — labelled claims about two instants,
    // each with its own timestamp, which the endpoint cannot supply.
    expect(byLabel['First reading']).toContain('22.4');
  });

  it('labels the table as averaged when it holds averaged points, and points at the raw record', async () => {
    const { report, text } = await capture(baseInput({ tableIsAveraged: true, averagedLabel: '5 minutes' }));
    const titles = report.getSnapshot().sections.map((x: any) => x.title).filter(Boolean);
    expect(titles).toContain('Averaged readings — the same points plotted above, not stored readings');
    expect(text).toMatch(/the chart AND the table below are AVERAGED over 5 minutes/);
    // The summary must be exempted in words, because it is NOT averaged.
    expect(text).toMatch(/period summary is NOT averaged/);
    expect(text).toMatch(/Instrument Time Series report/);
  });

  it('labels the table as stored readings when it is not averaged', async () => {
    const { report } = await capture(baseInput({ tableIsAveraged: false }));
    const titles = report.getSnapshot().sections.map((x: any) => x.title).filter(Boolean);
    expect(titles).toContain('Readings — every stored reading in this period');
  });

  it('says in the subtitle what this report is, and where the raw record lives', async () => {
    const { report } = await capture(baseInput());
    expect(report.getSnapshot().subtitle).toMatch(/Chart and period summary/);
    expect(report.getSnapshot().subtitle).toMatch(/Instrument Time Series report/);
  });

  it('keeps the SHARED chrome at its defaults — the Data Report opts up, the others do not move', async () => {
    // The Data Report's larger, bolder scale is per-report (2026-09-05). A
    // report that names no typography must print exactly as before: regular
    // weight (`/F1`) at the default size, headings left-aligned.
    const { DEFAULT_TYPOGRAPHY } = await import('@/lib/pdf-report');
    const { report } = await capture(baseInput());
    const stream = (report.doc.internal.pages as string[][]).filter(Boolean).flat().join('\n');
    const at = stream.indexOf('(Controlytics AI Pvt Ltd) Tj');
    expect(at).toBeGreaterThan(0);
    const tokens = [...stream.slice(0, at).matchAll(/\/F(\d) ([\d.]+) Tf/g)];
    const last = tokens[tokens.length - 1];
    expect(last[1]).toBe('1');
    expect(Number(last[2])).toBe(DEFAULT_TYPOGRAPHY.companyPt);
    const heads = Object.values(report.doc.lastAutoTable.head[0].cells) as any[];
    for (const c of heads) {
      expect(c.styles.halign).toBe('left');
      expect(c.styles.fontSize).toBe(DEFAULT_TYPOGRAPHY.tableHeadPt);
    }
  });

  /** The Data Report's inputs for the two-row fixture above, at Raw. */
  const dataInput = (coverage: { returned: number; total: number }) => ({
    scope: { blockName: 'CWH Block', areaName: 'QC 3', locationName: 'LCMS Room-II', instrumentLabel: 'DEMO-TH-142' },
    period, formatDateTime,
    fmt: { formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) },
    temp: { key: 't', min: 18, max: 25, decimals: 1, periodMax: 22.5, periodMin: 22.4 },
    rh: { key: null, min: null, max: null, decimals: 0, periodMax: null, periodMin: null },
    rows: scheduleRows(rows, null, period.to), intervalMs: null, coverage,
    words: { failure: 'Error', outOfRange: 'OL' },
  });
  /** jsPDF's own uncompressed page content streams, joined. */
  const pdfStream = (report: any) => (report.doc.internal.pages as string[][]).filter(Boolean).flat().join('\n');
  const pdfText = (report: any) =>
    [...pdfStream(report).matchAll(/\((.*?)\)\s*Tj/gs)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' ');
  /** The font in force when `text` was drawn: jsPDF tags helvetica regular `/F1`
   *  and bold `/F2`, and the size sits beside it in the same `Tf` operator. */
  const fontBefore = (stream: string, text: string): { bold: boolean; size: number } | null => {
    const at = stream.indexOf(`(${text}) Tj`);
    if (at < 0) return null;
    const tokens = [...stream.slice(0, at).matchAll(/\/F(\d) ([\d.]+) Tf/g)];
    const last = tokens[tokens.length - 1];
    return last ? { bold: last[1] === '2', size: Number(last[2]) } : null;
  };

  it('states its own coverage on the Data Report when it was built from a sample', async () => {
    // At Raw the rows come down the sampled chart path; a period wider than the
    // sample must say so IN the report, and must say the extremes above are not
    // the sample's.
    const report = await renderDataReport(dataInput({ returned: 500, total: 7646 }));
    const text = pdfText(report);
    expect(text).toMatch(/REPRESENTATIVE SAMPLE/);
    expect(text).toMatch(/500 of the 7,646 stored values/);
    expect(text).toMatch(/Every row below is a stored, unaveraged reading/);
    expect(text).toMatch(/computed over EVERY reading in the period/);
  });

  it('says nothing about coverage on a Data Report that holds the period', async () => {
    const report = await renderDataReport(dataInput({ returned: 2, total: 2 }));
    expect(pdfText(report)).not.toMatch(/REPRESENTATIVE SAMPLE/);
  });

  it('is laid out to the Data Report reference — parameter block, four columns, legend', async () => {
    // jsPDF binds `save` per INSTANCE at construction, so the file write has to
    // be stubbed before the document is built — after is too late, and the real
    // save writes a PDF into the working directory.
    const jspdf: any = await import('jspdf');
    const realSave = jspdf.default.API.save;
    jspdf.default.API.save = function () { return this; };
    let report: any;
    try {
      report = await renderDataReport(dataInput({ returned: 2, total: 2 }));
      report.save('x.pdf');
    } finally {
      jspdf.default.API.save = realSave;
    }
    const text = pdfText(report);
    expect(report.getSnapshot().title).toBe('Temperature and RH Data Report');
    // No 'RH Max :' — this fixture has no RH slot and no RH bound, and since
    // 2026-09-07 an extreme prints only for a bound in force.
    for (const label of ['Block :', 'Area :', 'Location :', 'Inst ID :', 'Start Date :', 'Start Time :', 'End Date :', 'End Time :', 'Temp. Limit :', 'RH Limit :', 'Temp. Max :', 'Interval :']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('CWH Block');
    expect(text).toContain('18.0 - 25.0');
    expect(text).toContain('Raw (every reading)');
    // The parameter block has NO empty cell (operator, 2026-09-07: "if value
    // was not there dont show that boxes in report"): a lone pair or the
    // Interval spans the row instead. This fixture has no RH bound, so the
    // extremes row is Temp alone, spanned.
    const sections = report.getSnapshot().sections as any[];
    expect(sections[0].head).toEqual([]);
    expect(sections[0].body.at(-2)).toEqual(['Temp. Max :', { content: '22.5 , Temp. Min : 22.4', colSpan: 3 }]);
    expect(sections[0].body.at(-1)).toEqual(['Interval :', { content: 'Raw (every reading)', colSpan: 3 }]);
    for (const row of sections[0].body) for (const c of row) expect(typeof c === 'string' ? c.trim() : c.content.trim()).not.toBe('');
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x && x.head.length) as any[];
    expect(tables[0].head).toEqual(['DATE', 'TIME', 'TEMPERATURE (°C)', 'RELATIVE HUMIDITY(%)']);
    // NEWEST first (operator, 2026-09-05), one row per stored reading, `NA` for
    // the slot this instrument does not report.
    expect(tables[0].body).toEqual([
      ['2026-08-24', '00:20', '22.5', 'NA'],
      ['2026-08-24', '00:10', '22.4', 'NA'],
    ]);
    // And NA is keyed in the legend, the way NMT is. The legend is part of the
    // end block, which the `save()` above drew.
    expect(text).toMatch(/NA = No data/);
  });

  it('says so when the period is empty', async () => {
    const report = await renderDataReport({ ...dataInput({ returned: 0, total: 0 }), rows: [] });
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x && x.head.length) as any[];
    expect(tables[0].body[0][2]).toMatch(/No readings/);
  });

  /**
   * Operator, 2026-09-05: *"in data report make headings to center and in
   * header, and increase font sizes and thickness"*. Read off the PDF itself —
   * jsPDF tags helvetica regular `/F1` and bold `/F2` in the content stream, and
   * autotable leaves the resolved cell styles on `doc.lastAutoTable`. Pinned
   * against the shared defaults, not against literals, so the assertion is
   * "this report is bigger and bolder than the chrome's default", which is the
   * claim the operator made.
   */
  it('prints the header bold and larger, and centres the column headings', async () => {
    const { DEFAULT_TYPOGRAPHY } = await import('@/lib/pdf-report');
    const report = await renderDataReport(dataInput({ returned: 2, total: 2 }));
    const stream = pdfStream(report);
    // The company name and the title are drawn bold, above the shared default size.
    const company = fontBefore(stream, 'Controlytics AI Pvt Ltd');
    expect(company).not.toBeNull();
    expect(company!.bold).toBe(true);
    expect(company!.size).toBeGreaterThan(DEFAULT_TYPOGRAPHY.companyPt);
    const title = fontBefore(stream, 'Temperature and RH Data Report');
    expect(title).not.toBeNull();
    expect(title!.bold).toBe(true);
    expect(title!.size).toBeGreaterThan(DEFAULT_TYPOGRAPHY.titlePt);
    // The readings table is the last one drawn: every heading cell centred, bold,
    // and larger than the default; the body larger too but NOT bold for a
    // reading inside its limits — the reference keeps its readings regular.
    const table = (report.doc as any).lastAutoTable;
    const heads = Object.values(table.head[0].cells) as any[];
    expect(heads).toHaveLength(4);
    for (const c of heads) {
      expect(c.styles.halign).toBe('center');
      expect(c.styles.fontStyle).toBe('bold');
      expect(c.styles.fontSize).toBeGreaterThan(DEFAULT_TYPOGRAPHY.tableHeadPt);
    }
    const body = Object.values(table.body[0].cells) as any[];
    for (const c of body) {
      expect(c.styles.fontSize).toBeGreaterThan(DEFAULT_TYPOGRAPHY.tablePt);
      expect(c.styles.fontStyle).toBe('normal');
    }
  });

  it('drops the app-name line under the company name ("remove header on header")', async () => {
    // The branding fetch is unavailable here, so the app name would be the
    // shipped default. The trend report still prints it; this one must not.
    const data = await renderDataReport(dataInput({ returned: 2, total: 2 }));
    expect(pdfText(data)).not.toMatch(/\bDigiLog\b/);
    const { text } = await capture(baseInput());
    expect(text).toMatch(/\bDigiLog\b/);
  });

  it('keeps the parameter block labels on one line at the larger size', async () => {
    // A label that wraps makes one field read as two; the block's label column
    // was widened for exactly this. Measured the way autotable measures — at
    // the table's own bold size, plus its padding — against the label width
    // the report pins.
    const { DATA_REPORT_LABEL_MM, DATA_REPORT_TYPOGRAPHY } = await import('../data-report');
    const report = await renderDataReport(dataInput({ returned: 2, total: 2 }));
    const snap = report.getSnapshot().sections.find((s: any) => 'head' in s && s.head.length === 0) as any;
    const labels: string[] = snap.body.map((r: string[]) => r[0]);
    expect(labels).toContain('Temp. Limit :');
    const doc: any = report.doc;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(DATA_REPORT_TYPOGRAPHY.tablePt);
    const widest = Math.max(...labels.map((l) => doc.getTextWidth(l) as number));
    expect(widest + 2 * 2.5).toBeLessThan(DATA_REPORT_LABEL_MM);
  });

  it('prints a reading that crossed its limit BOLD, and a reading inside it regular', async () => {
    // 18–25 on temperature: 26.9 crossed it, 22.4 did not.
    const crossed = [
      { ts: '2026-08-24T00:10:00.000Z', values: { t: 22.4 } },
      { ts: '2026-08-24T00:20:00.000Z', values: { t: 26.9 } },
    ];
    const report = await renderDataReport({ ...dataInput({ returned: 2, total: 2 }), rows: scheduleRows(crossed, null, period.to) });
    const table = (report.doc as any).lastAutoTable;
    // Newest first: row 0 is 26.9.
    expect(table.body[0].cells[2].text).toEqual(['26.9']);
    expect(table.body[0].cells[2].styles.fontStyle).toBe('bold');
    expect(table.body[1].cells[2].text).toEqual(['22.4']);
    expect(table.body[1].cells[2].styles.fontStyle).toBe('normal');
    // The DATE and TIME cells of the bold row stay regular — the emphasis is on
    // the value, not the row.
    expect(table.body[0].cells[0].styles.fontStyle).toBe('normal');
  });

  it('prints the two fault words BOLD, and NA regular, where the reading cannot be trusted', async () => {
    const rows2 = [
      // A non-numeric reading on the slot: the failure word.
      { ts: '2026-08-24T00:10:00.000Z', values: { t: null }, errors: { t: true } },
      // Inside the limits but beyond the probe's declared span: the range word.
      { ts: '2026-08-24T00:20:00.000Z', values: { t: 24.0 } },
      // No reading on the slot at all.
      { ts: '2026-08-24T00:30:00.000Z', values: { t: null } },
    ];
    const input = dataInput({ returned: 3, total: 3 });
    const report = await renderDataReport({
      ...input,
      temp: { ...input.temp, rangeLow: 0, rangeHigh: 23 },
      rows: scheduleRows(rows2, null, period.to),
    });
    const table = (report.doc as any).lastAutoTable;
    const cell = (i: number) => table.body[i].cells[2];
    // Newest first.
    expect(cell(0).text).toEqual(['NA']);
    expect(cell(0).styles.fontStyle).toBe('normal');
    expect(cell(1).text).toEqual(['OL']);
    expect(cell(1).styles.fontStyle).toBe('bold');
    expect(cell(2).text).toEqual(['Error']);
    expect(cell(2).styles.fontStyle).toBe('bold');
  });

  it('builds the multi-instrument report as one Data Report page per instrument, with NO cover block', async () => {
    // Operator, 2026-09-07: the Data Report page's download is "the same
    // report of time series widget" — each page identical to the single-
    // instrument document, nothing in front of it. The cover block that opened
    // this document from 2026-09-05 went with that decision.
    const { renderDataReports } = await import('../trend-report');
    const one = dataInput({ returned: 2, total: 2 });
    const two = { ...one, scope: { ...one.scope, instrumentLabel: 'DEMO-TH-143' }, rows: scheduleRows([], null, period.to) };
    const report = await renderDataReports({ formatDateTime, instruments: [one, two] });
    const sections = report.getSnapshot().sections as any[];
    // Two parameter blocks and two readings tables, in order — and nothing else.
    const labels = sections.map((s) => (s.head.length ? 'table' : s.body[0][0]));
    expect(labels).toEqual(['Block :', 'table', 'Block :', 'table']);
    expect(sections.some((s) => s.body?.some?.((r: string[]) => r[0] === 'Instruments :'))).toBe(false);
    expect(sections[0].body.find((r: string[]) => r[0] === 'Inst ID :')![1]).toBe('DEMO-TH-142');
    expect(sections[2].body.find((r: string[]) => r[0] === 'Inst ID :')![1]).toBe('DEMO-TH-143');
    // The second instrument had no readings and says so.
    expect(sections[3].body[0][2]).toMatch(/No readings/);
    // One page per instrument, the first on page one.
    expect(report.doc.getNumberOfPages()).toBe(2);
  });

  it('prints every slot of the schedule, NA where nothing was received, newest first', async () => {
    // Ten-minute slots anchored on the first reading (00:10) up to the period
    // end (01:00): 00:10 and 00:20 hold readings; 00:30 to 01:00 were silent
    // and print as NA at the time each reading was due.
    const report = await renderDataReport({
      ...dataInput({ returned: 2, total: 2 }), rows: scheduleRows(rows, 600_000, period.to), intervalMs: 600_000,
    });
    const tables = report.getSnapshot().sections.filter((x: any) => 'head' in x && x.head.length) as any[];
    expect(tables[0].body).toEqual([
      ['2026-08-24', '01:00', 'NA', 'NA'],
      ['2026-08-24', '00:50', 'NA', 'NA'],
      ['2026-08-24', '00:40', 'NA', 'NA'],
      ['2026-08-24', '00:30', 'NA', 'NA'],
      ['2026-08-24', '00:20', '22.5', 'NA'],
      ['2026-08-24', '00:10', '22.4', 'NA'],
    ]);
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
    const readingsTable = tables.find((t: any) => t.head[0] === 'Timestamp')!;
    expect(readingsTable.body).toHaveLength(2000);
  });
});
