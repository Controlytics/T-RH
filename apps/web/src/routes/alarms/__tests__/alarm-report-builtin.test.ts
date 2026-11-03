import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createReport, type ReportSnapshot } from '@/lib/pdf-report';
import { ALARM_REPORT_LEGEND, buildAlarmsReport, type ReportLevel } from '../alarms-report';
import type { AlarmRow } from '../alarm-display';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * The Alarm Report as it printed BEFORE report templates (2026-11-03, page
 * reports on templates — spec §12, "built-in equals today"). The fixtures were
 * captured from the old builder (`buildAlarmsReport` under the page's own
 * `createReport` config) and are the frozen record the templated built-in must
 * reproduce.
 */

const FIXTURE = join(__dirname, 'fixtures', 'alarm-report-builtin.json');

const PERIOD = { from: '2026-05-27T16:00:00.000Z', to: '2026-05-28T16:00:00.000Z' };
const fmt = {
  formatDate: (iso: string) => iso.slice(0, 10),
  formatTime: (iso: string) => iso.slice(11, 16),
};
const formatDateTime = (iso: string) => iso.slice(0, 16).replace('T', ' ');

const alarm = (over: Partial<AlarmRow>): AlarmRow => ({
  id: 'a1',
  instrumentCode: 'CWH/RDU/046-00',
  instrumentId: 'i1',
  locationName: 'QC 3',
  locationAttribute: 'LCMS Room-II',
  metric: 'TEMPERATURE',
  triggeredValue: 27.4,
  state: 'ACTIVE',
  raisedAt: '2026-05-28T12:02:00.000Z',
  clearedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  acknowledgeReason: null,
  source: 'INSTRUMENT_LIMIT',
  limitKind: 'HIGH',
  ruleSnapshot: { thresholdHigh: 27, thresholdLow: 18, highEnabled: true, lowEnabled: true, decimals: 1 },
  ...over,
});

/**
 * Level `all`, four rows of ten (so the truncation note prints): both bounds;
 * a switched-off LOW bound (an EMPTY cell) beside rows that fill LOW, so the
 * column stays; an inactivity alarm (N/A, N/A) with no Location attribute; a
 * legacy single-limit LOW row whose HIGH bound carries text.
 */
const ALL_ROWS: AlarmRow[] = [
  alarm({ id: 'a1' }),
  alarm({
    id: 'a2', instrumentCode: 'CWH/RDU/002-01', instrumentId: 'i2', locationName: 'Stability', locationAttribute: 'Chamber 2',
    metric: 'HUMIDITY', triggeredValue: 71.2, raisedAt: '2026-05-28T09:15:00.000Z',
    ruleSnapshot: { thresholdHigh: 65, thresholdLow: null, highEnabled: true, lowEnabled: false, decimals: 1 },
  }),
  alarm({
    id: 'a3', instrumentCode: 'CWH/RDU/030-00', instrumentId: 'i3', locationName: 'Ware House', locationAttribute: null,
    metric: 'OFFLINE', triggeredValue: null, source: 'INACTIVITY', limitKind: null, raisedAt: '2026-05-28T03:40:00.000Z',
    ruleSnapshot: { graceMinutes: 15 } as AlarmRow['ruleSnapshot'],
  }),
  alarm({
    id: 'a4', triggeredValue: 17.6, limitKind: 'LOW', raisedAt: '2026-05-27T22:05:00.000Z',
    ruleSnapshot: { limit: 18, limitKind: 'LOW', decimals: 1 },
  }),
];

/** Level `instrument`, every limit switched off — both limit columns are dropped. */
const INSTRUMENT_ROWS: AlarmRow[] = [0, 1, 2].map((n) => alarm({
  id: `b${n}`, raisedAt: `2026-05-28T1${n}:00:00.000Z`, triggeredValue: 28 + n,
  ruleSnapshot: { thresholdHigh: null, thresholdLow: null, highEnabled: false, lowEnabled: false, decimals: 1 },
}));

interface AlarmFixtureCase { rows: AlarmRow[]; total: number; level: ReportLevel }
const CASES: Record<'all' | 'instrument' | 'empty', AlarmFixtureCase> = {
  all: { rows: ALL_ROWS, total: 10, level: 'all' },
  instrument: { rows: INSTRUMENT_ROWS, total: 3, level: 'instrument' },
  empty: { rows: [], total: 0, level: 'area' },
};

/** What is frozen: the snapshot as JSON (an absent field is absent). */
const frozen = (s: ReportSnapshot) => JSON.parse(JSON.stringify({
  version: s.version, reportType: s.reportType, title: s.title, subtitle: s.subtitle, orientation: s.orientation,
  config: s.config, chrome: s.chrome, sections: s.sections,
}));

beforeEach(() => {
  // Branding with no logo of its own; the default logo request fails (no logo drawn).
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/api/config/branding')) return { ok: true, json: async () => ({ companyName: 'Branding Co', appName: 'Branding App' }) };
    return { ok: false };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** TODAY's Alarm Report: the page's own `createReport` config (`routes/alarms/index.tsx`), then `buildAlarmsReport`. */
async function oldReport(c: AlarmFixtureCase) {
  const doc = await createReport({
    title: 'ALARM REPORT',
    orientation: 'portrait',
    formatDateTime,
    reportKey: 'alarms',
    legend: ALARM_REPORT_LEGEND,
  });
  buildAlarmsReport(doc, {
    rows: c.rows,
    total: c.total,
    scope: { blockName: '', areaName: '', locationName: '', instrumentLabel: '' },
    period: PERIOD,
    fmt,
    level: c.level,
  });
  return frozen(doc.getSnapshot());
}

describe('the Alarm Report as it printed before templates (captured)', () => {
  it('captures or matches the three frozen cases', async () => {
    const captured = {
      all: await oldReport(CASES.all),
      instrument: await oldReport(CASES.instrument),
      empty: await oldReport(CASES.empty),
    };
    if (process.env.CAPTURE === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(captured, null, 2)}\n`, 'utf8');
    }
    expect(captured).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });
});
