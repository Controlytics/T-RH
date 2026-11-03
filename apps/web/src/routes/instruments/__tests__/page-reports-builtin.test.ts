import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportDoc } from '@/lib/pdf-report';
import { renderDataReports, renderTrendReport, renderAlarmsReport } from '../trend-report';
import {
  dataA, dataB, dataCapped, formatDateTime, period, trendHeader, trendCharts, alarmRows, statusTexts, inactivityTexts,
} from './fixtures/page-report-inputs';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * Today's three instrument page reports, FROZEN (2026-11-03, page reports on
 * templates, Task 4 step 1). Run once with `CAPTURE=1` against the hand-built
 * renderers to write the fixtures; otherwise each render must equal its file.
 *
 * What is frozen: the title, subtitle, orientation, the structured legend, the
 * whole type scale, the chrome (less the logo's bytes — none loads here) and
 * every drawing call. `config.showAppName` is left out on purpose: the chrome
 * carries the app-name line (`chrome.showAppName`, frozen), and the templated
 * builder hands `createReport` a chrome, not the flag. An image keeps its size
 * (to a millionth of a millimetre — the two builders compute the height in a
 * different order) and drops its bytes.
 */

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function frozen(report: ReportDoc, compact = false): unknown {
  const s = report.getSnapshot();
  const { logoDataUrl: _logo, ...chrome } = s.chrome ?? ({} as Record<string, unknown>);
  const sections = s.sections.map((x) => {
    if (x.kind === 'image') return { kind: 'image', widthMm: round(x.widthMm), heightMm: round(x.heightMm) };
    // A capped table is 2,000 rows: its first and last row and its length are what it is pinned by.
    if (compact && x.kind === 'table' && x.head.length) {
      return { ...x, body: [x.body[0], x.body.at(-1)], bodyLength: x.body.length, ...(x.bold ? { bold: [x.bold[0], x.bold.at(-1)] } : {}) };
    }
    return x;
  });
  return JSON.parse(JSON.stringify({
    reportType: s.reportType, title: s.title, subtitle: s.subtitle, orientation: s.orientation,
    legend: s.config.legend, typography: s.config.typography, chrome, sections,
  }));
}

// NOT `new URL('./fixtures/…', import.meta.url)`: Vite rewrites that form as an asset import, and a templated name resolves to `undefined`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixturePath = (name: string) => join(FIXTURES, `page-report-builtin-${name}.json`);

function pin(name: string, actual: unknown): void {
  if (process.env.CAPTURE === '1') {
    writeFileSync(fixturePath(name), `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    return;
  }
  expect(actual).toEqual(JSON.parse(readFileSync(fixturePath(name), 'utf8')));
}

// The Branding fetches go nowhere here: the chrome is the shipped defaults, deterministically.
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as any; });
afterAll(() => { globalThis.fetch = realFetch; });

const trendInstrument = { code: 'CWH/RDU/046-00', name: 'CWH/RDU/046-00', locationText: 'Not placed on a floorplan', limitsText: '' };

describe('today\'s page reports, frozen', () => {
  it('the Data Report of two instruments', async () => {
    pin('data', frozen(await renderDataReports({ formatDateTime, instruments: [dataA, dataB] })));
  });

  it('the Data Report over the 2,000-row cap', async () => {
    pin('data-capped', frozen(await renderDataReports({ formatDateTime, instruments: [dataCapped()] }), true));
  });

  it('the Instrument Trend, two charts, averaged', async () => {
    pin('trend', frozen(await renderTrendReport({
      slotLabel: 'Temperature & Humidity', charts: trendCharts, instrument: trendInstrument, period, formatDateTime,
      header: trendHeader, averagedLabel: '5 minutes', coverage: { returned: 3, total: 3 },
    })));
  });

  it('the Instrument Alarms, three alarms', async () => {
    pin('instrument-alarms', frozen(await renderAlarmsReport(
      alarmRows, trendInstrument, period, formatDateTime, statusTexts, inactivityTexts, trendHeader,
    )));
  });
});
