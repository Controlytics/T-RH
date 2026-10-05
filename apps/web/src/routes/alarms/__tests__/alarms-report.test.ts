import { describe, it, expect } from 'vitest';
import {
  ALARM_REPORT_HEAD, ALARM_REPORT_LEGEND, NOT_APPLICABLE, BOUND_NOT_SHOWN, EXTRA_COLUMNS,
  periodPairs, uomFor, setPoints, reportRows, truncationNote, reportSeedPeriod,
  reportLevel, reportHead, columnWidths, scopeTableRows,
  scopeColumnStyles, CONTENT_WIDTH_MM, buildAlarmsReport, hiddenLimitColumns,
} from '../alarms-report';
import type { AlarmRow } from '../alarm-display';

/**
 * The ALARM REPORT, against the operator's supplied `Alarm Report.pdf`.
 *
 * The reference's own text, transcribed: a Block / Area / Location / Inst ID
 * block paired against Start Date / Start Time / End Date / End Time; a table
 * headed DATE, TIME, DESCRIPTION, UOM, PV VALUE, HIGH SET POINT VALUE, LOW SET
 * POINT VALUE; a legend of "PV Value : Present Value" and "UOM : Units of
 * Measurement"; and rows like `28-05-2026 | 12:02 | High Temperature | °C | 27.4
 * | 27 | N/A`.
 *
 * These pin the SHAPE, because the shape is what was asked for. The formatting of
 * dates is deliberately NOT the reference's — this app's dates are administered.
 */

const fmt = {
  formatDate: (iso: string) => iso.slice(0, 10),
  formatTime: (iso: string) => iso.slice(11, 16),
};

const alarm = (over: Partial<AlarmRow> = {}): AlarmRow => ({
  id: 'a1',
  instrumentCode: 'CWH/RDU/046-00',
  instrumentId: 'i1',
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
  ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1 },
  ...over,
});

describe('the reference layout', () => {
  it('heads the table with the reference’s seven columns, in order', () => {
    // Renamed from HIGH/LOW SET POINT VALUE on 2026-09-01 (operator) — shorter,
    // and "limit" is this system's own word for the bound everywhere else.
    expect(ALARM_REPORT_HEAD).toEqual([
      'DATE', 'TIME', 'DESCRIPTION', 'UOM', 'PV VALUE', 'HIGH LIMIT', 'LOW LIMIT',
    ]);
  });

  it('carries the reference’s legend verbatim', () => {
    // It is printed above the Printed By stamp by `createReport`, which already
    // takes a legend — the reference's end block and this app's are the same
    // shape, which is why `pdf-report.ts` needed no change.
    expect(ALARM_REPORT_LEGEND).toEqual([
      { abbr: 'PV Value', meaning: 'Present Value' },
      { abbr: 'UOM', meaning: 'Units of Measurement' },
    ]);
  });

  it('prints the PERIOD only — start on one row, end on the next (operator, 2026-10-05)', () => {
    // "in all alarms report dont show block,area,location and instrument id in
    // header, only show start date,start time,end date and end time". The scope
    // is stated by the table's own columns when it varies (see `reportHead`).
    const pairs = periodPairs({ from: '2026-05-27T16:00:00.000Z', to: '2026-05-28T16:00:00.000Z' }, fmt);
    expect(pairs.map(([k]) => k)).toEqual(['Start Date', 'Start Time', 'End Date', 'End Time']);
    expect(pairs.map(([, v]) => v)).toEqual(['2026-05-27', '16:00', '2026-05-28', '16:00']);
    for (const [k] of pairs) expect(['Block', 'Area', 'Location', 'Inst ID']).not.toContain(k);
  });
});

describe('a row', () => {
  it('reproduces the reference’s High Temperature row', () => {
    // `28-05-2026 | 12:02 | High Temperature | °C | 27.4 | 27 | N/A`
    const [row] = reportRows([alarm()], fmt);
    expect(row).toEqual(['2026-05-28', '12:02', 'High Temperature', '°C', '27.4', '27.0', 'N/A']);
  });

  it('reproduces the reference’s RH High row, with %RH', () => {
    const [row] = reportRows([alarm({
      metric: 'HUMIDITY', triggeredValue: 72,
      ruleSnapshot: { limit: 70, limitKind: 'HIGH', decimals: 0 },
    })], fmt);
    expect(row[3]).toBe('%RH');
    expect(row[4]).toBe('72');
    expect(row[5]).toBe('70');
    expect(row[6]).toBe(NOT_APPLICABLE);
  });

  it('puts a LOW breach in the low column and N/A in the high', () => {
    const { high, low } = setPoints(alarm({
      limitKind: 'LOW', ruleSnapshot: { limit: 18, limitKind: 'LOW', decimals: 1 },
    }));
    expect(low).toBe('18.0');
    expect(high).toBe(NOT_APPLICABLE);
  });

  it("prints BOTH bounds — the instrument's High and Low limits", () => {
    /**
     * Operator, 2026-09-01: *"High Set Point Value and Low Set Point values are
     * High Temperature/Humidity Limit, Low Temperature/Humidity Limit"*. Both
     * columns name the instrument's pair, not just the one that fired.
     *
     * The pair is FROZEN at raise time (`limitSnapshot`), never read live: a June
     * excursion printed today must show June's limits.
     */
    const { high, low } = setPoints(alarm({
      limitKind: 'HIGH',
      ruleSnapshot: { limit: 27, limitKind: 'HIGH', thresholdHigh: 27, thresholdLow: 18, decimals: 1 },
    }));
    expect(high).toBe('27.0');
    expect(low).toBe('18.0');
  });

  it('shows N/A for a null bound with NO enable flag beside it', () => {
    // The worker freezes null both for a disabled bound and for one nobody
    // administered. With no flag to tell them apart, N/A — which claims nothing.
    // The flagged case is covered in "NMT/NLT decide whether a bound is PRINTED".
    const { high, low } = setPoints(alarm({
      ruleSnapshot: { limit: 27, limitKind: 'HIGH', thresholdHigh: 27, thresholdLow: null, decimals: 1 },
    }));
    expect(high).toBe('27.0');
    expect(low).toBe(NOT_APPLICABLE);
  });

  it('falls back to the breached bound alone on a row raised before the pair was frozen', () => {
    // Historical alarms. The counterpart is genuinely unknown AS IT STOOD, and
    // N/A says so rather than borrowing today's value.
    const { high, low } = setPoints(alarm({
      ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1 },
    }));
    expect(high).toBe('27.0');
    expect(low).toBe(NOT_APPLICABLE);
  });

  it('says N/A in BOTH for a source that fired against no bound', () => {
    // An inactivity alarm is raised by the ABSENCE of a reading; there is no set
    // point it crossed, and printing one would invent a threshold.
    const { high, low } = setPoints(alarm({
      source: 'INACTIVITY', metric: 'OFFLINE', limitKind: null,
      ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 15 },
    }));
    expect(high).toBe(NOT_APPLICABLE);
    expect(low).toBe(NOT_APPLICABLE);
  });

  it('takes the set point from the FROZEN snapshot, not from live config', () => {
    // A §11 record reads back against the bound it actually fired on. The
    // administered limit may well have changed since.
    expect(setPoints(alarm({ ruleSnapshot: { limit: 25, limitKind: 'HIGH', decimals: 1 } })).high)
      .toBe('25.0');
  });

  it('has no unit for a metric that is not a measurement', () => {
    expect(uomFor(alarm({ metric: 'OFFLINE' }))).toBe('-');
  });

  // Operator, 2026-10-03: "text is included in limits … show that text in
  // reports". The text is FROZEN beside the number; a bare number (null text)
  // prints at the frozen precision as before.
  it('prints a bound\'s FROZEN text in its set-point column', () => {
    const { high, low } = setPoints(alarm({
      limitKind: 'HIGH',
      ruleSnapshot: {
        limit: 60, limitKind: 'HIGH', thresholdHigh: 60, thresholdLow: 30, decimals: 0,
        thresholdHighText: '60 (For Reference)', thresholdLowText: null,
      },
    }));
    expect(high).toBe('60 (For Reference)');
    expect(low).toBe('30');
  });

  it('a row raised before the pair was frozen still prints the breached bound\'s text', () => {
    expect(setPoints(alarm({
      ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1, thresholdHighText: '27 (For Reference)' },
    })).high).toBe('27 (For Reference)');
  });
});

describe('truncationNote', () => {
  it('is silent when the report covers everything', () => {
    expect(truncationNote(120, 120)).toBeNull();
    expect(truncationNote(5000, 4000)).toBeNull();
  });

  it('states the shortfall IN THE REPORT when it does not', () => {
    /**
     * The paper is the record, so the disclosure has to be on it — a toast does
     * not survive printing. A signed report silently covering 500 of 3,000 alarms
     * is the defect class this codebase has fixed twice already.
     */
    const note = truncationNote(5000, 12000)!;
    expect(note).toContain('5,000');
    expect(note).toContain('12,000');
    expect(note).toMatch(/narrow/i);
  });
});

describe('reportSeedPeriod', () => {
  const now = new Date('2026-05-28T16:00:00.000Z');

  it('opens on the period the page is already filtered to', () => {
    // The dialog must agree with the table behind it.
    expect(reportSeedPeriod({ from: '2026-05-01T00:00', to: '2026-05-02T00:00' }, now))
      .toMatchObject({ from: '2026-05-01T00:00', to: '2026-05-02T00:00' });
  });

  it('falls back to a BOUNDED period, not to everything', () => {
    // A report with no bounds is not a report of a period, and this one prints
    // its own Start and End on the paper.
    const seeded = reportSeedPeriod({ from: '', to: '' }, now);
    expect(seeded.from).not.toBe('');
    expect(seeded.to).not.toBe('');
    expect(new Date(seeded.to).getTime() - new Date(seeded.from).getTime())
      .toBe(24 * 3_600_000);
  });

  it('keeps one end when only the other is filtered', () => {
    expect(reportSeedPeriod({ from: '2026-05-01T00:00', to: '' }, now).from)
      .toBe('2026-05-01T00:00');
  });
});

describe('the placement columns vary with the SCOPE', () => {
  /**
   * Operator, 2026-09-01: block-wise adds Instrument ID / Area / Location,
   * area-wise adds Instrument ID / Location, and instrument-wise adds nothing
   * because all three are already in the header.
   *
   * One rule produces all three cases: **a column is added exactly when that fact
   * VARIES across the rows.** Narrowed to one instrument, its ID, Area and
   * Location are the same on every row, so a column would repeat one value down
   * the page — wasted width on a report whose width was the complaint.
   */
  it('reads the level off the filters', () => {
    const f = { blockId: '', areaId: '', instrumentId: '' };
    expect(reportLevel({ ...f, instrumentId: 'i1', areaId: 'a1', blockId: 'b1' })).toBe('instrument');
    expect(reportLevel({ ...f, areaId: 'a1', blockId: 'b1' })).toBe('area');
    expect(reportLevel({ ...f, blockId: 'b1' })).toBe('block');
    expect(reportLevel(f)).toBe('all');
  });

  it('adds NOTHING for a single instrument', () => {
    expect(EXTRA_COLUMNS.instrument).toEqual([]);
    expect(reportHead('instrument')).toEqual(ALARM_REPORT_HEAD);
  });

  it('adds Instrument ID and Location for an Area', () => {
    // The Area itself is constant, and is stated once in the header.
    expect(EXTRA_COLUMNS.area).toEqual(['INSTRUMENT ID', 'LOCATION']);
    expect(reportHead('area').slice(0, 2)).toEqual(['INSTRUMENT ID', 'LOCATION']);
    expect(reportHead('area')).not.toContain('AREA');
  });

  it('adds Instrument ID, Area and Location for a Block', () => {
    expect(EXTRA_COLUMNS.block).toEqual(['INSTRUMENT ID', 'AREA', 'LOCATION']);
  });

  it('treats an unfiltered download as block-wise', () => {
    // The Block varies too, but an eleventh column does not fit A4 and the Block
    // is readable from the Area beside it.
    expect(EXTRA_COLUMNS.all).toEqual(EXTRA_COLUMNS.block);
  });

  it('keeps the seven reference columns at every level, in order', () => {
    // The extras are a PREFIX. The reference's own table must survive intact.
    for (const level of ['instrument', 'area', 'block', 'all'] as const) {
      expect(reportHead(level).slice(EXTRA_COLUMNS[level].length)).toEqual(ALARM_REPORT_HEAD);
    }
  });
});

describe('a row matches its head, cell for cell', () => {
  const row = (level: 'instrument' | 'area' | 'block') => reportRows(
    [alarm({ instrumentCode: 'CWH/RDU/046-00', locationName: 'QC 3', locationAttribute: 'GC Room' })],
    fmt, undefined, level,
  )[0];

  it('has exactly as many cells as the head has columns', () => {
    // The failure this catches is silent and total: a body row one cell short
    // shifts every value under the wrong heading, and the report still prints.
    for (const level of ['instrument', 'area', 'block'] as const) {
      expect(row(level)).toHaveLength(reportHead(level).length);
    }
  });

  it('puts the instrument code and Location under their headings for an Area', () => {
    expect(row('area').slice(0, 2)).toEqual(['CWH/RDU/046-00', 'GC Room']);
  });

  it('puts Area between them for a Block', () => {
    expect(row('block').slice(0, 3)).toEqual(['CWH/RDU/046-00', 'QC 3', 'GC Room']);
  });

  it('leads with the DATE when nothing is prefixed', () => {
    expect(row('instrument')[0]).toBe('2026-05-28');
  });

  it('dashes a placement fact the row does not carry', () => {
    const r = reportRows([alarm({ locationAttribute: null, locationName: null })], fmt, undefined, 'block')[0];
    expect(r.slice(1, 3)).toEqual(['-', '-']);
  });
});

describe('columnWidths', () => {
  it('pins the narrow columns at whatever index the level puts them', () => {
    // The extras shift every base column right; widths keyed by a fixed index
    // would cap DESCRIPTION on one level and DATE on another.
    const forBlock = columnWidths('block');
    const dateAt = reportHead('block').indexOf('DATE');
    expect(forBlock[dateAt]).toEqual({ cellWidth: 17 });
    expect(forBlock[reportHead('block').indexOf('DESCRIPTION')]).toBeUndefined();
  });

  it('caps DATE at index 0 when nothing is prefixed', () => {
    expect(columnWidths('instrument')[0]).toEqual({ cellWidth: 17 });
  });
});

describe('NMT/NLT decide whether a bound is PRINTED at all', () => {
  /**
   * Operator, 2026-09-02: *"if temperature and humidity NMT and NLT s are true
   * then show both High and low limits in the alarm report, if any one is
   * disabled then dont show that limits in report"*.
   *
   * NMT is the HIGH bound and NLT the LOW one — the plant's vocabulary, mapped in
   * `ALARM_LIMIT_ENABLE_KEYS_DEFAULT`. On this installation `Enable_Temp_NLT` is
   * off on 95 of 100 instruments and `Enable_Humid_NLT` on 99, so this is the
   * difference between a LOW LIMIT column of numbers and one of noise.
   *
   * **This REVERSES the 2026-09-01 request** for an administered word ("show NA
   * in report … for only disabled limits"). A switched-off bound is now not
   * printed. `NOT_APPLICABLE` survives for the case nobody can answer — see the
   * last two cases, which are the whole difficulty: a disabled bound and a bound
   * nobody ever administered BOTH freeze as a null threshold, which is why
   * `limitSnapshot` freezes `highEnabled`/`lowEnabled` beside them.
   */
  const withFlags = (over: Record<string, unknown>) => alarm({
    ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1, thresholdHigh: 27, ...over },
  });

  it('prints BOTH bounds when NMT and NLT are both on', () => {
    // The first half of the request, and the case the whole feature is for.
    const { high, low } = setPoints(withFlags({
      thresholdLow: 18, highEnabled: true, lowEnabled: true,
    }));
    expect(high).toBe('27.0');
    expect(low).toBe('18.0');
  });

  it('does not print a bound whose NLT is off', () => {
    const { low } = setPoints(withFlags({ thresholdLow: null, lowEnabled: false }));
    expect(low).toBe(BOUND_NOT_SHOWN);
  });

  it('does not print a bound whose NMT is off', () => {
    // Both directions, separately — a mapping swapped between HIGH and LOW
    // silently disables the opposite bound and only one of these would catch it.
    const { high } = setPoints(alarm({
      ruleSnapshot: {
        limit: 18, limitKind: 'LOW', decimals: 1,
        thresholdHigh: null, thresholdLow: 18, highEnabled: false, lowEnabled: true,
      },
    }));
    expect(high).toBe(BOUND_NOT_SHOWN);
  });

  it('still says N/A for a bound that was never administered', () => {
    /**
     * ENABLED, but no limit stored. Not a switched-off bound, and blanking it
     * would state that somebody turned off a bound nobody ever set.
     */
    const { low } = setPoints(withFlags({ thresholdLow: null, lowEnabled: true }));
    expect(low).toBe(NOT_APPLICABLE);
  });

  it('still says N/A on a row raised before the flags were frozen', () => {
    /**
     * Neither flag present — every alarm in the database on 2026-09-02. Nobody
     * knows whether that bound was off, so N/A, which claims nothing. Reading the
     * instrument's CURRENT flag here would decide a June excursion by today's
     * configuration, which is what freezing exists to prevent.
     */
    const { low } = setPoints(alarm({
      ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1 },
    }));
    expect(low).toBe(NOT_APPLICABLE);
  });

  it('never lets a switched-off flag displace a real bound', () => {
    // A number always wins: the flag only ever explains an ABSENCE. A bound
    // switched off AFTER this alarm froze its value still prints that value.
    const { high } = setPoints(withFlags({ highEnabled: false }));
    expect(high).toBe('27.0');
  });

  it('carries the blank through reportRows into the printed cell', () => {
    const [row] = reportRows(
      [withFlags({ thresholdLow: null, lowEnabled: false })],
      fmt, undefined, 'instrument',
    );
    expect(row[reportHead('instrument').indexOf('LOW LIMIT')]).toBe(BOUND_NOT_SHOWN);
  });
});

describe('the parameter block is a TABLE, one line per field', () => {
  /**
   * Operator, 2026-09-01: *"header part like Block, area, start date, etc these
   * all should show in one table, title and value should come in one Line, like
   * Block : CWH Block"*.
   *
   * It was `addKeyValue`, which stacks a grey caption ABOVE its value — two lines
   * per field, unruled.
   */
  const pairs = () => periodPairs({ from: '2026-05-27T16:00:00.000Z', to: '2026-05-28T16:00:00.000Z' }, fmt);

  it('puts label and value in ONE row, four cells wide', () => {
    const rows = scopeTableRows(pairs());
    expect(rows[0]).toEqual(['Start Date :', '2026-05-27', 'Start Time :', '16:00']);
  });

  it('keeps the colon on the LABEL cell', () => {
    // A third column of colons would be ruled like data and would take width from
    // the values on a portrait page.
    expect(scopeTableRows(pairs())[0][0]).toBe('Start Date :');
    expect(scopeTableRows(pairs())[0][1]).not.toContain(':');
  });

  it('folds the four period fields into two rows', () => {
    const rows = scopeTableRows(pairs());
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.length === 4)).toBe(true);
    expect(rows.map((r) => r[0])).toEqual(['Start Date :', 'End Date :']);
  });

  it('PADS an odd trailing field rather than short-rowing it', () => {
    // Autotable stretches a short row's last cell across the missing columns,
    // which silently mis-rules the block.
    const rows = scopeTableRows([['Only', 'one']]);
    expect(rows).toEqual([['Only :', 'one', '', '']]);
  });

  it('pins the label columns so a long Block name cannot eat the row', () => {
    expect(scopeColumnStyles()[0].cellWidth).toBe(26);
    expect(scopeColumnStyles()[2].cellWidth).toBe(26);
  });
});

describe('the Instrument ID column is never broken', () => {
  it("sizes to its content instead of a fixed width", () => {
    /**
     * Operator, 2026-09-01: *"instrument ID name should come fully"*. It was
     * pinned to 26mm and a code like `CWH/RDU/046-00` is wider than that at the
     * raised font size, so it wrapped onto two lines.
     *
     * `'wrap'` is autotable's "size to the widest cell, do not break". A NUMBER
     * cannot express it: any fixed width is a guess about the longest code on an
     * installation whose codes we do not control.
     */
    const styles = columnWidths('block');
    expect(styles[reportHead('block').indexOf('INSTRUMENT ID')]).toEqual({ cellWidth: 'wrap' });
  });

  it('leaves the short fixed columns pinned', () => {
    // The two rules coexist: only the ID is content-sized.
    const styles = columnWidths('block');
    expect(styles[reportHead('block').indexOf('DATE')]).toEqual({ cellWidth: 17 });
  });

  it('adds no ID style at the level that has no ID column', () => {
    const styles = columnWidths('instrument');
    expect(Object.values(styles).some((v) => v.cellWidth === 'wrap')).toBe(false);
  });
});

describe('the parameter block divides down the MIDDLE', () => {
  /**
   * Operator, 2026-09-01: *"Block table central line side is not in center it is
   * on one side"*.
   *
   * Only the two LABEL columns were pinned. autotable then split the remaining
   * width between the two value columns by their CONTENT, so a short Block name
   * against a long date pushed the divider well off centre and the block read as
   * two unequal panes.
   */
  const styles = scopeColumnStyles();

  it('makes the two halves exactly equal', () => {
    const left = styles[0].cellWidth + styles[1].cellWidth;
    const right = styles[2].cellWidth + styles[3].cellWidth;
    expect(left).toBe(right);
  });

  it('puts the divider on the centre line of the content width', () => {
    expect(styles[0].cellWidth + styles[1].cellWidth).toBe(CONTENT_WIDTH_MM / 2);
  });

  it('pins ALL FOUR columns — an unpinned one is what let it drift', () => {
    // The bug was an ABSENT style, so the assertion has to be that none is absent.
    for (const i of [0, 1, 2, 3]) {
      expect(typeof styles[i as 0 | 1 | 2 | 3].cellWidth).toBe('number');
    }
  });

  it('fills the content width exactly, leaving no ragged edge', () => {
    const total = [0, 1, 2, 3].reduce((n, i) => n + styles[i as 0].cellWidth, 0);
    expect(total).toBe(CONTENT_WIDTH_MM);
  });

  it('re-centres for a wider page, since the chrome is shared', () => {
    // The audit and trend reports are landscape.
    const wide = scopeColumnStyles(269);
    expect(wide[0].cellWidth + wide[1].cellWidth).toBe(269 / 2);
  });
});

describe('a switched-off bound prints NOTHING, and a limit column nobody can fill is DROPPED (2026-09-07)', () => {
  // Operator, of the Data Report's rule ("if value was not there dont show
  // that boxes in report"): "same for alarm report also". The 2026-09-02 rule
  // withheld the VALUE of a disabled bound but printed a dash in its place;
  // now the cell is empty — and when EVERY row's cell in a limit column is
  // empty, the column itself is not printed, so the grid stays a rectangle
  // (the first attempt drew the empty cell with no border and the operator
  // reported "table was not forming properly"). A column any row can fill
  // stays, its other rows blank. `N/A` is untouched: it is the reference's
  // own word for a bound nobody administered, and a claim of its own.
  const off = (over: any = {}) => alarm({
    ruleSnapshot: { limit: 27, limitKind: 'HIGH', thresholdHigh: 27, thresholdLow: null, highEnabled: true, lowEnabled: false, decimals: 1 },
    ...over,
  });
  const both = alarm({
    ruleSnapshot: { limit: 27, limitKind: 'HIGH', thresholdHigh: 27, thresholdLow: 18, highEnabled: true, lowEnabled: true, decimals: 1 },
  });

  it('BOUND_NOT_SHOWN is the empty string', () => {
    expect(BOUND_NOT_SHOWN).toBe('');
    expect(NOT_APPLICABLE).toBe('N/A');
  });

  it('names the limit columns every row leaves empty', () => {
    expect([...hiddenLimitColumns([off(), off()])]).toEqual(['LOW LIMIT']);
    expect([...hiddenLimitColumns([off(), both])]).toEqual([]);
    expect([...hiddenLimitColumns([])]).toEqual([]);
    // N/A is a value: a column of N/A is printed.
    const na = alarm({ ruleSnapshot: { limit: 27, limitKind: 'HIGH', thresholdHigh: 27, thresholdLow: null, decimals: 1 } });
    expect([...hiddenLimitColumns([na, na])]).toEqual([]);
  });

  it('drops the column from the head, the rows and the widths together', () => {
    const hidden = hiddenLimitColumns([off()]);
    const head = reportHead('instrument', hidden);
    expect(head).toEqual(['DATE', 'TIME', 'DESCRIPTION', 'UOM', 'PV VALUE', 'HIGH LIMIT']);
    const row = reportRows([off()], fmt, undefined, 'instrument', hidden)[0];
    expect(row).toHaveLength(head.length);
    expect(row[head.indexOf('HIGH LIMIT')]).toBe('27.0');
    expect(columnWidths('instrument', hidden)[head.indexOf('HIGH LIMIT')]).toEqual({ cellWidth: 18 });
    expect(columnWidths('instrument', hidden)[head.length]).toBeUndefined();
  });

  it('keeps the column, with an empty cell, while any row can fill it', () => {
    const hidden = hiddenLimitColumns([off(), both]);
    const rows = reportRows([off(), both], fmt, undefined, 'instrument', hidden);
    const at = reportHead('instrument', hidden).indexOf('LOW LIMIT');
    expect(rows[0][at]).toBe('');
    expect(rows[1][at]).toBe('18.0');
  });

  it('buildAlarmsReport applies it, and asks for no unboxing', () => {
    const calls: any[] = [];
    const doc = { addTable: (o: any) => { calls.push(o); }, addSectionTitle: () => {} } as any;
    buildAlarmsReport(doc, {
      rows: [off(), off({ id: 'b' })], total: 2,
      scope: { blockName: 'CWH Block', areaName: 'QC 3', locationName: 'LCMS Room-II', instrumentLabel: 'CWH/RDU/002-01' },
      period: { from: '2026-05-27T16:00:00.000Z', to: '2026-05-28T16:00:00.000Z' }, fmt,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].head).not.toContain('LOW LIMIT');
    for (const r of calls[1].body) expect(r).toHaveLength(calls[1].head.length);
    expect(calls[0].unboxEmpty).toBeUndefined();
    expect(calls[1].unboxEmpty).toBeUndefined();
  });
});
