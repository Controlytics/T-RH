import { describe, it, expect } from 'vitest';
import {
  DATA_REPORT_TITLE, DATA_REPORT_HEAD, DATA_REPORT_LEGEND_BASE, DATA_REPORT_NO_DATA,
  dataReportLegend, dataReportParameterRows, dataReportRows, dataReportCell, dataReportIntervalText,
  scheduleRows, emptyDataReportRow, dataReportColumnStyles, resolveBlockArea, limitText,
} from '../data-report';

/** The administered fault words, as the page would hand them over. */
const words = { failure: 'Error', outOfRange: 'OL' };

/**
 * The DATA REPORT, against the operator's supplied `Data Report.pdf`.
 *
 * The reference's own text, transcribed: `Block : CWH Block` against `Start
 * Date : 27-05-2026`, `Area : QC 3(AHU-033)` against `Start Time : 16:36`,
 * `Location : LCMS Room-II` against `End Date : 28-05-2026`, `Inst ID :
 * CWH/RDU/002-01` against `End Time : 16:36`, `Temp. Limit : NMT 27` against
 * `RH Limit : NMT 70`, `Temp. Max : 22.9 , Temp. Min : 21.2` against `RH Max :
 * 63.0 , RH Min : 58.0`, `Interval : 1 hour`; a table headed DATE, TIME,
 * TEMPERATURE (°C), RELATIVE HUMIDITY(%) with rows like `27-05-2026 | 16:36 |
 * 21.8 | 59`; and a legend of Temp, RH and NMT.
 *
 * These pin the SHAPE. Dates are administered, so the formatters here are
 * stand-ins; the reference's `NMT 27` prints `NMT 27.0` at one decimal, which
 * is the instrument's own precision and the way every screen prints it.
 */

const fmt = {
  formatDate: (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  },
  formatTime: (iso: string) => iso.slice(11, 16),
};

const scope = {
  blockName: 'CWH Block', areaName: 'QC 3(AHU-033)', locationName: 'LCMS Room-II', instrumentLabel: 'CWH/RDU/002-01',
};
const period = { from: '2026-05-27T16:36:00.000Z', to: '2026-05-28T16:36:00.000Z' };
/** The reference instrument: NMT 27 / NMT 70, one decimal on temperature. */
const temp = { min: null, max: 27, decimals: 1, periodMax: 22.9, periodMin: 21.2 };
const rh = { min: null, max: 70, decimals: 0, periodMax: 63, periodMin: 58 };

describe('the reference layout', () => {
  it('carries the reference title and its four columns, in order', () => {
    expect(DATA_REPORT_TITLE).toBe('Temperature and RH Data Report');
    expect(DATA_REPORT_HEAD).toEqual(['DATE', 'TIME', 'TEMPERATURE (°C)', 'RELATIVE HUMIDITY(%)']);
  });

  it('lays the parameter block out in the reference’s order and pairing', () => {
    const rows = dataReportParameterRows({ scope, period, temp, rh, intervalMs: 3_600_000, fmt });
    expect(rows).toEqual([
      ['Block :', 'CWH Block', 'Start Date :', '27-05-2026'],
      ['Area :', 'QC 3(AHU-033)', 'Start Time :', '16:36'],
      ['Location :', 'LCMS Room-II', 'End Date :', '28-05-2026'],
      ['Inst ID :', 'CWH/RDU/002-01', 'End Time :', '16:36'],
      ['Temp. Limit :', 'NMT 27.0', 'RH Limit :', 'NMT 70'],
      // A DELIBERATE departure from the reference, which prints "Temp. Max :
      // 22.9 , Temp. Min : 21.2" against NMT-only limits: since 2026-09-07 an
      // extreme prints only for a bound in force (operator), so NMT-only
      // instruments print Max alone.
      ['Temp. Max :', '22.9', 'RH Max :', '63'],
      // The reference prints Interval on the RIGHT with the left half blank.
      // Since 2026-09-07 no cell of this block is ever empty (operator: "if
      // value was not there dont show that boxes", then "table was not forming
      // properly" when empty cells were unboxed), so Interval takes the row.
      ['Interval :', { content: '1 hour', colSpan: 3 }],
    ]);
  });

  // Operator, 2026-10-03: "isMktCalculationEnabled is true then in data report
  // mkt value should come, if false then mkt value should not come". The server
  // sends `mkt` only when the flag is on; the report prints the row iff it is a
  // number, at the temperature precision, beside the interval — no empty cell.
  it('prints MKT beside the interval when the server sent one, and keys the legend', () => {
    const rows = dataReportParameterRows({
      scope, period, temp: { ...temp, periodMkt: 23.456 }, rh, intervalMs: 3_600_000, fmt,
    });
    expect(rows[6]).toEqual(['Interval :', '1 hour', 'MKT :', '23.5']);
    expect(dataReportLegend([], false, true)).toContainEqual({ abbr: 'MKT', meaning: 'Mean Kinetic Temperature' });
  });

  it('prints no MKT cell when the server sent none — the interval takes the row as before', () => {
    const rows = dataReportParameterRows({ scope, period, temp: { ...temp, periodMkt: null }, rh, intervalMs: 3_600_000, fmt });
    expect(rows[6]).toEqual(['Interval :', { content: '1 hour', colSpan: 3 }]);
    expect(dataReportLegend([], false, false).map((l) => l.abbr)).not.toContain('MKT');
  });

  it('prints the limits in this system’s own words', () => {
    expect(limitText({ min: null, max: 27, decimals: 1 })).toBe('NMT 27.0');
    expect(limitText({ min: 18, max: null, decimals: 1 })).toBe('NLT 18.0');
    expect(limitText({ min: 18, max: 27, decimals: 1 })).toBe('18.0 - 27.0');
  });

  // Operator, 2026-10-03: "text is included in limits and ranges show that
  // text in reports and show max and min values". The attribute's own text
  // prints in the limit cell; the extremes still print, judged on the NUMBER.
  it('prints a limit\'s own text in the limit cell and keeps the extremes', () => {
    expect(limitText({ min: null, max: 60, decimals: 0, maxText: '60 (For Reference)' }))
      .toBe('NMT 60 (For Reference)');
    const rows = dataReportParameterRows({
      scope, period, intervalMs: null, fmt,
      temp: { ...temp, min: 18, max: 27, maxText: '27 (For Reference)' },
      rh: { ...rh, max: 60, maxText: '60 (For Reference)' },
    });
    expect(rows[4]).toEqual(['Temp. Limit :', '18.0 - 27 (For Reference)', 'RH Limit :', 'NMT 60 (For Reference)']);
    expect(rows[5]).toEqual(['Temp. Max :', '22.9 , Temp. Min : 21.2', 'RH Max :', '63']);
  });

  it('prints a dash, never an empty cell, for a field nobody could fill', () => {
    const rows = dataReportParameterRows({
      scope: { blockName: '', areaName: '  ', locationName: '', instrumentLabel: 'X' },
      period,
      // Both bounds in force, no numeric reading in the period.
      temp: { min: 18, max: 27, decimals: 1, periodMax: null, periodMin: null },
      rh: { min: 30, max: 70, decimals: 0, periodMax: null, periodMin: null },
      intervalMs: null, fmt,
    });
    expect(rows[0][1]).toBe('-');
    expect(rows[1][1]).toBe('-');
    expect(rows[2][1]).toBe('-');
    expect(rows[5]).toEqual(['Temp. Max :', '- , Temp. Min : -', 'RH Max :', '- , RH Min : -']);
    expect(rows[6]).toEqual(['Interval :', { content: 'Raw (every reading)', colSpan: 3 }]);
  });
});

describe('an extreme prints only for a bound that is IN FORCE (2026-09-07)', () => {
  // Operator: "if Enable_Humid_NLT is disabled then dont show RH min in
  // report, if nmt is disabled then dont show max in report same like that
  // in all data reports". The server already withholds a disabled bound
  // (`limits.rhMin` is null when Enable_Humid_NLT is off), and this row
  // follows the bound: a minimum nobody judges is not reported. Never
  // administered reads the same as switched off, because `limits` is the one
  // fact this module sees — `limitEnabled` says WHY and never gates display.
  const base = { scope, period, intervalMs: null, fmt };

  it('drops RH Min when the RH low bound is not in force', () => {
    const rows = dataReportParameterRows({ ...base, temp: { ...temp, min: 18 }, rh: { ...rh, min: null, periodMin: 58 } });
    expect(rows[5].slice(2)).toEqual(['RH Max :', '63']);
    // The temperature side, given both bounds in force, is untouched.
    expect(rows[5].slice(0, 2)).toEqual(['Temp. Max :', '22.9 , Temp. Min : 21.2']);
  });

  it('drops RH Max — and the label moves to Min — when the RH high bound is not in force', () => {
    const rows = dataReportParameterRows({ ...base, temp, rh: { ...rh, max: null, min: 30 } });
    expect(rows[5].slice(2)).toEqual(['RH Min :', '58']);
  });

  it('gives the remaining pair the WHOLE row when the other slot has no bound in force — never an empty cell', () => {
    // Unboxing the empty cells left the block with open corners ("table was
    // not forming properly"); a span keeps it a rectangle.
    const rows = dataReportParameterRows({ ...base, temp: { ...temp, min: 18 }, rh: { ...rh, min: null, max: null } });
    expect(rows[5]).toEqual(['Temp. Max :', { content: '22.9 , Temp. Min : 21.2', colSpan: 3 }]);
    const rhOnly = dataReportParameterRows({ ...base, rh, temp: { ...temp, min: null, max: null } });
    expect(rhOnly[5]).toEqual(['RH Max :', { content: '63', colSpan: 3 }]);
  });

  it('omits the row altogether when neither slot has a bound in force', () => {
    const rows = dataReportParameterRows({ ...base, rh: { ...rh, min: null, max: null }, temp: { ...temp, min: null, max: null } });
    expect(rows).toHaveLength(6);
    expect(rows[5][0]).toBe('Interval :');
  });

  it('applies the same rule to temperature', () => {
    const rows = dataReportParameterRows({ ...base, rh, temp: { ...temp, max: null, min: 18 } });
    expect(rows[5].slice(0, 2)).toEqual(['Temp. Min :', '21.2']);
  });

  it('the reference instrument (NMT only, both slots) prints Max alone', () => {
    // `temp` and `rh` above ARE the reference: NMT 27 / NMT 70, no low bound.
    const rows = dataReportParameterRows({ ...base, temp, rh });
    expect(rows[5]).toEqual(['Temp. Max :', '22.9', 'RH Max :', '63']);
  });
});

describe('legend', () => {
  it('carries the reference’s two abbreviations verbatim', () => {
    expect(DATA_REPORT_LEGEND_BASE).toEqual([
      { abbr: 'Temp', meaning: 'Temperature' },
      { abbr: 'RH', meaning: 'Relative Humidity' },
    ]);
  });

  it('adds NMT only when a printed limit uses it, and NLT likewise', () => {
    expect(dataReportLegend(['NMT 27.0', 'NMT 70'])).toEqual([
      ...DATA_REPORT_LEGEND_BASE, { abbr: 'NMT', meaning: 'Not More Than' },
    ]);
    expect(dataReportLegend(['NLT 18.0', 'NA'])).toEqual([
      ...DATA_REPORT_LEGEND_BASE, { abbr: 'NLT', meaning: 'Not Less Than' },
    ]);
    expect(dataReportLegend(['18.0 - 27.0'])).toEqual(DATA_REPORT_LEGEND_BASE);
  });

  it('keys NA only when a cell printed it', () => {
    expect(dataReportLegend([], true)).toEqual([...DATA_REPORT_LEGEND_BASE, { abbr: 'NA', meaning: 'No data' }]);
    expect(dataReportLegend([], false)).toEqual(DATA_REPORT_LEGEND_BASE);
  });
});

/** Bounds for the cell tests: spec 18–27 °C inside a 0–50 °C probe span. */
const tempBounds = { min: 18, max: 27, decimals: 1, rangeLow: 0, rangeHigh: 50 };

describe('a row', () => {
  const slot = (row: any) => ({ ts: row.ts, row });

  it('reproduces the reference’s first row', () => {
    const body = dataReportRows(
      [slot({ ts: '2026-05-27T16:36:00.000Z', values: { temperature: 21.8, humidity: 59 } })],
      { temp: 'temperature', rh: 'humidity' }, { temp, rh }, fmt, words,
    );
    expect(body.cells).toEqual([['27-05-2026', '16:36', '21.8', '59']]);
    expect(body.bold).toEqual([[false, false, false, false]]);
    expect(body.printedNoData).toBe(false);
  });

  it('prints NA for a missing reading, for a slot the instrument does not report, and for an empty interval', () => {
    const body = dataReportRows(
      [
        slot({ ts: '2026-05-27T16:36:00.000Z', values: { temperature: null } }),
        { ts: '2026-05-27T17:36:00.000Z', row: null },
      ],
      { temp: 'temperature', rh: null }, { temp, rh }, fmt, words,
    );
    expect(body.cells).toEqual([
      ['27-05-2026', '16:36', 'NA', 'NA'],
      ['27-05-2026', '17:36', 'NA', 'NA'],
    ]);
    expect(body.printedNoData).toBe(true);
    expect(DATA_REPORT_NO_DATA).toBe('NA');
  });

  it('prints a reading that crossed its limit BOLD, and one inside it regular', () => {
    expect(dataReportCell({ ts: 't', values: { k: 27.1 } }, 'k', tempBounds, words)).toEqual({ text: '27.1', bold: true });
    expect(dataReportCell({ ts: 't', values: { k: 17.9 } }, 'k', tempBounds, words)).toEqual({ text: '17.9', bold: true });
    expect(dataReportCell({ ts: 't', values: { k: 27.0 } }, 'k', tempBounds, words)).toEqual({ text: '27.0', bold: false });
    expect(dataReportCell({ ts: 't', values: { k: 22.4 } }, 'k', tempBounds, words)).toEqual({ text: '22.4', bold: false });
  });

  it('prints the administered fault words BOLD — range before failure, as on screen', () => {
    // Outside the probe's span: OL, even though 60 is "a number".
    expect(dataReportCell({ ts: 't', values: { k: 60 } }, 'k', tempBounds, words)).toEqual({ text: 'OL', bold: true });
    // A non-numeric reading: Error.
    expect(dataReportCell({ ts: 't', values: { k: null }, errors: { k: true } }, 'k', tempBounds, words))
      .toEqual({ text: 'Error', bold: true });
    // The words are the caller's, never literals here.
    expect(dataReportCell({ ts: 't', values: { k: 60 } }, 'k', tempBounds, { failure: 'F', outOfRange: 'R' }).text).toBe('R');
    // NA is an absence, not a finding — regular.
    expect(dataReportCell(null, 'k', tempBounds, words)).toEqual({ text: 'NA', bold: false });
  });

  it('never marks a NULL bound as crossed', () => {
    expect(dataReportCell({ ts: 't', values: { k: 99 } }, 'k', { min: null, max: null, decimals: 0 }, words))
      .toEqual({ text: '99', bold: false });
  });

  it('says so when the period is empty, width-matched to the head', () => {
    expect(emptyDataReportRow()).toHaveLength(DATA_REPORT_HEAD.length);
    expect(emptyDataReportRow()[2]).toMatch(/No readings/);
  });

  it('centres every column', () => {
    const styles = dataReportColumnStyles();
    for (let i = 0; i < DATA_REPORT_HEAD.length; i++) expect(styles[i].halign).toBe('center');
  });
});

describe('firstPerInterval', () => {
  const rows = [
    { ts: '2026-05-27T17:36:10.000Z' },
    { ts: '2026-05-27T16:36:00.000Z' },
    { ts: '2026-05-27T16:37:00.000Z' },
    { ts: '2026-05-27T16:59:59.000Z' },
    { ts: '2026-05-27T18:40:00.000Z' },
  ];

  /** The period the fixture sits in: 16:00 to 20:00. */
  const END = '2026-05-27T20:00:00.000Z';

  it('anchors the schedule on the FIRST reading, one slot per interval to the period end, newest first', () => {
    // First reading 16:36, hourly, end 20:00 → slots 16:36, 17:36, 18:36, 19:36
    // (20:36 is past the end). [16:36,17:36) → 16:36:00 (the 16:37 and 16:59
    // readings share it and are not printed — that is the whole point of an
    // interval); [17:36,18:36) → 17:36:10; [18:36,19:36) → 18:40; [19:36,20:36)
    // → nothing received: NA at the slot's own time.
    const out = scheduleRows(rows, 3_600_000, END);
    expect(out.map((s) => [s.ts, s.row?.ts ?? null])).toEqual([
      ['2026-05-27T19:36:00.000Z', null],
      ['2026-05-27T18:40:00.000Z', '2026-05-27T18:40:00.000Z'],
      ['2026-05-27T17:36:10.000Z', '2026-05-27T17:36:10.000Z'],
      ['2026-05-27T16:36:00.000Z', '2026-05-27T16:36:00.000Z'],
    ]);
  });

  it('never invents a value — every filled slot IS an input row', () => {
    for (const s of scheduleRows(rows, 3_600_000, END)) if (s.row) expect(rows).toContain(s.row);
  });

  it('returns every row, NEWEST first, at Raw', () => {
    const out = scheduleRows(rows, null, END);
    expect(out.map((s) => s.ts)).toEqual([...rows].map((r) => r.ts).sort().reverse());
    expect(out.every((s) => s.row !== null)).toBe(true);
  });

  it('is anchored on the first reading, not on the period start or the wall clock', () => {
    // Readings at 16:59 and 17:01: on the wall clock they are in different
    // hours; anchored on 16:59 they share the first slot.
    const out = scheduleRows(
      [{ ts: '2026-05-27T16:59:00.000Z' }, { ts: '2026-05-27T17:01:00.000Z' }],
      3_600_000, '2026-05-27T17:30:00.000Z',
    );
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe('2026-05-27T16:59:00.000Z');
  });

  it('prints a slot for a silent stretch — a gap in a log is information', () => {
    // One reading at 16:00, 5-minute slots to 16:20: 16:00 (reading) then
    // 16:05, 16:10, 16:15, 16:20 all NA.
    const out = scheduleRows([{ ts: '2026-05-27T16:00:00.000Z' }], 300_000, '2026-05-27T16:20:00.000Z');
    expect(out.map((s) => s.ts.slice(11, 16))).toEqual(['16:20', '16:15', '16:10', '16:05', '16:00']);
    expect(out.map((s) => s.row === null)).toEqual([true, true, true, true, false]);
  });

  it('keeps a reading past the period end rather than dropping it', () => {
    const out = scheduleRows(
      [{ ts: '2026-05-27T16:00:00.000Z' }, { ts: '2026-05-27T18:30:00.000Z' }],
      3_600_000, '2026-05-27T17:00:00.000Z',
    );
    // 16:00, 17:00 scheduled; 18:00 holds the stray reading.
    expect(out.map((s) => [s.ts.slice(11, 16), s.row !== null])).toEqual([['18:30', true], ['17:00', false], ['16:00', true]]);
  });

  it('is empty for an empty period', () => {
    expect(scheduleRows([], 3_600_000, END)).toEqual([]);
    expect(scheduleRows([], null, END)).toEqual([]);
  });
});

describe('dataReportIntervalText', () => {
  it('uses the selector’s own words', () => {
    expect(dataReportIntervalText(3_600_000)).toBe('1 hour');
    expect(dataReportIntervalText(300_000)).toBe('5 minutes');
    expect(dataReportIntervalText(null)).toBe('Raw (every reading)');
  });
});

describe('resolveBlockArea', () => {
  const tree = [
    { id: 'b1', name: 'CWH Block', children: [{ id: 'a1', name: 'QC 3(AHU-033)' }, { id: 'a2', name: 'Stability' }] },
    { id: 'b2', name: 'Other Block', children: [{ id: 'a3', name: 'QC 3(AHU-033)' }] },
  ];

  it('names the Block and Area an instrument’s Area sits in, by ID', () => {
    expect(resolveBlockArea(tree, 'a3')).toEqual({ blockName: 'Other Block', areaName: 'QC 3(AHU-033)' });
  });

  it('names the Block alone for an instrument placed directly on one', () => {
    expect(resolveBlockArea(tree, 'b1')).toEqual({ blockName: 'CWH Block', areaName: '' });
  });

  it('is blank for an unplaced instrument or an unknown id', () => {
    expect(resolveBlockArea(tree, null)).toEqual({ blockName: '', areaName: '' });
    expect(resolveBlockArea(tree, 'nope')).toEqual({ blockName: '', areaName: '' });
  });
});
