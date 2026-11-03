import { describe, it, expect } from 'vitest';
import {
  dataReportRows, emptyDataReportRow, limitText, dataReportIntervalText,
} from '../data-report';
import {
  rowsForDataReport, rowsForInstrumentAlarms, dataReportPlaceholderValues,
  instrumentPlaceholderValues, trendPlaceholderValues, capNotice, MAX_REPORT_ROWS,
} from '../page-report-rows';
import {
  dataA, dataB, dataCapped, fmt, formatDateTime, period, trendHeader, alarmRows, statusTexts, inactivityTexts,
} from './fixtures/page-report-inputs';
import instrumentAlarmsFixture from './fixtures/page-report-builtin-instrument-alarms.json';

/**
 * The PURE half of the instrument page reports on templates (2026-11-03): what
 * each page hands the templated builder — its rows keyed by the kind's field
 * ids, the bold grid, the cap, and the placeholder values. Every cell is the
 * page's OWN string (`dataReportRows`, the alarm-display helpers), so a
 * template prints exactly what the page printed.
 */

const DATA_IDS = ['record.date', 'record.time', 'record.temperature', 'record.humidity'] as const;
const ALARM_IDS = ['alarm.type', 'alarm.raisedAt', 'alarm.value', 'alarm.limit', 'alarm.clearedAt', 'alarm.status'] as const;

describe('rowsForDataReport', () => {
  it('keys the rows by the four Data Report fields, with dataReportRows\' own cells and bold grid', () => {
    const body = dataReportRows(dataA.rows, { temp: 't', rh: 'h' }, { temp: dataA.temp, rh: dataA.rh }, fmt, dataA.words);
    const r = rowsForDataReport(dataA);
    expect(r.rows.map((row) => DATA_IDS.map((id) => row[id]))).toEqual(body.cells);
    expect(r.bold).toEqual(body.bold);
    // The breach (26.9 > 25), the failure word and the out-of-range word are bold; NA is not.
    expect(r.bold[0][2]).toBe(true);
    expect(r.bold[2][2]).toBe(true);
    expect(r.bold[3][3]).toBe(true);
    expect(r.bold[1]).toEqual([false, false, false, false]);
    expect(r).toMatchObject({ capped: false, total: 5, shownCount: 5, printedNoData: true });
  });

  it('gives ONE row for an empty period — today\'s empty row — and no bold grid', () => {
    const r = rowsForDataReport(dataB);
    expect(r.rows).toHaveLength(1);
    expect(DATA_IDS.map((id) => r.rows[0][id])).toEqual(emptyDataReportRow());
    expect(r.bold).toEqual([]);
    expect(r).toMatchObject({ capped: false, total: 0, shownCount: 0, printedNoData: false });
  });

  it('caps at 2,000 rows, keeps the first, and says how many of how many', () => {
    const r = rowsForDataReport(dataCapped());
    expect(MAX_REPORT_ROWS).toBe(2000);
    expect(r.rows).toHaveLength(2000);
    expect(r.bold).toHaveLength(2000);
    expect(r).toMatchObject({ capped: true, total: 2001, shownCount: 2000 });
    expect(capNotice(r, period)).toBe(
      'Truncated: showing the first 2,000 of 2,001 rows for Last hour. Narrow the period for a complete report.',
    );
    expect(capNotice(rowsForDataReport(dataA), period)).toBeNull();
  });
});

describe('dataReportPlaceholderValues', () => {
  it('names the instrument, the period, the limits, the extremes, the interval and the MKT as the parameter block prints them', () => {
    const v = dataReportPlaceholderValues(dataA);
    expect(v).toEqual({
      block: 'CWH Block',
      // A blank field is the header's dash, never an empty value (which a template would print as an em dash).
      area: '-',
      location: 'LCMS Room-I',
      instrument: 'CWH/RDU/001-00',
      fromDate: '2026-08-24', fromTime: '00:00', toDate: '2026-08-24', toTime: '01:00',
      from: formatDateTime(period.from), to: formatDateTime(period.to), period: 'Last hour',
      tempLimit: limitText(dataA.temp),
      rhLimit: limitText(dataA.rh),
      extremes: 'Temp. Max : 26.9 , Temp. Min : 21.2 · RH Max : 63',
      interval: dataReportIntervalText(900_000),
      mkt: '22.3',
    });
    expect(v.interval).toBe('15 minutes');
  });

  it('leaves MKT out when the server sent none, and a lone extreme is the one printed', () => {
    const v = dataReportPlaceholderValues(dataB);
    expect(v).not.toHaveProperty('mkt');
    expect(v.extremes).toBe('Temp. Min : -');
    expect(v.tempLimit).toBe(limitText(dataB.temp));
  });

  it('leaves the extremes out when no bound is in force on either slot', () => {
    const none = { ...dataB, temp: { ...dataB.temp, min: null } };
    expect(dataReportPlaceholderValues(none)).not.toHaveProperty('extremes');
  });
});

describe('rowsForInstrumentAlarms', () => {
  it('keys the six cells by the Instrument Alarms fields, exactly as today\'s report printed them', () => {
    const r = rowsForInstrumentAlarms(alarmRows, formatDateTime, statusTexts, inactivityTexts);
    const printed = (instrumentAlarmsFixture.sections[1] as { body: string[][] }).body;
    expect(r.rows.map((row) => ALARM_IDS.map((id) => row[id]))).toEqual(printed);
    expect(r).toMatchObject({ capped: false, total: 3, shownCount: 3 });
  });

  it('prints the ADMINISTERED inactivity wording — the bag is threaded through', () => {
    const r = rowsForInstrumentAlarms(alarmRows, formatDateTime, statusTexts, inactivityTexts);
    expect(r.rows[2]['alarm.value']).toBe('No signal');
    expect(r.rows[2]['alarm.limit']).toBe('silent > 15m');
  });
});

describe('instrumentPlaceholderValues / trendPlaceholderValues', () => {
  it('names the instrument header\'s eight fields, a blank one as a dash, and the period', () => {
    expect(instrumentPlaceholderValues(trendHeader.scope, period, fmt, formatDateTime)).toEqual({
      block: 'CWH Block', area: 'QC 3', location: '-', instrument: 'CWH/RDU/046-00',
      fromDate: '2026-08-24', fromTime: '00:00', toDate: '2026-08-24', toTime: '01:00',
      from: formatDateTime(period.from), to: formatDateTime(period.to), period: 'Last hour',
    });
  });

  it('the trend adds its series — the slot label', () => {
    const v = trendPlaceholderValues(trendHeader.scope, period, fmt, formatDateTime, 'Humidity');
    expect(v.series).toBe('Humidity');
    expect(v.instrument).toBe('CWH/RDU/046-00');
  });
});
