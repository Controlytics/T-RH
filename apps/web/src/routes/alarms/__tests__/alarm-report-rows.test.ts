import { describe, it, expect } from 'vitest';
import {
  REPORT_TEMPLATE_FIELDS, builtinReportTemplate,
  type ReportTemplateDocument, type ReportTemplateRow,
} from '@digilog/shared';
import {
  ALARM_REPORT_LEGEND, columnWidths, hiddenLimitColumns, reportHead, reportRows, truncationNote,
} from '../alarms-report';
import {
  NO_ALARMS_IN_PERIOD,
  alarmReportInput, alarmReportPlaceholderValues, builtinAlarmColumns, rowsForAlarmReport,
} from '../alarm-report-rows';
import type { AlarmDisplayTexts, AlarmRow } from '../alarm-display';

/**
 * The Alarm Report's ROWS and its one SECTION on templates (2026-11-03, page
 * reports on templates — spec §6 / §8). A cell is the string the page printed
 * before templates (`reportRows`, the ONE source of the cell text); the
 * built-in's two rules — placement columns by level, a limit column nobody
 * fills dropped — are the BUILT-IN's, and a saved template prints exactly the
 * columns it shows.
 */

const fmt = {
  formatDate: (iso: string) => iso.slice(0, 10),
  formatTime: (iso: string) => iso.slice(11, 16),
  formatDateTime: (iso: string) => iso.slice(0, 16).replace('T', ' '),
};
const PERIOD = { from: '2026-05-27T16:00:00.000Z', to: '2026-05-28T16:00:00.000Z' };

const alarm = (over: Partial<AlarmRow>): AlarmRow => ({
  id: 'a1', instrumentCode: 'CWH/RDU/046-00', instrumentId: 'i1', locationName: 'QC 3', locationAttribute: 'LCMS Room-II',
  metric: 'TEMPERATURE', triggeredValue: 27.4, state: 'ACTIVE', raisedAt: '2026-05-28T12:02:00.000Z', clearedAt: null,
  acknowledgedAt: null, acknowledgedBy: null, acknowledgeReason: null, source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH',
  ruleSnapshot: { thresholdHigh: 27, thresholdLow: 18, highEnabled: true, lowEnabled: true, decimals: 1 },
  ...over,
});
const both = alarm({ id: 'a1' });
const lowOff = alarm({
  id: 'a2', instrumentCode: 'CWH/RDU/002-01', locationName: 'Stability', locationAttribute: 'Chamber 2', metric: 'HUMIDITY',
  triggeredValue: 71.2, ruleSnapshot: { thresholdHigh: 65, thresholdLow: null, highEnabled: true, lowEnabled: false, decimals: 1 },
});
const inactivity = alarm({
  id: 'a3', instrumentCode: 'CWH/RDU/030-00', locationName: 'Ware House', locationAttribute: null, metric: 'OFFLINE',
  triggeredValue: null, source: 'INACTIVITY', limitKind: null, ruleSnapshot: { graceMinutes: 15 } as AlarmRow['ruleSnapshot'],
});
const probeFault = alarm({ id: 'a5', source: 'RS485_FAILURE', limitKind: null, triggeredValue: null, ruleSnapshot: { decimals: 1 } });
const allOff = alarm({ id: 'a4', ruleSnapshot: { thresholdHigh: null, thresholdLow: null, highEnabled: false, lowEnabled: false, decimals: 1 } });
/** An administered failure word, so a page's wording is shown to reach the cell. */
const texts: AlarmDisplayTexts = { sensorFailure: 'Fault' };

const BUILTIN_IDS = REPORT_TEMPLATE_FIELDS('page:alarms').map((f) => f.id);

describe('the ten built-in fields are the columns the page printed, in its order', () => {
  it('the i-th field is headed with today\'s i-th word — the row builder zips on this', () => {
    // `reportHead('all')` is every column today's report could print, in its order.
    expect(REPORT_TEMPLATE_FIELDS('page:alarms').map((f) => f.label)).toEqual(reportHead('all'));
    expect(BUILTIN_IDS).toEqual([
      'instrument.code', 'instrument.area', 'instrument.location',
      'alarm.date', 'alarm.time', 'alarm.description', 'alarm.uom', 'alarm.pv', 'alarm.high', 'alarm.low',
    ]);
  });
});

describe('rowsForAlarmReport — today\'s strings, keyed by field id', () => {
  const rows = [both, lowOff, inactivity, probeFault];

  it('cell for cell what `reportRows` printed at the widest level', () => {
    const today = reportRows(rows, fmt, texts, 'all');
    const built = rowsForAlarmReport(rows, fmt, texts);
    expect(built).toHaveLength(4);
    built.forEach((row, r) => {
      expect(BUILTIN_IDS.map((id) => row[id])).toEqual(today[r]);
    });
  });

  it('names each fact as the page did', () => {
    const [a, b, c, d] = rowsForAlarmReport(rows, fmt, texts);
    // The page's administered wording reaches the cell.
    expect(d['alarm.pv']).toBe('Fault');
    expect(a).toMatchObject({
      'instrument.code': 'CWH/RDU/046-00', 'instrument.area': 'QC 3', 'instrument.location': 'LCMS Room-II',
      'alarm.date': '2026-05-28', 'alarm.time': '12:02', 'alarm.description': 'High Temperature', 'alarm.uom': '°C',
      'alarm.pv': '27.4', 'alarm.high': '27.0', 'alarm.low': '18.0',
    });
    // A switched-off bound is EMPTY, a bound nobody administered `N/A`; a missing Location a dash.
    expect(b['alarm.low']).toBe('');
    expect(c['alarm.high']).toBe('N/A');
    expect(c['instrument.location']).toBe('-');
  });
});

describe('builtinAlarmColumns — the built-in\'s two rules', () => {
  const shownIds = (level: Parameters<typeof builtinAlarmColumns>[0], rows: AlarmRow[]) =>
    builtinAlarmColumns(level, rows).filter((c) => c.show).map((c) => c.id);

  it('one instrument, every limit switched off: no placement column, no limit column', () => {
    const ids = shownIds('instrument', [allOff, allOff]);
    expect(ids).not.toContain('alarm.high');
    expect(ids).not.toContain('alarm.low');
    expect(ids).not.toContain('instrument.code');
    expect(ids).toEqual(['alarm.date', 'alarm.time', 'alarm.description', 'alarm.uom', 'alarm.pv']);
  });

  it('an Area: the instrument and its Location vary, the Area does not', () => {
    expect(shownIds('area', [both])).toEqual([
      'instrument.code', 'instrument.location', 'alarm.date', 'alarm.time', 'alarm.description', 'alarm.uom', 'alarm.pv', 'alarm.high', 'alarm.low',
    ]);
  });

  it('everything: all ten, in today\'s order, a limit column kept while ANY row fills it', () => {
    expect(shownIds('all', [both, lowOff])).toEqual(BUILTIN_IDS);
    expect(shownIds('block', [lowOff])).not.toContain('alarm.low');
  });

  it('lists every built-in column (a hidden one with show off), headed by the built-in', () => {
    const cols = builtinAlarmColumns('instrument', [allOff]);
    expect(cols.map((c) => c.id)).toEqual(BUILTIN_IDS);
    const builtin = new Map(builtinReportTemplate('page:alarms').columns.map((c) => [c.id, c.heading]));
    for (const c of cols) expect(c.heading).toBe(builtin.get(c.id));
  });
});

describe('alarmReportPlaceholderValues', () => {
  it('the period four ways, the count, the level, and the search quoted', () => {
    expect(alarmReportPlaceholderValues({ period: PERIOD, fmt, recordCount: 4, search: '  freezer ', level: 'area' })).toEqual({
      fromDate: '2026-05-27', fromTime: '16:00', toDate: '2026-05-28', toTime: '16:00',
      from: '2026-05-27 16:00', to: '2026-05-28 16:00', period: '2026-05-27 16:00 – 2026-05-28 16:00',
      recordCount: '4', search: '"freezer"', level: 'Area',
    });
  });

  it('no search = no value (it prints "—")', () => {
    const v = alarmReportPlaceholderValues({ period: PERIOD, fmt, recordCount: 0, search: ' ', level: 'all' });
    expect(v).not.toHaveProperty('search');
    expect(v.level).toBe('All instruments');
  });
});

describe('alarmReportInput — the ONE section the page prints', () => {
  const base = {
    period: PERIOD, search: '', fmt, texts, printedAt: '2026-05-29T08:30:00.000Z', user: 'qa.lead',
  };

  it('the built-in: the two rules, today\'s widths, the structured legend, the truncation title before the table', () => {
    const input = alarmReportInput({ ...base, template: null, rows: [both, lowOff], total: 9, level: 'block' });
    expect(input).toMatchObject({ kind: 'page:alarms', reportKey: 'alarms', legend: ALARM_REPORT_LEGEND });
    expect(input.formatDateTime).toBe(fmt.formatDateTime);
    expect(input.values).toMatchObject({ date: '2026-05-29 08:30', user: 'qa.lead', recordCount: '2', level: 'Block' });
    expect(input.sections).toHaveLength(1);
    const [s] = input.sections;
    expect(s).toMatchObject({ profileId: null, profileName: null, availableIds: BUILTIN_IDS });
    expect(s.document).toEqual({ ...builtinReportTemplate('page:alarms'), columns: builtinAlarmColumns('block', [both, lowOff]) });
    expect(s.columnStyles).toEqual(columnWidths('block', hiddenLimitColumns([both, lowOff])));
    expect(s.notes).toEqual([{ text: truncationNote(2, 9), before: true, style: 'title' }]);
    expect(s.rows).toEqual(rowsForAlarmReport([both, lowOff], fmt, texts));
  });

  it('the built-in over an empty period: today\'s width-matched row, the description saying so', () => {
    const [s] = alarmReportInput({ ...base, template: null, rows: [], total: 0, level: 'area' }).sections;
    const shown = s.document.columns.filter((c) => c.show).map((c) => c.id);
    expect(s.rows).toEqual([Object.fromEntries(shown.map((id) => [id, id === 'alarm.description' ? NO_ALARMS_IN_PERIOD : '-']))]);
    expect(s.notes ?? []).toEqual([]);
  });

  it('a SAVED template: its own document, no widths, no level rule, no empty-period row', () => {
    const document: ReportTemplateDocument = {
      ...builtinReportTemplate('page:alarms'),
      columns: [
        { id: 'instrument.code', heading: 'Instrument', show: true },
        { id: 'alarm.high', heading: 'High', show: true },
      ],
    };
    const template = { id: 't1', name: 'Short', kind: 'page:alarms', profileId: null, isDefault: true, document } as unknown as ReportTemplateRow;
    const [s] = alarmReportInput({ ...base, template, rows: [allOff], total: 1, level: 'instrument' }).sections;
    expect(s.document).toEqual(document);
    expect(s.columnStyles).toBeUndefined();
    expect(s.rows).toEqual(rowsForAlarmReport([allOff], fmt, texts));
    expect(alarmReportInput({ ...base, template, rows: [], total: 0, level: 'instrument' }).sections[0].rows).toEqual([]);
  });

  it('a stored document that does not parse prints the built-in, never half of each', () => {
    const template = { id: 't2', name: 'Broken', kind: 'page:alarms', profileId: null, isDefault: true, document: { version: 99 } } as unknown as ReportTemplateRow;
    const [s] = alarmReportInput({ ...base, template, rows: [both], total: 1, level: 'all' }).sections;
    expect(s.document).toEqual(builtinReportTemplate('page:alarms'));
  });
});
