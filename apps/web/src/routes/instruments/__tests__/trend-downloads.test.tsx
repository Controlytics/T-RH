import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { STUB_PNG, withoutCanvas } from '@/test-support/canvas-stub';

/**
 * The three trend downloads, end to end through the page's own dispatcher.
 *
 * What this guards, in order of how badly it bites:
 *
 * 1. `reportType` is what the §11 audit row records (`targetType` on the
 *    REPORT_GENERATED row). Three different downloads all logged as
 *    "Instrument Trend" would leave an audit trail that cannot say which
 *    report a given row is — so the slot has to be IN the string, and that is
 *    asserted per widget rather than once.
 * 2. Fail-closed ordering: the audit write must land BEFORE the file is saved,
 *    so a download whose record never wrote cannot reach the operator's disk.
 * 3. The download must not fail silently. `runDownload` used to `return`
 *    without throwing when it had no pending report — the dialog went back to
 *    idle with no file and no error, which is indistinguishable from success.
 * 4. The chart reaches the PDF, and when it CANNOT the report says so. Both
 *    branches are exercised: `test-setup.ts` stubs the canvas so the normal
 *    path runs, and `withoutCanvas` removes it to prove the fallback. The stub
 *    hands back a canned 1x1 PNG, so "the chart reached the PDF" means jsPDF
 *    was given an image — NOT that the image depicts a chart. Nothing here has
 *    seen the rendered picture.
 */

// Two readings inside one 5-minute bucket, one in the next. At `raw` that is
// three table rows; at `5m` it is two averaged points — which is what makes the
// "table follows the chart" assertion below discriminating.
const history = [
  { key: 'temperature', value: 22.4, ts: '2026-08-24T00:10:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'humidity', value: 45.1, ts: '2026-08-24T00:10:00.000Z', slot: 'humidity', decimals: 1 },
  { key: 'temperature', value: 22.6, ts: '2026-08-24T00:11:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'humidity', value: 45.2, ts: '2026-08-24T00:11:00.000Z', slot: 'humidity', decimals: 1 },
  { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z', slot: 'humidity', decimals: 1 },
  // A NON-NUMERIC reading. `numericRows` drops it, but the endpoint counts it in
  // `historyTotal` — this database holds one such row today, and comparing the
  // filtered count against the unfiltered total made the report cry
  // "INCOMPLETE PERIOD" with nothing truncated.
  { key: 'status', value: 'RUNNING', ts: '2026-08-24T00:20:00.000Z', slot: null, decimals: null },
];

const overviewRow = {
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', isActive: true, room: null,
  limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 },
  limitSource: 'INSTRUMENT',
  temperature: { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
  humidity: { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z' },
  decimals: { temperature: 1, humidity: 1 }, reporting: true, status: 'OK',
};

function dataFor(key: string | null): any {
  if (!key) return undefined;
  if (key.includes('/telemetry-overview')) return { data: [overviewRow] };
  if (key.includes('/telemetry-keys')) return { data: [] };
  if (key.includes('/telemetry?')) return { latest: [], history, historyTotal: history.length };
  if (key.includes('/api/alarms')) return { data: [] };
  if (key.includes('action-reauth/my-actions')) return { actions: [] };
  if (key.startsWith('/api/instruments/')) return { id: 'i-1', code: 'DEMO-TH-142', name: 'Demo' };
  return {};
}

vi.mock('swr', () => ({
  default: (key: any) => ({ data: dataFor(typeof key === 'function' ? key() : key), isLoading: false, error: undefined }),
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(async (url: string) => dataFor(url)),
    post: vi.fn(async () => ({})),
    postWithReauth: vi.fn(async () => ({})),
  },
}));

/** Ordered log of what happened, so "audit before save" is a real assertion. */
const events: string[] = [];
const logged: any[] = [];

vi.mock('@/lib/report-export-log', () => ({
  logReportExport: vi.fn(async (input: any) => {
    logged.push(input);
    events.push(`log:${input.reportType}`);
  }),
}));

const saved: string[] = [];

const { InstrumentTrend } = await import('../trend');

const jspdf: any = await import('jspdf');
// jsPDF binds `save` per instance, but `output` — which `save` calls — is on
// the shared API object, so intercepting it stops the file without stubbing
// the document itself.
/** The text of the most recently saved document, read out of jsPDF's own
 *  uncompressed content streams — what the PDF actually holds, not what a call
 *  was asked to draw. */
let lastPdf = '';
/** Every image jsPDF was handed, across the whole run. */
const images: any[][] = [];
const realAddImage = jspdf.default.API.addImage;
jspdf.default.API.addImage = function (this: any, ...args: any[]) {
  images.push(args);
  return realAddImage.apply(this, args);
};
jspdf.default.API.save = function (this: any, name: string) {
  saved.push(name);
  events.push(`save:${name}`);
  const raw: string = (this.internal.pages as string[][]).filter(Boolean).flat().join('\n');
  lastPdf = [...raw.matchAll(/\((.*?)\)\s*Tj/gs)]
    .map((m) => m[1].replace(/\\([()\\])/g, '$1'))
    .join(' ');
  return this;
};

function lastPdfText() { return lastPdf; }

function renderPage(query = '') {
  return render(
    <MemoryRouter initialEntries={[`/instruments/i-1/trend${query}`]}>
      <Routes><Route path="/instruments/:id/trend" element={<InstrumentTrend />} /></Routes>
    </MemoryRouter>,
  );
}

/** Click the nth "Export as PDF" button, fill the required remarks, confirm. */
async function download(buttonIndex: number) {
  const buttons = screen.getAllByText('Export as PDF');
  fireEvent.click(buttons[buttonIndex]);
  fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'periodic review' } });
  fireEvent.click(screen.getByText('Download'));
  await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
}

describe('trend page downloads', () => {
  beforeEach(() => { saved.length = 0; logged.length = 0; events.length = 0; images.length = 0; lastPdf = ''; });

  it('offers a download on the temperature widget, the humidity widget, the combined charts, the time series and the alarms', () => {
    renderPage();
    // combined (Charts header), temperature, humidity, time series, alarms
    expect(screen.getAllByText('Export as PDF')).toHaveLength(5);
  });

  it('names the SLOT in the audit reportType for the temperature widget', async () => {
    renderPage();
    await download(1);
    expect(logged[0].reportType).toBe('Instrument Trend — Temperature');
    expect(saved[0]).toBe('instrument-trend-temperature-DEMO-TH-142-' + new Date().toISOString().slice(0, 10) + '.pdf');
  });

  it('names the SLOT in the audit reportType for the humidity widget', async () => {
    renderPage();
    await download(2);
    expect(logged[0].reportType).toBe('Instrument Trend — Humidity');
    expect(saved[0]).toContain('instrument-trend-humidity-');
  });

  it('distinguishes the combined report from both single-slot ones', async () => {
    renderPage();
    await download(0);
    expect(logged[0].reportType).toBe('Instrument Trend — Temperature & Humidity');
    // 'both' is an internal enum value, not a document name an operator files.
    expect(saved[0]).toContain('instrument-trend-temperature-humidity-');
  });

  /**
   * `audit_trail.target_type` is VARCHAR(50) and the route stores `reportType`
   * straight into it (`audit/routes.ts` → `auditLog({ targetType: reportType })`).
   * The route's own schema allows 100 characters, so a reportType between 51 and
   * 100 passes validation and then fails the INSERT — the download's audit write
   * throws, and fail-closed means the operator gets no file and no clear reason.
   *
   * The longest string this page emits is 41 characters. That is nine characters
   * of headroom, which a third slot or a wordier label would eat, so it is
   * measured here rather than left to be discovered by an operator.
   */
  it('keeps every reportType inside the audit column it is stored in', async () => {
    for (const idx of [0, 1, 2, 3, 4]) {
      saved.length = 0; logged.length = 0; events.length = 0;
      const view = renderPage();
      await download(idx);
      expect(logged[0].reportType.length).toBeLessThanOrEqual(50);
      view.unmount();
    }
  });

  it('leaves the time series and alarms reportTypes unchanged', async () => {
    renderPage();
    await download(3);
    expect(logged[0].reportType).toBe('Instrument Time Series');
    saved.length = 0; logged.length = 0;
    await download(4);
    expect(logged[0].reportType).toBe('Instrument Alarms');
  });

  it('writes the audit record BEFORE saving the file, on every one of them', async () => {
    for (const idx of [0, 1, 2, 3, 4]) {
      saved.length = 0; logged.length = 0; events.length = 0;
      const view = renderPage();
      await download(idx);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatch(/^log:/);
      expect(events[1]).toMatch(/^save:/);
      view.unmount();
    }
  });

  /**
   * The chart and the table in ONE report must not quote different values for
   * one instant with nothing saying why — that is the same §11 problem as the
   * on-screen version of it (Issue 4), one document further along. So when the
   * chart is averaged, the table under it holds those same averaged points, and
   * the raw record lives in the Time Series report.
   */
  it('builds the trend table from the same points the chart plots, when averaged', async () => {
    renderPage('?interval=5m');
    await download(1);
    // Three stored readings collapse to two 5-minute buckets.
    expect(logged[0].recordCount).toBe(2);
  });

  it('leaves the trend table at every stored reading when the chart is raw', async () => {
    renderPage('?interval=raw');
    await download(1);
    expect(logged[0].recordCount).toBe(3);
  });

  it('never averages the Time Series report, whatever the chart interval is', async () => {
    // The raw record is this report's entire job; the chart control must not
    // reach it.
    renderPage('?interval=5m');
    await download(3);
    expect(logged[0].reportType).toBe('Instrument Time Series');
    expect(logged[0].recordCount).toBe(3);
  });

  it('does not cry INCOMPLETE PERIOD just because a reading was non-numeric', async () => {
    // The fixture holds one non-numeric reading, so historyTotal exceeds the
    // numeric row count while nothing whatsoever was truncated. The coverage
    // comparison must be against what the endpoint RETURNED, not against what
    // survived the numeric filter. A false truncation warning in a §11 record
    // is its own misrepresentation, and it trains the reader to ignore the
    // banner that matters.
    renderPage();
    await download(1);
    const pdf = lastPdfText();
    expect(pdf).not.toMatch(/INCOMPLETE PERIOD/);
  });

  it('puts the chart into the trend PDF', async () => {
    renderPage();
    await download(1);
    // The branding logo loads over fetch, which is unavailable here, so the
    // only image this document can carry is the chart. STUB_PNG is what the
    // canvas stub returns — this proves the raster path ran end to end and
    // jsPDF received an image. It does NOT prove the image is a chart.
    expect(images.some((a) => a[0] === STUB_PNG && a[1] === 'PNG')).toBe(true);
  });

  it('puts a chart into the combined report for BOTH slots', async () => {
    renderPage();
    await download(0);
    expect(images.filter((a) => a[0] === STUB_PNG)).toHaveLength(2);
  });

  /**
   * The fallback the lead asked to see proven. On a real browser this branch
   * should never fire; if it does, the report must still be a usable §11 record
   * — a stated reason, the period summary and the readings — rather than a gap
   * where the picture should be, which reads as "no data".
   */
  it('still produces a report, saying why, when the chart cannot be rasterised', async () => {
    await withoutCanvas(async () => {
      renderPage();
      await download(1);
    });
    expect(images.filter((a) => a[0] === STUB_PNG)).toHaveLength(0);
    expect(saved).toHaveLength(1);
    expect(lastPdfText()).toMatch(/could not be rendered by this browser/);
    // ...and the record itself is still there.
    expect(lastPdfText()).toMatch(/period summary/);
    expect(logged[0].reportType).toBe('Instrument Trend \u2014 Temperature');
  });

  it('carries the operator\'s remarks and the period into the audit record', async () => {
    renderPage();
    await download(1);
    expect(logged[0].remarks).toBe('periodic review');
    expect(logged[0].format).toBe('PDF');
    expect(logged[0].recordCount).toBe(3);
    expect(logged[0].startDate).toBeTruthy();
    expect(logged[0].endDate).toBeTruthy();
  });
});
