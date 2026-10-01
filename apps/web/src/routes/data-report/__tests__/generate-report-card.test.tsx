import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Generate Data Report card (2026-09-07). Operator: *"create one card only
 * text should be there Generate Data report and one download icon, when ever
 * user click on that download icon i need same dialog with time period
 * selection, interval and remarks then password reauthentication same like how
 * timeseries widget is behaving … and report should be same report of time
 * series widget"*, then, asked whether the multi-instrument file keeps its
 * cover block: no — one page per instrument, each the trend page's Data Report.
 *
 * Rendered with the widget beside it, the way the page does, because the card
 * reports what the widget SHOWS: the selection lives in the page's
 * `useHistoryScope()` and both read it. Two instruments with DIFFERENT limits so
 * the per-instrument parameter block is a discriminating assertion.
 */

const tree = [{ id: 'b1', name: 'CWH Block', children: [{ id: 'a1', name: 'QC 3' }, { id: 'a2', name: 'Stability' }] }];
const instruments = [
  { id: '11111111-1111-4111-8111-111111111111', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', functionalLocationId: 'a1' },
  { id: '22222222-2222-4222-8222-222222222222', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', functionalLocationId: 'a1' },
];
const [A, B] = instruments;
const overview = [
  {
    instrumentId: A.id, code: A.code, name: A.code, isActive: true, room: null,
    functionalLocationName: 'QC 3', locationAttribute: 'LCMS Room-I',
    limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 }, limitSource: 'INSTRUMENT',
    temperature: { key: 'temperature', value: 26, ts: '2026-08-24T00:20:00.000Z' },
    humidity: { key: 'humidity', value: 45, ts: '2026-08-24T00:20:00.000Z' },
    decimals: { temperature: 1, humidity: 0 }, reporting: true, status: 'OUT_OF_SPEC',
    rangeBounds: { temperatureLow: -10, temperatureHigh: 50, humidityLow: 0, humidityHigh: 100 },
  },
  {
    instrumentId: B.id, code: B.code, name: B.code, isActive: true, room: null,
    functionalLocationName: 'QC 3', locationAttribute: 'LCMS Room-II',
    limits: { tempMin: 18, tempMax: 30, rhMin: 30, rhMax: 60 }, limitSource: 'INSTRUMENT',
    temperature: { key: 'temperature', value: 26, ts: '2026-08-24T00:20:00.000Z' },
    humidity: { key: 'humidity', value: 45, ts: '2026-08-24T00:20:00.000Z' },
    decimals: { temperature: 1, humidity: 0 }, reporting: true, status: 'OK',
    rangeBounds: { temperatureLow: -10, temperatureHigh: 50, humidityLow: 0, humidityHigh: 100 },
  },
];
const historyRows = [
  { instrumentId: A.id, ts: '2026-08-24T00:20:00.000Z', values: { temperature: 26, humidity: 45 } },
  { instrumentId: B.id, ts: '2026-08-24T00:20:00.000Z', values: { temperature: 26, humidity: 45 } },
];
const longHistory = [
  { key: 'temperature', value: 26, ts: '2026-08-24T00:20:00.000Z' },
  { key: 'humidity', value: 45, ts: '2026-08-24T00:20:00.000Z' },
];

const requested: string[] = [];
/** The role's administered Export Options for this surface; `undefined` = not administered (both formats). */
let exportFormat: string | undefined;

/** Configuration → Report Downloads as the narrow route returns it (2026-10-01):
 *  every kind REQUEST with remarks and password — today's behaviour. Constant,
 *  so the swr mock never hands back a fresh object. */
const KIND_REQUEST = { mode: 'REQUEST', remarksRequired: true, passwordRequired: true };
const DOWNLOADS = { 'data-report': KIND_REQUEST, 'trend-chart': KIND_REQUEST, 'instrument-alarms': KIND_REQUEST, alarms: KIND_REQUEST, 'audit-trail': KIND_REQUEST };
const APPROVERS = { approverRoles: ['QA'], approverUserIds: [] };

function dataFor(key: string | null): any {
  if (!key) return undefined;
  requested.push(key);
  if (key.includes('/api/config/export-options/current')) return exportFormat ? { 'instrument-history': exportFormat } : {};
  if (key.includes('/telemetry-overview')) return { data: overview };
  if (key.includes('/telemetry-history?')) {
    const ids = new URLSearchParams(key.split('?')[1]).get('instrumentIds')!.split(',');
    const rows = historyRows.filter((r) => ids.includes(r.instrumentId));
    return { data: rows, total: rows.length };
  }
  if (key.includes('/telemetry?')) {
    return { latest: [], history: longHistory, historyTotal: longHistory.length, summaries: { temperature: { min: 26, max: 26 }, humidity: { min: 45, max: 45 } } };
  }
  if (key.includes('/api/functional-locations')) return { data: tree };
  if (key.startsWith('/api/instruments?')) {
    const scope = new URLSearchParams(key.split('?')[1]).get('functionalLocationId');
    return { data: scope === 'a2' ? [] : instruments, total: scope === 'a2' ? 0 : 2 };
  }
  if (key.startsWith('/api/config/report-downloads/current')) return DOWNLOADS;
  if (key.startsWith('/api/config/report-approvers/current')) return APPROVERS;
  if (key.includes('action-reauth/my-actions')) return { actions: [] };
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
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const { GenerateReportCard } = await import('../generate-report-card');
const { InstrumentHistoryWidget } = await import('@/routes/instruments/history-widget');
const { useHistoryScope } = await import('../use-history-scope');
const jspdf: any = await import('jspdf');

const saved: string[] = [];
let lastPdf = '';
let lastPages = 0;
jspdf.default.API.save = function (this: any, name: string) {
  saved.push(name);
  events.push(`save:${name}`);
  const pages = (this.internal.pages as string[][]);
  lastPages = pages.filter(Boolean).length;
  const raw: string = pages.filter(Boolean).flat().join('\n');
  lastPdf = [...raw.matchAll(/\((.*?)\)\s*Tj/gs)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' ');
  return this;
};

const FIXED = '?from=2026-08-24T00%3A00%3A00.000Z&to=2026-08-24T01%3A00%3A00.000Z&label=Custom';

function Harness() {
  const scope = useHistoryScope();
  return (
    <>
      <GenerateReportCard scope={scope} />
      <InstrumentHistoryWidget scope={scope} />
    </>
  );
}

function renderBoth(query = FIXED) {
  return render(
    <MemoryRouter initialEntries={[`/data-report${query}`]}>
      <Harness />
    </MemoryRouter>,
  );
}

function pickArea() {
  fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'b1' } });
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'a1' } });
}

async function confirmDownload(remarks: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Export as PDF' }));
  fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: remarks } });
  // No approver is chosen (2026-10-01); the password is signed in the dialog.
  fireEvent.change(document.getElementById('report-download-password') as HTMLInputElement, { target: { value: 'Secret@123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
}

describe('GenerateReportCard', () => {
  beforeEach(() => { requested.length = 0; events.length = 0; logged.length = 0; saved.length = 0; lastPdf = ''; lastPages = 0; exportFormat = undefined; });

  it('is the text and one download icon, nothing else', () => {
    renderBoth();
    const card = screen.getByTestId('generate-report-card');
    expect(card).toHaveTextContent('Generate Data report');
    expect(screen.getByRole('button', { name: 'Export as PDF' })).toBeInTheDocument();
    expect(card.querySelectorAll('button')).toHaveLength(1);
  });

  // 2026-09-16 restyle: the band states what a press would report — the same
  // selection the widget shows — so nobody scrolls down to check first.
  it('states the selection it would report: count, period and scope', () => {
    renderBoth();
    expect(screen.getByTestId('generate-report-summary')).toHaveTextContent('Choose a Block or Area');
    fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'b1' } });
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'a1' } });
    expect(screen.getByTestId('generate-report-summary')).toHaveTextContent('2 instruments · Custom · QC 3');
    expect(screen.getByTestId('generate-report-card').querySelectorAll('button')).toHaveLength(1);
  });

  it('is not rendered at all for a role whose Export Options allow no PDF here', () => {
    // Text reading "Generate Data report" beside no icon is an inert control —
    // the same decoy rule the trend page applies to unused props. `ExportMenu`
    // already returns null for that role; the card must go with it.
    exportFormat = 'NONE';
    renderBoth();
    expect(screen.queryByTestId('generate-report-card')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export as PDF' })).toBeNull();
    // The widget beneath is unaffected.
    expect(screen.getByTestId('history-widget')).toBeInTheDocument();
  });

  it('opens the Time Series dialog — period, interval and remarks — seeded from the page', () => {
    renderBoth();
    fireEvent.click(screen.getByRole('button', { name: 'Export as PDF' }));
    expect(screen.getByLabelText(/^Interval$/)).toBeInTheDocument();
    const dialogInterval = document.getElementById('report-download-interval') as HTMLSelectElement | null;
    expect(dialogInterval).not.toBeNull();
    expect(dialogInterval!.value).toBe('');
    expect(screen.getByLabelText(/Remarks/)).toBeInTheDocument();
  });

  it('downloads ONE file with a page per selected instrument, the Time Series document each, writing the audit row before the file', async () => {
    renderBoth();
    pickArea();
    await confirmDownload('area review');
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });

    // Nothing is saved by the card itself: the only file is the stand-in's
    // replay of the submitted snapshot (2026-09-07 — every download is a request).
    expect(saved[0]).toMatch(/^replay-/);
    // The audit type is the trend page's — it IS that report, for each instrument.
    expect(events).toEqual(['log:Instrument Time Series', `save:${saved[0]}`]);
    expect(logged[0]).toMatchObject({ reportKind: 'data-report', reportType: 'Instrument Time Series', remarks: 'area review', password: 'Secret@123', snapshotVersion: 2 });
    expect(logged[0].requestMeta.instrumentCodes).toEqual([A.code, B.code]);
    // The instrument IDS decide who may see the request (2026-10-01).
    expect(logged[0].instrumentIds).toEqual([A.id, B.id]);
    // Both instruments were read: a sampled call and a whole-period call each.
    const perInstrument = (id: string) => requested.filter((u) => u.includes(`/api/instruments/${id}/telemetry?`));
    expect(perInstrument(A.id).some((u) => u.includes('points='))).toBe(true);
    expect(perInstrument(A.id).some((u) => u.includes('limit='))).toBe(true);
    expect(perInstrument(B.id).some((u) => u.includes('points='))).toBe(true);
    // One page per instrument, no cover page in front — and in the selection's
    // ORDER, whatever order the reads completed in (they run a few at a time).
    expect(lastPages).toBe(2);
    expect(lastPdf.indexOf(A.code)).toBeLessThan(lastPdf.indexOf(B.code));
    expect(lastPdf).not.toContain('Instruments :');
    expect(lastPdf).toContain(A.code);
    expect(lastPdf).toContain(B.code);
    // Each page carries ITS instrument's own limit — 25 on A, 30 on B.
    expect(lastPdf).toMatch(/25\.0/);
    expect(lastPdf).toMatch(/30\.0/);
  });

  it('downloads only the ticked instruments', async () => {
    renderBoth();
    pickArea();
    fireEvent.click(screen.getByLabelText(B.code));
    await confirmDownload('one probe');
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
    expect(requested.some((u) => u.includes(`/api/instruments/${B.id}/telemetry?`))).toBe(false);
    expect(lastPages).toBe(1);
    expect(lastPdf).toContain(A.code);
    expect(lastPdf).not.toContain(B.code);
  });

  it('refuses, inside the dialog, when nothing is selected', async () => {
    renderBoth();
    await confirmDownload('nothing chosen');
    expect(await screen.findByText(/Select at least one instrument/)).toBeInTheDocument();
    expect(saved).toHaveLength(0);
    expect(logged).toHaveLength(0);
  });
});
