import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinReportTemplate, type ReportTemplateDocument, type ReportTemplateRow } from '@digilog/shared';
import type { ReportSnapshot, SnapshotSection } from '@/lib/pdf-report';
import { buildTemplatedReport } from '@/lib/templated-report';
import type { ReportLevel } from '../alarms-report';
import { alarmReportInput } from '../alarm-report-rows';
import type { AlarmRow } from '../alarm-display';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * The Alarm Report on report templates (2026-11-03, page reports on templates —
 * spec §8 / §12, "built-in equals today"). The fixtures were captured (commit
 * f60a2474) from the old builder — `buildAlarmsReport` under the page's own
 * `createReport` config — which is gone; they are the frozen record the
 * templated built-in must reproduce. A SAVED template prints exactly what it
 * shows.
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
 * legacy single-limit LOW row (its HIGH `N/A`).
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

const FROZEN = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<keyof typeof CASES, ReturnType<typeof frozen>>;

/** The report the page now prints: `alarmReportInput` (the page's own assembly) through the ONE templated builder. */
async function templated(c: AlarmFixtureCase, template: ReportTemplateRow | null = null) {
  const result = await buildTemplatedReport(alarmReportInput({
    template, rows: c.rows, total: c.total, level: c.level, period: PERIOD, search: '',
    fmt: { ...fmt, formatDateTime }, printedAt: '2026-05-29T08:30:00.000Z', user: 'qa.lead',
  }));
  return frozen(result.report.getSnapshot());
}

const savedTemplate = (patch: (d: ReportTemplateDocument) => void): ReportTemplateRow => {
  const document = builtinReportTemplate('page:alarms');
  patch(document);
  return { id: 't1', name: 'QA layout', kind: 'page:alarms', profileId: null, isDefault: true, document } as unknown as ReportTemplateRow;
};

type TableSection = Extract<SnapshotSection, { kind: 'table' }>;
const recordsTable = (r: ReturnType<typeof frozen>) => (r.sections as SnapshotSection[])
  .filter((s): s is TableSection => s.kind === 'table' && s.head.length > 0)[0];

describe('the built-in Alarm Report on templates equals today\'s', () => {
  it.each(['all', 'instrument', 'empty'] as const)('%s', async (name) => {
    expect(await templated(CASES[name])).toEqual(FROZEN[name]);
  });

  it('drops a limit column no row can fill, and every row matches its head', async () => {
    const lowOff = INSTRUMENT_ROWS.map((a) => ({ ...a, ruleSnapshot: { thresholdHigh: 27, thresholdLow: null, highEnabled: true, lowEnabled: false, decimals: 1 } }));
    const table = recordsTable(await templated({ rows: lowOff, total: lowOff.length, level: 'instrument' }));
    expect(table.head).toEqual(['DATE', 'TIME', 'DESCRIPTION', 'UOM', 'PV VALUE', 'HIGH LIMIT']);
    for (const row of table.body) expect(row).toHaveLength(table.head.length);
  });
});

describe('a SAVED Alarm Report template prints exactly what it shows (spec §8)', () => {
  it('Review Focus 3: a limit column it shows prints even when every row\'s limit is empty', async () => {
    const template = savedTemplate(() => {});
    const table = recordsTable(await templated(CASES.instrument, template));
    // The built-in would have dropped both, and the placement columns, at this level.
    expect(table.head).toEqual(builtinReportTemplate('page:alarms').columns.map((c) => c.heading));
    const high = table.head.indexOf('HIGH LIMIT');
    const low = table.head.indexOf('LOW LIMIT');
    expect(high).toBeGreaterThan(-1);
    for (const row of table.body) {
      // Nothing is invented for a switched-off bound: an EMPTY box, as the
      // built-in prints it (ruling T3-E — a page kind's '' prints '').
      expect(row[high]).toBe('');
      expect(row[low]).toBe('');
    }
    // A saved template takes jsPDF's widths, not the built-in's.
    expect(table.columnStyles).toBeUndefined();
  });

  it('its own columns, headings and order; its own title; the truncation title still rides on the table', async () => {
    const template = savedTemplate((d) => {
      d.header.title = 'Excursions — {fromDate} to {toDate}';
      d.columns = [
        { id: 'alarm.description', heading: 'What', show: true },
        { id: 'instrument.code', heading: 'Where', show: true },
        { id: 'alarm.pv', heading: 'Value', show: true },
        { id: 'alarm.low', heading: 'Low', show: false },
      ];
    });
    const r = await templated(CASES.all, template);
    expect(r.title).toBe('Excursions — 2026-05-27 to 2026-05-28');
    const table = recordsTable(r);
    expect(table.head).toEqual(['What', 'Where', 'Value']);
    expect(table.body[0]).toEqual(['High Temperature', 'CWH/RDU/046-00', '27.4']);
    expect(table.title).toBe(FROZEN.all.sections[1].title);
  });

  it('its own legend replaces the page\'s structured one', async () => {
    const r = await templated(CASES.all, savedTemplate((d) => { d.notes.legend = 'PV = the reading that raised the alarm'; }));
    expect(r.config.legend).toBeUndefined();
    expect(r.chrome.legend).toBe('PV = the reading that raised the alarm');
  });

  it('an empty period says so in the builder\'s words (the width-matched row is the built-in\'s)', async () => {
    const table = recordsTable(await templated(CASES.empty, savedTemplate(() => {})));
    expect(table.body).toEqual([[{ content: 'No records.', colSpan: 10 }]]);
  });
});
