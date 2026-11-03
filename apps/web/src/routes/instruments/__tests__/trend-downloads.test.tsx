import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { BRANDING_TAB_TITLE_DEFAULT, builtinReportTemplate } from '@digilog/shared';
import { STUB_PNG, withoutCanvas } from '@/test-support/canvas-stub';
import { brandingFetch } from '@/test-support/branding-stub';

// Branding and its logo answer: a report made now REFUSES when either cannot be
// read (ruling F-1, extended 2026-11-03). Branding names nothing, so the
// reports print the shipped default names, as they did when this fetch failed.
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = brandingFetch() as any; });
afterAll(() => { globalThis.fetch = realFetch; });

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

/** Rows the period holds beyond what the sampled path returned — set by a test
 *  to make the Data Report's interval path fetch the whole period. */
let extraTotal = 0;

const overviewRow = {
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', isActive: true, room: null,
  functionalLocationName: 'QC 3(AHU-033)', locationAttribute: 'LCMS Room-II',
  limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 },
  limitSource: 'INSTRUMENT',
  temperature: { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
  humidity: { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z' },
  decimals: { temperature: 1, humidity: 1 }, reporting: true, status: 'OK',
};

/** Configuration → Report Downloads as the narrow route returns it (2026-10-01):
 *  every kind REQUEST with remarks and password — today's behaviour. Constant,
 *  so the swr mock never hands back a fresh object. */
const KIND_REQUEST = { mode: 'REQUEST', remarksRequired: true, passwordRequired: true };
const DOWNLOADS = { 'data-report': KIND_REQUEST, 'time-series': KIND_REQUEST, 'trend-header': KIND_REQUEST, 'temperature-trend': KIND_REQUEST, 'humidity-trend': KIND_REQUEST, 'instrument-alarms': KIND_REQUEST, alarms: KIND_REQUEST, 'audit-trail': KIND_REQUEST };
const APPROVERS = { approverRoles: ['QA'], approverUserCount: 0 };

/** The instrument's own row (`/api/instruments/:id`); `instrumentLoaded = false` = not arrived yet. Module constant. */
const INSTRUMENT_ROW = { id: 'i-1', code: 'DEMO-TH-142', name: 'Demo', functionalLocationId: 'a1' };
let instrumentLoaded = true;

function dataFor(key: string | null): any {
  if (!key) return undefined;
  if (key.includes('/telemetry-overview')) return { data: [overviewRow] };
  if (key.includes('/telemetry-keys')) return { data: [] };
  if (key.includes('/telemetry?')) {
    // The paged path, asked for the whole period (`limit=<total>`), returns it
    // all; the sampled path reports how many the period holds beyond the sample.
    const whole = key.includes('limit=');
    return { latest: [], history, historyTotal: history.length + (whole ? 0 : extraTotal) };
  }
  if (key.includes('/api/alarms')) return { data: [] };
  if (key.startsWith('/api/config/report-downloads/current')) return DOWNLOADS;
  if (key.startsWith('/api/config/report-approvers/current')) return APPROVERS;
  if (key.includes('action-reauth/my-actions')) return { actions: [] };
  if (key.includes('/api/functional-locations')) {
    return { data: [{ id: 'b1', name: 'CWH Block', children: [{ id: 'a1', name: 'QC 3(AHU-033)' }] }] };
  }
  // The instrument's attributes, which a report template's `attr:` rows print (2026-11-03).
  if (key === '/api/instruments/i-1/attributes') return ATTRIBUTES;
  if (key.startsWith('/api/instruments/')) return instrumentLoaded ? INSTRUMENT_ROW : undefined;
  return {};
}

const ATTRIBUTES = { data: [{ key: 'Building', value: 'B-1', display: null }, { key: 'Temp NMT', value: '25', display: '25.0' }] };

/**
 * Which report template each download prints with (2026-11-03, page reports on
 * templates): the server's plan, mocked at the hook — `useReportTemplatePlan`'s
 * own requests are pinned in `lib/__tests__/report-template-plan.test.tsx`.
 * Module-level constants, so the hook never hands back a fresh object. The
 * default plan resolves no template: every report prints the built-in.
 */
const AVAILABLE = [
  'record.date', 'record.time', 'record.temperature', 'record.humidity',
  'alarm.type', 'alarm.raisedAt', 'alarm.value', 'alarm.limit', 'alarm.clearedAt', 'alarm.status',
  'attr:Building', 'attr:Temp NMT',
];
const BUILTIN_PLAN = {
  sections: [{ profileId: 'p-trh', profileName: 'T&RH', instrumentIds: ['i-1'], resolved: null, templates: [], availableIds: AVAILABLE }],
  loading: false, error: undefined,
};
/** A saved template the server resolves for T&RH, for every kind: its own title and an attribute info row. */
const SAVED_TEMPLATE = {
  id: 't-1', profileId: 'p-trh', kind: 'page:trend', name: 'Site layout', isDefault: true,
  document: {
    ...builtinReportTemplate('page:trend'),
    header: { title: 'Site trend — {series}', subtitle: 'Printed by {user}', showAppName: true, logo: { mode: 'branding' as const } },
    infoBlock: [{ label: 'Building', source: 'attr:Building' }, { label: 'Inst ID', source: 'instrument' }],
  },
  createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
};
const SAVED_PLAN = { ...BUILTIN_PLAN, sections: [{ ...BUILTIN_PLAN.sections[0], resolved: SAVED_TEMPLATE, templates: [SAVED_TEMPLATE] }] };
/** The server named no profile for this instrument (`/resolve` drops one the caller cannot see). */
const EMPTY_PLAN = { sections: [], loading: false, error: undefined };
let plan: { sections: unknown[]; loading: boolean; error: unknown } = BUILTIN_PLAN;
const planAsked: { kind: string; ids: string[]; enabled: boolean | undefined }[] = [];

vi.mock('@/lib/report-template-plan', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/report-template-plan')>()),
  useReportTemplatePlan: (kind: string, ids: readonly string[], opts?: { enabled?: boolean }) => {
    planAsked.push({ kind, ids: [...ids], enabled: opts?.enabled });
    return plan;
  },
}));

// The trend page renders the alarms widget, which since 2026-09-01 carries the
// Acknowledge flow — so it reaches `useCan` (permission gate) and `useToast`.
// Neither has a provider in this harness; both are stubbed so these tests keep
// failing on their own subject rather than on a context they do not set up.
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

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

vi.mock('@/lib/report-review', async () => {
  // The request client, replaced by a stand-in that RECORDS the request and then
  // REPLAYS its snapshot through the real renderer and saves — so every content
  // assertion below reads the document the approver would see, and the page's
  // own path is proven to save nothing (every saved name starts with `replay-`).
  const { renderSnapshotToPdf } = await import('@/lib/pdf-report');
  return {
    submitReportForReview: vi.fn(async (input: any) => {
      logged.push({ reportType: input.reportType, title: input.title, remarks: input.remarks, password: input.password,
        reportKind: input.reportKind, instrumentIds: input.instrumentIds, requestMeta: input.requestMeta, snapshotVersion: input.snapshot?.version });
      events.push(`log:${input.reportType}`);
      const doc = await renderSnapshotToPdf(input.snapshot, { formatDateTime: (d: string) => d });
      doc.save(`replay-${input.reportType}.pdf`);
      return { id: 'r1', status: 'PENDING' };
    }),
    fileSlug: (t: string) => t.replace(/\W+/g, '_'),
  };
});

const saved: string[] = [];

const { InstrumentTrend } = await import('../trend');
const { BUILTIN_TEMPLATE_PICK } = await import('@/lib/report-template-plan');
const { apiClient } = await import('@/lib/api-client');

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

/**
 * Every "Export as PDF" trigger on the page, in DOM order.
 *
 * By ACCESSIBLE NAME, not visible text (2026-08-31): the two per-chart triggers
 * moved into their card headers as ICON-ONLY buttons, where the label lives on
 * `aria-label`/`title` rather than in a text node. This query is strictly
 * stronger than the `getAllByText` it replaced — it fails if an icon-only
 * trigger has no accessible name at all, which is the one way that restyle
 * could have made a §11 download unreachable to a screen reader without
 * anything on screen looking wrong.
 */
function exportButtons() {
  return screen.getAllByRole('button', { name: 'Export as PDF' });
}

/** Click the nth "Export as PDF" button, fill the required remarks, confirm. */

/** No approver is chosen since 2026-10-01; the configured password is signed
 *  in the dialog itself. (Name kept: it is the step before Request approval.) */
function pickApprover() {
  fireEvent.change(document.getElementById('report-download-password') as HTMLInputElement, { target: { value: 'Secret@123' } });
}

async function download(buttonIndex: number) {
  const buttons = exportButtons();
  fireEvent.click(buttons[buttonIndex]);
  fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'periodic review' } });
  pickApprover();
  fireEvent.click(screen.getByText('Request approval'));
  await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
}

describe('trend page downloads', () => {
  beforeEach(() => { saved.length = 0; logged.length = 0; events.length = 0; images.length = 0; lastPdf = ''; plan = BUILTIN_PLAN; planAsked.length = 0; });

  it('offers a download in the page header, on the temperature widget, the humidity widget, the time series and the alarms', () => {
    renderPage();
    // header (Data Report), temperature, humidity, time series, alarms
    expect(exportButtons()).toHaveLength(5);
  });

  it('names the SLOT in the audit reportType for the temperature widget', async () => {
    renderPage();
    await download(1);
    expect(logged[0].reportType).toBe('Instrument Trend — Temperature');
    expect(logged[0].requestMeta.instrumentCodes).toEqual(['DEMO-TH-142']);
    expect(logged[0].snapshotVersion).toBe(3);
  });

  it('names the SLOT in the audit reportType for the humidity widget', async () => {
    renderPage();
    await download(2);
    expect(logged[0].reportType).toBe('Instrument Trend — Humidity');
    expect(saved[0]).toBe('replay-Instrument Trend — Humidity.pdf');
  });

  it('the page header downloads the DATA REPORT — no charts, the interval offered — and logs it as the Time Series', async () => {
    // Operator, 2026-09-07: "in that report trends also coming remove those
    // and add interval feature". The header button used to build the combined
    // charts report ("Instrument Trend — Temperature & Humidity"); it is now the
    // same download as the Time Series card, so a signed period file is the
    // readings, not pictures of them.
    renderPage();
    fireEvent.click(exportButtons()[0]);
    expect(screen.getByLabelText(/^Interval$/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'periodic review' } });
    pickApprover();
    fireEvent.click(screen.getByText('Request approval'));
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
    expect(logged[0].reportType).toBe('Instrument Time Series');
    expect(logged[0].requestMeta.instrumentCodes).toEqual(['DEMO-TH-142']);
    // No chart raster reached the document.
    expect(images.filter((a) => a[0] === STUB_PNG)).toHaveLength(0);
    // The approver's copy is a REPLAY of the snapshot: the Data Report's "no
    // app-name line" rides in its frozen chrome (2026-11-03), not in a flag.
    expect(lastPdfText()).not.toContain(BRANDING_TAB_TITLE_DEFAULT);
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

  it('POSTS a request and saves NOTHING itself, on every one of them (2026-09-07)', async () => {
    // Every download is a request an approver signs. The only file this test
    // ever sees saved is the stand-in's replay of the submitted snapshot.
    for (const idx of [0, 1, 2, 3, 4]) {
      saved.length = 0; logged.length = 0; events.length = 0;
      const view = renderPage();
      await download(idx);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatch(/^log:/);
      expect(events[1]).toMatch(/^save:replay-/);
      for (const name of saved) expect(name).toMatch(/^replay-/);
      // The configured KIND rides on each, and the instrument id that scopes it (2026-10-01).
      expect(logged[0].reportKind).toBe(['trend-header', 'temperature-trend', 'humidity-trend', 'time-series', 'instrument-alarms'][idx]);
      expect(logged[0].instrumentIds).toHaveLength(1);
      expect(logged[0].password).toBe('Secret@123');
      expect(logged[0].snapshotVersion).toBe(3);
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
    expect(logged[0].requestMeta.recordCount).toBe(2);
  });

  it('leaves the trend table at every stored reading when the chart is raw', async () => {
    renderPage('?interval=raw');
    await download(1);
    expect(logged[0].requestMeta.recordCount).toBe(3);
  });

  /**
   * The PRINTED averaging disclosure, which nothing asserted until 2026-09-01.
   *
   * It matters more now than it did: the on-screen note ("Averaged over 1 hour —
   * the table below shows every reading") was removed at the operator's request
   * that day, and the justification for removing it was that the signed PDF
   * carries its own independent disclosure. That justification was unguarded —
   * setting `averagedLabel: null` passed all sixteen tests in this file.
   *
   * A plotted point in an averaged chart is a DERIVED number and the reader has
   * no way to tell from the picture. On paper, which outlives the screen, the
   * document has to say so itself.
   */
  it('SAYS on the printed report that its chart is averaged', async () => {
    renderPage('?interval=5m');
    await download(1);
    // The disclosure's own phrase, not a loose word match: the report also
    // carries an 'Average' summary row, which is a different statement.
    expect(lastPdfText()).toMatch(/AVERAGED over/);
  });

  it('says nothing of the kind when the chart is raw', async () => {
    // The discriminating half: the wording must follow the interval, not appear
    // on every report. A disclosure that is always present states nothing.
    renderPage('?interval=raw');
    await download(1);
    expect(lastPdfText()).not.toMatch(/AVERAGED over/);
  });

  /**
   * The Time Series download is the DATA REPORT (2026-09-04), built to the
   * operator's `Data Report.pdf`. A fixed period is passed in the URL so the
   * interval buckets — aligned to the period START — are deterministic.
   */
  const FIXED = '?from=2026-08-24T00%3A10%3A00.000Z&to=2026-08-24T01%3A00%3A00.000Z&label=Custom';

  it('prints every stored reading at Raw, and never averages', async () => {
    renderPage(FIXED);
    await download(3);
    expect(logged[0].reportType).toBe('Instrument Time Series');
    expect(logged[0].requestMeta.recordCount).toBe(3);
    expect(logged[0].requestMeta.instrumentCodes).toEqual(['DEMO-TH-142']);
  });

  it('prints ONE STORED READING per interval slot, and NA for an empty slot, when the page has one selected', async () => {
    // Anchored on the first reading (00:10), 5-minute slots to the period end
    // (01:00): 00:10 (22.4 — 00:11 shares the slot and is not printed), 00:15
    // (NA), 00:20 (22.5), then 00:25 … 01:00 all NA — eleven rows, every one a
    // real reading or a stated gap, never an average.
    renderPage(`${FIXED}&interval=5m`);
    await download(3);
    expect(logged[0].requestMeta.recordCount).toBe(11);
    const text = lastPdfText();
    expect(text).toContain('5 minutes');
    expect(text).toContain('22.4');
    expect(text).toContain('22.5');
    expect(text).toContain('NA');
    // The 00:11 reading shares the first slot with 00:10 and is not printed.
    expect(text).not.toContain('22.6');
  });

  it('takes the interval from the DIALOG, seeded from the page, and prints it', async () => {
    // The page says 5 minutes; the operator changes the dialog to 1 hour.
    renderPage(`${FIXED}&interval=5m`);
    fireEvent.click(exportButtons()[3]);
    const select = screen.getByLabelText(/^Interval$/) as HTMLSelectElement;
    expect(select.value).toBe(String(300_000));
    fireEvent.change(select, { target: { value: String(3_600_000) } });
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'periodic review' } });
    pickApprover();
    fireEvent.click(screen.getByText('Request approval'));
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
    const text = lastPdfText();
    expect(text).toContain('1 hour');
    expect(text).not.toContain('5 minutes');
    // Hourly from 00:10 to 01:00 is ONE slot.
    expect(logged[0].requestMeta.recordCount).toBe(1);
  });

  it('offers the interval only on the Data Report dialog', async () => {
    renderPage(FIXED);
    fireEvent.click(exportButtons()[1]);   // temperature trend
    expect(screen.queryByLabelText(/^Interval$/)).toBeNull();
  });

  it('fetches the WHOLE period, not the sample, before choosing each interval\'s first reading', async () => {
    extraTotal = 5;
    try {
      renderPage(`${FIXED}&interval=5m`);
      await download(3);
      const urls = (apiClient.get as any).mock.calls.map((c: any[]) => String(c[0]));
      const telemetryCalls = urls.filter((u: string) => u.includes('/telemetry?'));
      // The sampled call (for the true total and the extremes) AND a paged call
      // sized by that total.
      expect(telemetryCalls.some((u: string) => u.includes('points='))).toBe(true);
      // Seven fixture rows plus the five the period holds beyond them.
      expect(telemetryCalls.some((u: string) => /[?&]limit=12\b/.test(u))).toBe(true);
      expect(lastPdfText()).not.toMatch(/REPRESENTATIVE SAMPLE/);
    } finally {
      extraTotal = 0;
      // The mock's call log is shared across this file; the paged call this
      // test provokes must not leak into the chart-path assertion below.
      (apiClient.get as any).mockClear();
    }
  });

  it('reads the WHOLE period at Raw too, so no sample is disclosed and a failure word can print', async () => {
    // Until 2026-09-05 the Raw report was built from the sampled chart path,
    // which drops a non-numeric reading before sampling — so the failure word
    // the operator asked to see in bold could never appear at Raw. Now every
    // stored reading is read on the paged path, sized by the sampled call's
    // true total, at Raw and with an interval alike.
    extraTotal = 5;
    try {
      renderPage(FIXED);
      await download(3);
      const urls = (apiClient.get as any).mock.calls.map((c: any[]) => String(c[0]));
      expect(urls.some((u: string) => /[?&]limit=12\b/.test(u))).toBe(true);
      expect(lastPdfText()).not.toMatch(/REPRESENTATIVE SAMPLE/);
    } finally {
      extraTotal = 0;
      (apiClient.get as any).mockClear();
    }
  });

  it('is laid out to the Data Report reference', async () => {
    renderPage(FIXED);
    await download(3);
    const text = lastPdfText();
    expect(text).toContain('Temperature and RH Data Report');
    for (const s of ['Block :', 'CWH Block', 'Area :', 'QC 3', 'Location :', 'LCMS Room-II', 'Inst ID :', 'DEMO-TH-142',
      'Start Date :', 'Start Time :', 'End Date :', 'End Time :', 'Temp. Limit :', '18.0 - 25.0', 'RH Limit :', '30.0 - 60.0',
      'Temp. Max :', 'RH Max :', 'Interval :', 'Raw', 'DATE', 'TIME', 'TEMPERATURE', 'RELATIVE', 'Printed By']) {
      expect(text).toContain(s);
    }
  });

  /**
   * The report's own fetch (`fetchTelemetryForPeriod`) carried the same
   * truncating defect the chart fix (Task 3) exists for: `limit=5000` hits
   * the legacy TABLE path, which the route clamps to 500 rows ordered newest
   * first, so a long report silently described the period's most recent tail.
   * `points=` puts it on the same server-side sampling path the on-screen
   * charts now use.
   */
  it('requests the report\'s telemetry on the sampled CHART path, not the legacy limit path', async () => {
    // The mock's call log is shared across this file, and the Data Report tests
    // above legitimately make a paged `limit=<total>` call; this guard is about
    // the TREND report's own fetch, so start from an empty log.
    (apiClient.get as any).mockClear();
    renderPage();
    await download(1);
    const urls = (apiClient.get as any).mock.calls.map((c: any[]) => String(c[0]));
    const telemetryCalls = urls.filter((u: string) => u.includes('/telemetry?'));
    expect(telemetryCalls.length).toBeGreaterThan(0);
    for (const u of telemetryCalls) {
      expect(u).toContain('points=');
      expect(u).not.toMatch(/[?&]limit=/);
    }
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
    // ...and the trend report's replay keeps its app-name line (the discriminating half of the Data Report's check).
    expect(lastPdfText()).toContain(BRANDING_TAB_TITLE_DEFAULT);
  });

  /**
   * The fallback the lead asked to see proven. On a real browser this branch
   * should never fire; if it does, the report must still be a usable §11 record
   * — a stated reason under the ruled header block — rather than a gap
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
    // ...and the record itself is still there: the header block (no readings
    // table since 2026-10-05 — the Time Series report carries those).
    expect(lastPdfText()).toMatch(/Block :/);
    expect(lastPdfText()).not.toMatch(/period summary/);
    expect(lastPdfText()).not.toMatch(/Timestamp/);
    expect(logged[0].reportType).toBe('Instrument Trend \u2014 Temperature');
  });

  it('carries the operator\'s remarks and the period into the audit record', async () => {
    renderPage();
    await download(1);
    expect(logged[0].remarks).toBe('periodic review');
    expect(logged[0].requestMeta.recordCount).toBe(3);
    expect(logged[0].requestMeta.period.from).toBeTruthy();
    expect(logged[0].requestMeta.period.to).toBeTruthy();
  });
});

/**
 * The three downloads print with REPORT TEMPLATES (2026-11-03, page reports on
 * templates): the template the server resolves for this instrument's profile
 * and the report's kind, shown in the dialog, pickable, never guessed.
 */
describe('trend page downloads on report templates', () => {
  beforeEach(() => { saved.length = 0; logged.length = 0; events.length = 0; images.length = 0; lastPdf = ''; plan = BUILTIN_PLAN; planAsked.length = 0; });

  /** Click the nth trigger, fill the remarks and the password, confirm — without waiting for a file. */
  function confirmDownload(buttonIndex: number) {
    fireEvent.click(exportButtons()[buttonIndex]);
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'periodic review' } });
    pickApprover();
    fireEvent.click(screen.getByText('Request approval'));
  }

  it('asks for the template of the report being downloaded — its kind, this instrument — and only while the dialog is open', () => {
    const kinds = ['page:data-report', 'page:trend', 'page:trend', 'page:data-report', 'page:instrument-alarms'];
    for (const [idx, kind] of kinds.entries()) {
      planAsked.length = 0;
      const view = renderPage();
      expect(planAsked.length).toBeGreaterThan(0);
      expect(planAsked.every((a) => a.enabled === false)).toBe(true);
      fireEvent.click(exportButtons()[idx]);
      expect(planAsked.at(-1)).toEqual({ kind, ids: ['i-1'], enabled: true });
      view.unmount();
    }
  });

  it('says in the dialog which template the report will print with', () => {
    renderPage();
    fireEvent.click(exportButtons()[1]);
    expect(screen.getByTestId('report-template-line')).toHaveTextContent('Template: Built-in (T&RH)');
  });

  it('prints with the template the server resolved for the profile: its title, and the instrument\'s attributes', async () => {
    plan = SAVED_PLAN;
    renderPage();
    await download(1);
    expect(logged[0].title).toBe('Site trend — Temperature');
    expect(logged[0].reportType).toBe('Instrument Trend — Temperature');
    const text = lastPdfText();
    expect(text).toContain('Building :');
    expect(text).toContain('B-1');
  });

  it('prints with the template PICKED in the dialog — here the built-in over the resolved one', async () => {
    const second = { ...SAVED_TEMPLATE, id: 't-2', name: 'Other layout', isDefault: false };
    plan = { ...SAVED_PLAN, sections: [{ ...SAVED_PLAN.sections[0], templates: [SAVED_TEMPLATE, second] }] };
    renderPage();
    fireEvent.click(exportButtons()[1]);
    fireEvent.change(screen.getByLabelText('Template for T&RH'), { target: { value: BUILTIN_TEMPLATE_PICK } });
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'periodic review' } });
    pickApprover();
    fireEvent.click(screen.getByText('Request approval'));
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
    expect(logged[0].title).toBe('Instrument Trend — Temperature');
  });

  it('refuses, inside the dialog, when the server names no profile for this instrument — and says so before Confirm', async () => {
    plan = EMPTY_PLAN;
    renderPage();
    fireEvent.click(exportButtons()[4]);
    // The lines NAME the instrument the loaded plan left out — never "No instruments in this
    // selection" on a page about one, and never "could not be loaded" about a plan that loaded.
    expect(screen.getByRole('alert')).toHaveTextContent('No instrument profile resolved for DEMO-TH-142 — the report will be refused');
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByText(/No instruments in this selection/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'periodic review' } });
    pickApprover();
    fireEvent.click(screen.getByText('Request approval'));
    expect(await screen.findByText(/name no instrument profile for DEMO-TH-142/)).toBeInTheDocument();
    expect(logged).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('before the instrument has loaded, the left-out line says "this instrument" — never its id', () => {
    plan = EMPTY_PLAN;
    instrumentLoaded = false;
    try {
      renderPage();
      fireEvent.click(exportButtons()[4]);
      expect(screen.getByRole('alert')).toHaveTextContent('No instrument profile resolved for this instrument — the report will be refused');
      expect(screen.queryByText(/i-1/)).toBeNull();
    } finally {
      instrumentLoaded = true;
    }
  });

  it('refuses while the templates are still loading, and after they failed', async () => {
    plan = { sections: [], loading: true, error: undefined };
    const view = renderPage();
    fireEvent.click(exportButtons()[3]);
    // Loading is not a failure: the lines say it is loading, not that the instrument has no profile.
    expect(screen.getByText('Loading the report templates…')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    confirmDownload(3);
    expect(await screen.findByText(/templates are still loading/)).toBeInTheDocument();
    view.unmount();
    plan = { sections: [], loading: false, error: new Error('500') };
    renderPage();
    confirmDownload(3);
    expect(await screen.findByText(/templates could not be loaded. Close this/)).toBeInTheDocument();
    expect(logged).toHaveLength(0);
  });

  /**
   * The instrument's attributes are read ONLY for a template that prints one
   * (an `attr:` row or a shown `attr:` column), and alongside the report's own
   * data (whole-branch review m5). Triggers: 1 = the temperature trend, 3 = the
   * Time Series (the Data Report), 4 = the alarms.
   */
  const REPORTS: [number, string][] = [[1, '/telemetry?'], [3, '/telemetry?'], [4, '/api/alarms?']];
  const getCalls = () => (apiClient.get as any).mock.calls.map((c: unknown[]) => String(c[0])) as string[];

  it('a BUILT-IN report makes no attributes request — trend, Data Report and alarms alike', async () => {
    for (const [idx] of REPORTS) {
      saved.length = 0;
      const view = renderPage();
      (apiClient.get as any).mockClear();
      await download(idx);
      expect(getCalls().filter((u) => u.endsWith('/attributes'))).toEqual([]);
      view.unmount();
    }
  });

  it('a template with an `attr:` row reads them ONCE, and IN PARALLEL with the report\'s own data, not before it', async () => {
    plan = SAVED_PLAN;
    const get = apiClient.get as any;
    try {
      for (const [idx, read] of REPORTS) {
        // The attributes answer only when released: a page that awaited them
        // BEFORE its own read would never issue that read while they are held.
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        get.mockImplementation(async (url: string) => {
          if (url.endsWith('/attributes')) await held;
          return dataFor(url);
        });
        saved.length = 0;
        const view = renderPage();
        get.mockClear();
        confirmDownload(idx);
        await waitFor(() => expect(getCalls().some((u) => u.includes(read))).toBe(true));
        expect(getCalls().filter((u) => u === '/api/instruments/i-1/attributes')).toHaveLength(1);
        expect(saved).toHaveLength(0);
        release();
        await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
        expect(getCalls().filter((u) => u.endsWith('/attributes'))).toHaveLength(1);
        expect(lastPdfText()).toContain('B-1');
        view.unmount();
      }
    } finally {
      get.mockImplementation(async (url: string) => dataFor(url));
    }
  });
});

/** UI v3 (2026-09-21): the trend page opens with the shared band; the header download rides in it. */
describe('trend page hero', () => {
  it('carries the code as the title and the Data Report download inside the band', () => {
    renderPage();
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('heading', { level: 1 }))).toBe(true);
    expect(hero.contains(exportButtons()[0])).toBe(true);
  });
});
