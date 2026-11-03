/**
 * The inputs the page-report fixtures were captured from (2026-11-03, page
 * reports on templates, Task 4). Today's three instrument page reports — the
 * Data Report (two instruments), the Instrument Trend (two charts), the
 * Instrument Alarms (three alarms) — were rendered from THESE, before the
 * templated builders replaced the hand-built ones, and their snapshots frozen
 * in the JSON beside this file. The templated builders, drawn from each kind's
 * BUILT-IN template, must reproduce them exactly.
 *
 * Chosen to reach every branch the old builders had: both extremes, a lone
 * spanned extreme, MKT, NMT / NLT / NA in the legend, a breach and both fault
 * words bold, an empty period, a blank Area (the `-` a header prints), an
 * averaged chart, a chart with no picture, an inactivity alarm and a cleared
 * one.
 */
import type { AlarmRow } from '@/routes/alarms/alarm-display';
import type { ReportSlotRow } from '../../data-report';
import type { TableRow } from '../../trend-series';

/** A 90 x 26 px PNG — non-square, so a picture sized from its own bytes and one sized from its declared size agree. */
export const PNG_90x26 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFoAAAAaCAIAAAC4ktw5AAAARUlEQVR4nO3QMQ0AMAwEsSApzkIMrG4B0OUzWDoAJ9e5raniB6vCgQMHDhw4cODAgSMfDhw4cODAgQMHDhz5cODAgeOnB90of+0Edj0SAAAAAElFTkSuQmCC';

export const fmt = { formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) };
export const formatDateTime = (d: string) => d.slice(0, 16).replace('T', ' ');
export const period = { from: '2026-08-24T00:00:00.000Z', to: '2026-08-24T01:00:00.000Z', label: 'Last hour' };
export const words = { failure: 'Error', outOfRange: 'OL' };

const slot = (ts: string, values: Record<string, number | null>, errors?: Record<string, boolean>): ReportSlotRow<TableRow> => ({
  ts, row: { ts, values, ...(errors ? { errors } : {}) } as TableRow,
});

/**
 * Instrument A: both temperature bounds and an RH NMT in force (so both
 * extremes pairs print), MKT on, a blank Area. Newest first, as `scheduleRows`
 * returns them: a breach (26.9 > 25), a slot with nothing in it (`NA`), the
 * failure word, the out-of-range word (span 0–60 on RH), a plain reading.
 */
export const dataA = {
  scope: { blockName: 'CWH Block', areaName: '', locationName: 'LCMS Room-I', instrumentLabel: 'CWH/RDU/001-00' },
  period, fmt, formatDateTime,
  temp: {
    key: 't', min: 18, max: 25, decimals: 1, rangeLow: -10, rangeHigh: 50,
    periodMax: 26.9, periodMin: 21.2, periodMkt: 22.31,
  },
  rh: {
    key: 'h', min: null, max: 60, decimals: 0, rangeLow: 0, rangeHigh: 60,
    periodMax: 63, periodMin: 41, periodMkt: null,
  },
  rows: [
    slot('2026-08-24T01:00:00.000Z', { t: 26.9, h: 45 }),
    { ts: '2026-08-24T00:45:00.000Z', row: null },
    slot('2026-08-24T00:30:00.000Z', { t: null, h: 44 }, { t: true }),
    slot('2026-08-24T00:15:00.000Z', { t: 22.4, h: 63 }),
    slot('2026-08-24T00:00:00.000Z', { t: 22.5, h: 41 }),
  ],
  intervalMs: 900_000,
  coverage: { returned: 4, total: 4 },
  words,
};

/** Instrument B: an NLT-only temperature bound (the lone extreme spans), no RH key or bound, no MKT, an EMPTY period. */
export const dataB = {
  scope: { blockName: 'CWH Block', areaName: 'QC 3', locationName: 'LCMS Room-II', instrumentLabel: 'CWH/RDU/002-00' },
  period, fmt, formatDateTime,
  temp: { key: 't', min: 15, max: null, decimals: 1, periodMax: null, periodMin: null, periodMkt: null },
  rh: { key: null, min: null, max: null, decimals: 0, periodMax: null, periodMin: null, periodMkt: null },
  rows: [] as ReportSlotRow<TableRow>[],
  intervalMs: 900_000,
  coverage: { returned: 0, total: 0 },
  words,
};

/**
 * One instrument whose period holds 2,001 readings — one over the cap — so the
 * report prints the first 2,000 under the truncation pill. Newest first.
 */
export function dataCapped() {
  const start = Date.parse('2026-08-24T00:00:00.000Z');
  const rows = Array.from({ length: 2001 }, (_, i) => {
    const ts = new Date(start + (2000 - i) * 1000).toISOString();
    return slot(ts, { t: 22 + (i % 10) / 10, h: 45 });
  });
  return { ...dataA, rows, intervalMs: null, coverage: { returned: 2001, total: 2001 } };
}

/** The trend page's header scope: a blank Location (the `-` a header prints). */
export const trendHeader = {
  scope: { blockName: 'CWH Block', areaName: 'QC 3', locationName: '', instrumentLabel: 'CWH/RDU/046-00' },
  fmt,
};

/** A drawn chart and one that could not be drawn. */
export const trendCharts = [
  { title: 'Temperature', image: { dataUrl: PNG_90x26, width: 90, height: 26 }, unavailableReason: '' },
  { title: 'Humidity', image: null, unavailableReason: 'No readings in this period, so there is nothing to plot.' },
];

const alarm = (over: Partial<AlarmRow>): AlarmRow => ({
  id: 'a1', instrumentCode: 'CWH/RDU/046-00', instrumentId: 'i1', metric: 'TEMPERATURE', triggeredValue: 27.4,
  state: 'ACTIVE', raisedAt: '2026-08-24T00:12:00.000Z', clearedAt: null, acknowledgedAt: null, acknowledgedBy: null,
  acknowledgeReason: null, source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH',
  ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1 },
  ...over,
});

/** A live high breach, a cleared low breach, an inactivity alarm. */
export const alarmRows: AlarmRow[] = [
  alarm({}),
  alarm({
    id: 'a2', metric: 'HUMIDITY', triggeredValue: 28, state: 'CLEARED', limitKind: 'LOW',
    raisedAt: '2026-08-24T00:20:00.000Z', clearedAt: '2026-08-24T00:35:00.000Z', clearedValue: 31,
    ruleSnapshot: { limit: 30, limitKind: 'LOW', decimals: 0 },
  }),
  alarm({
    id: 'a3', source: 'INACTIVITY', metric: 'OFFLINE', limitKind: null, triggeredValue: null,
    raisedAt: '2026-08-24T00:45:00.000Z', ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 15 } as any,
  }),
];

export const statusTexts = undefined;
/** Administered wording that differs from the shipped defaults, so a dropped bag shows. */
export const inactivityTexts = { generatedValue: 'No signal', limit: 'silent > {minutes}m', clearedValue: 'Signal back' };
