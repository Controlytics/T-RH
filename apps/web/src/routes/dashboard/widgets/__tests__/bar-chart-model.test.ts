import { describe, it, expect } from 'vitest';
import { BAR_SERIES_MAX, WIDGET_INSTRUMENTS_MAX, type LatestKeyValue, type LatestValuesRow, type WidgetKey } from '@digilog/shared';
import { SERIES_HEX, STATUS_HEX } from '../charts/chart-colors';
import {
  BAR_DEFAULTS, LEGEND_ROW_PX, PARTIAL_NOTE, PARTIAL_OPACITY,
  barCaption, barLoadProblem, barModel, barPlan, barTooltip, buildBarOption, legendRows, tooManyBarsText,
} from '../bar-chart-model';
import type { TelemetryBucketPoint, TelemetryBucketSeries, TelemetryBuckets } from '../use-widget-data';
import { LOAD_FAILED } from '../widget-common';

const T: WidgetKey = { source: 'telemetry', key: 't', label: 'Temperature' };
const H: WidgetKey = { source: 'telemetry', key: 'h', label: 'Humidity' };
const P: WidgetKey = { source: 'telemetry', key: 'Pressure', unit: 'kPa' };
const V: WidgetKey = { source: 'telemetry', key: 'Voltage', unit: 'V' };

/** Marks which formatter drew a label, so a test can tell date-only from date + time. */
const FMT = {
  formatDate: (v: string) => `D:${v.slice(0, 10)}`,
  formatDateTime: (v: string) => `DT:${v.slice(0, 16)}`,
};

// An Asia/Kolkata install: local midnight is 18:30Z the day before. The window
// is 14:30 IST on 23 Oct to 14:30 IST on 30 Oct, so it touches EIGHT local days,
// the first and the last only in part.
const FROM = '2026-10-23T09:00:00.000Z';
const TO = '2026-10-30T09:00:00.000Z';
const DAY0 = Date.parse('2026-10-22T18:30:00.000Z');
const day = (n: number) => new Date(DAY0 + n * 86_400_000).toISOString();

const pt = (ts: string, value: number, readings = 10, instruments = 1): TelemetryBucketPoint => ({ ts, value, readings, instruments });
const series = (key: string, points: TelemetryBucketPoint[], instrumentId: string | null = null): TelemetryBucketSeries => ({ instrumentId, key, points });
const resp = (s: TelemetryBucketSeries[], over: Partial<TelemetryBuckets> = {}): TelemetryBuckets => ({
  from: FROM, to: TO, bucket: 'day', agg: 'avg', timezone: 'Asia/Kolkata', bucketSeconds: 86_400, series: s, ...over,
});

const measured = (key: string, decimals: number, unit = '°C'): LatestKeyValue => ({
  source: 'telemetry', key, value: 21.4, ts: '2026-10-30T08:00:00.000Z', unit, decimals, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
});
const raw = (key: string, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key, value: 101.3, ts: '2026-10-30T08:00:00.000Z', unit: null, decimals: null, display: null,
  judged: null, ...over,
});
const unsent = (key: string): LatestKeyValue => raw(key, { value: null, ts: null });
const row = (id: string, values: LatestKeyValue[]): LatestValuesRow => ({
  instrumentId: id, code: `CWH/RDU/${id}`, name: id, functionalLocationName: null, locationAttribute: null,
  reporting: true, lastSeenAt: null, values,
});

/** Every day of the window but one, each with a value. */
const everyDayBut = (missing: number, value = 21.25) => Array.from({ length: 8 }, (_, n) => n)
  .filter((n) => n !== missing)
  .map((n) => pt(day(n), value + n));

const optionSeries = (o: unknown) => (o as { series: Record<string, any>[] }).series;

describe('barCaption — says what the bar is computed from, in these words', () => {
  it.each([
    ['hour', 'avg', 'Hourly average'],
    ['hour', 'min', 'Hourly minimum'],
    ['hour', 'max', 'Hourly maximum'],
    ['hour', 'count', 'Hourly reading count'],
    ['day', 'avg', 'Daily average'],
    ['day', 'min', 'Daily minimum'],
    ['day', 'max', 'Daily maximum'],
    ['day', 'count', 'Daily reading count'],
    ['week', 'avg', 'Weekly average'],
    ['week', 'min', 'Weekly minimum'],
    ['week', 'max', 'Weekly maximum'],
    ['week', 'count', 'Weekly reading count'],
  ] as const)('%s / %s → %s', (bucket, agg, words) => {
    expect(barCaption(bucket, agg)).toBe(words);
  });

  it("the defaults are the server's querystring defaults: hour, average, all instruments combined", () => {
    expect(BAR_DEFAULTS).toEqual({ bucket: 'hour', agg: 'avg', groupBy: 'all' });
  });
});

describe('barPlan — which instruments are asked', () => {
  it('asks only instruments that have SENT one of the keys, in the selection order, at most 50', () => {
    const rows = Array.from({ length: WIDGET_INSTRUMENTS_MAX + 7 }, (_, n) => row(`i${n}`, [measured('t', 1)]));
    rows.splice(1, 0, row('quiet', [unsent('t')]));
    const plan = barPlan(rows, [T], 'all');
    expect(plan.asked).toHaveLength(WIDGET_INSTRUMENTS_MAX);
    expect(plan.asked.map((r) => r.instrumentId).slice(0, 2)).toEqual(['i0', 'i1']);
    expect(plan.total).toBe(WIDGET_INSTRUMENTS_MAX + 7);
    expect(plan.tooMany).toBeNull();
  });

  it(`each instrument: more than ${BAR_SERIES_MAX} series asks nothing and counts every instrument that has sent a key`, () => {
    const rows = [
      row('a', [measured('t', 1), unsent('h')]), row('b', [measured('t', 1), measured('h', 1)]), row('c', [unsent('t'), measured('h', 1)]),
      row('quiet', [unsent('t'), unsent('h')]), row('d', [measured('t', 1), unsent('h')]),
    ];
    // Four instruments have sent a key (the quiet one is not counted): 4 × 2 = 8.
    const plan = barPlan(rows, [T, H], 'instrument');
    expect(plan.tooMany).toEqual({ instruments: 4, keys: 2 });
    expect(plan.total).toBe(4);
    expect(plan.asked).toEqual([]);
    // Exactly the palette: drawn.
    const six = barPlan(rows.slice(0, 3), [T, H], 'instrument');
    expect(six.tooMany).toBeNull();
    expect(six.asked.map((r) => r.instrumentId)).toEqual(['a', 'b', 'c']);
  });

  it('all instruments combined is never too many series — one per key', () => {
    const rows = Array.from({ length: 20 }, (_, n) => row(`i${n}`, [measured('t', 1), measured('h', 1)]));
    expect(barPlan(rows, [T, H], 'all').tooMany).toBeNull();
  });

  it('the message names both counts as numbers', () => {
    expect(tooManyBarsText(3, 4)).toBe('Too many bars: 3 instruments × 4 keys. Show all instruments combined, or choose fewer.');
    // Seven instruments of one key is too many too: one KEY, not "1 keys".
    expect(tooManyBarsText(7, 1)).toBe('Too many bars: 7 instruments × 1 key. Show all instruments combined, or choose fewer.');
  });
});

describe('barModel — the axis, the gaps, the partial buckets', () => {
  it('the axis is every bucket the window touches; a day with no reading is a GAP (null), never dropped and never 0', () => {
    const m = barModel(resp([series('t', everyDayBut(3))]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.categories).toEqual(Array.from({ length: 8 }, (_, n) => day(n)));
    expect(m.series[0].points[3]).toBeNull();
    const data = optionSeries(buildBarOption(m))[0].data as unknown[];
    expect(data).toHaveLength(8);
    expect(data[3]).toBeNull();
    expect(data).not.toContain(0);
  });

  it('fills the empty buckets before the first and after the last reading, from the server\'s own edges', () => {
    const m = barModel(resp([series('t', [pt(day(2), 20), pt(day(4), 22)])]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.categories).toEqual(Array.from({ length: 8 }, (_, n) => day(n)));
    expect(m.series[0].points.map((p) => p?.value ?? null)).toEqual([null, null, 20, null, 22, null, null, null]);
  });

  it('a key missing a bucket another key has: that key is null there', () => {
    const m = barModel(resp([series('t', everyDayBut(-1)), series('h', everyDayBut(5, 40))]), [T, H], [row('a', [measured('t', 1), measured('h', 1, '%RH')])], 'all', FMT);
    const [, hum] = optionSeries(buildBarOption(m));
    expect(hum.data[5]).toBeNull();
    expect(hum.data[4]).not.toBeNull();
  });

  it('a bucket the window covers only in part is PARTIAL: drawn lighter, and the tooltip says so in words', () => {
    const m = barModel(resp([series('t', everyDayBut(-1))]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.partial).toEqual([true, false, false, false, false, false, false, true]);
    const data = optionSeries(buildBarOption(m))[0].data as any[];
    // Visibly lighter, the same hue: a reduced opacity on the bar, never another colour.
    expect(PARTIAL_OPACITY).toBeGreaterThanOrEqual(0.3);
    expect(PARTIAL_OPACITY).toBeLessThanOrEqual(0.6);
    expect(data[0]).toEqual({ value: 21.25, itemStyle: { opacity: PARTIAL_OPACITY } });
    expect(data[7]).toEqual({ value: 28.25, itemStyle: { opacity: PARTIAL_OPACITY } });
    expect(data[1]).toBe(22.25);
    expect(PARTIAL_NOTE).toBe('Partial bucket — the window covers only part of it');
    expect(barTooltip(m, 0)).toContain(PARTIAL_NOTE);
    expect(barTooltip(m, 7)).toContain(PARTIAL_NOTE);
    expect(barTooltip(m, 1)).not.toContain(PARTIAL_NOTE);
  });

  it('partial is judged against the RESPONSE window, never another one', () => {
    // A bucket that starts exactly at `from` and ends exactly at `to` is whole.
    const m = barModel(resp([series('t', [pt('2026-10-29T18:30:00.000Z', 21)])], { from: '2026-10-29T18:30:00.000Z', to: '2026-10-30T18:30:00.000Z' }), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.categories).toEqual(['2026-10-29T18:30:00.000Z']);
    expect(m.partial).toEqual([false]);
  });

  it('day and week buckets label the axis with the date only; hour with the date and the time', () => {
    const daily = barModel(resp([series('t', [pt(day(1), 21)])]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(daily.labels[1]).toBe(`D:${day(1).slice(0, 10)}`);
    const weekly = barModel(resp([series('t', [pt('2026-10-25T18:30:00.000Z', 21)])], { bucket: 'week', bucketSeconds: 604_800, from: '2026-10-25T18:30:00.000Z', to: '2026-11-01T18:30:00.000Z' }), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(weekly.labels).toEqual(['D:2026-10-25']);
    const hourly = barModel(resp([series('t', [pt('2026-10-30T07:30:00.000Z', 21)])], { bucket: 'hour', bucketSeconds: 3600, from: '2026-10-30T07:00:00.000Z', to: '2026-10-30T09:00:00.000Z' }), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(hourly.labels).toEqual(['DT:2026-10-30T06:30', 'DT:2026-10-30T07:30', 'DT:2026-10-30T08:30']);
    expect(hourly.partial).toEqual([true, false, true]);
  });

  it('nothing came back: no buckets, and every key is named as having no readings', () => {
    const m = barModel(resp([]), [T, P], [row('a', [measured('t', 1), raw('Pressure')])], 'all', FMT);
    expect(m.categories).toEqual([]);
    expect(m.series).toEqual([]);
    expect(m.unsent).toEqual(['Temperature', 'Pressure']);
  });
});

describe('barModel — colours by the ASKED position (R6-1), series colours only (R6-8)', () => {
  it('all combined: a key that comes back empty does not shift the others', () => {
    const asked = [row('a', [measured('t', 1), raw('Pressure'), measured('h', 1, '%RH')])];
    const m = barModel(resp([series('Pressure', [pt(day(1), 101)]), series('h', [pt(day(1), 40)])]), [T, P, H], asked, 'all', FMT);
    expect(m.series.map((s) => s.name)).toEqual(['Pressure', 'Humidity']);
    expect(m.series.map((s) => s.color)).toEqual([SERIES_HEX[1], SERIES_HEX[2]]);
    expect(m.unsent).toEqual(['Temperature']);
  });

  it("all combined: a key's chosen colour is its own", () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)])]), [{ ...T, color: 4 }], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.series[0].color).toBe(SERIES_HEX[4]);
  });

  it('each instrument: by (instrument, key) in the asked order, whatever the server returned', () => {
    const asked = [row('101-01', [measured('t', 1), raw('Pressure')]), row('102-01', [measured('t', 1), raw('Pressure')])];
    // The first asked series (101-01 · Temperature) came back empty, and the
    // server's order is not the asked order.
    const m = barModel(resp([
      series('Pressure', [pt(day(1), 99)], '102-01'),
      series('t', [pt(day(1), 22)], '102-01'),
      series('Pressure', [pt(day(1), 101)], '101-01'),
    ]), [T, P], asked, 'instrument', FMT);
    expect(m.series.map((s) => s.name)).toEqual([
      'CWH/RDU/101-01 · Pressure', 'CWH/RDU/102-01 · Temperature', 'CWH/RDU/102-01 · Pressure',
    ]);
    expect(m.series.map((s) => s.color)).toEqual([SERIES_HEX[1], SERIES_HEX[2], SERIES_HEX[3]]);
    // A key read by ANY asked instrument has readings.
    expect(m.unsent).toEqual([]);
  });

  it('each instrument: a key no asked instrument returned is named', () => {
    const asked = [row('a', [measured('t', 1), raw('Voltage')]), row('b', [measured('t', 1), raw('Voltage')])];
    const m = barModel(resp([series('t', [pt(day(1), 21)], 'a'), series('t', [pt(day(1), 22)], 'b')]), [T, V], asked, 'instrument', FMT);
    expect(m.unsent).toEqual(['Voltage']);
  });

  it('no limit lines, and every bar is a series colour — never a status colour', () => {
    const m = barModel(resp([series('t', everyDayBut(-1, 30))]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    const option = buildBarOption(m) as Record<string, any>;
    expect(option.color).toEqual([SERIES_HEX[0]]);
    for (const s of option.series) {
      expect(s.markLine).toBeUndefined();
      expect(SERIES_HEX).toContain(s.itemStyle.color);
      expect(Object.values(STATUS_HEX)).not.toContain(s.itemStyle.color);
      for (const d of s.data) if (d && typeof d === 'object') expect(d.itemStyle.color).toBeUndefined();
    }
  });
});

describe('barModel — decimals (R6-6), units, the tooltip', () => {
  it("a measured key prints at the server's decimals", () => {
    const m = barModel(resp([series('t', [pt(day(1), 21.46667, 60)])]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.series[0].decimals).toBe(1);
    expect(barTooltip(m, 1)).toContain('21.5 °C');
  });

  it('all combined over instruments with different decimals: the largest of them', () => {
    const asked = [row('a', [measured('t', 1)]), row('b', [measured('t', 2)])];
    const m = barModel(resp([series('t', [pt(day(1), 21.46667, 120, 2)])]), [T], asked, 'all', FMT);
    expect(m.series[0].decimals).toBe(2);
    expect(barTooltip(m, 1)).toContain('21.47 °C');
  });

  it("a raw key: the widget's decimals, else the precision of the series' own values", () => {
    const asked = [row('a', [raw('Pressure')])];
    const own = barModel(resp([series('Pressure', [pt(day(1), 101.3)])]), [{ ...P, decimals: 2 }], asked, 'all', FMT);
    expect(own.series[0].decimals).toBe(2);
    expect(barTooltip(own, 1)).toContain('101.30 kPa');
    const seen = barModel(resp([series('Pressure', [pt(day(1), 101.25), pt(day(2), 101.5)])]), [P], asked, 'all', FMT);
    expect(seen.series[0].decimals).toBe(2);
    expect(barTooltip(seen, 2)).toContain('101.50 kPa');
  });

  it('a reading count is a whole number with no unit, and its axis steps by whole readings', () => {
    const m = barModel(resp([series('t', [pt(day(1), 1440, 1440)])], { agg: 'count' }), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.series[0].decimals).toBe(0);
    expect(m.unit).toBeNull();
    expect(barTooltip(m, 1)).toContain('>1440<');
    const option = buildBarOption(m) as Record<string, any>;
    expect(option.yAxis.minInterval).toBe(1);
    expect(option.yAxis.name).toBe('');
  });

  it('the tooltip gives the readings behind each bar, and — all combined — how many instruments', () => {
    const asked = [row('a', [measured('t', 1)]), row('b', [measured('t', 1)]), row('c', [measured('t', 1)])];
    const all = barModel(resp([series('t', [pt(day(1), 21, 4320, 3), pt(day(2), 21, 1, 1)])]), [T], asked, 'all', FMT);
    expect(barTooltip(all, 1)).toContain('from 4,320 readings');
    expect(barTooltip(all, 1)).toContain('3 instruments');
    expect(barTooltip(all, 2)).toContain('from 1 reading');
    expect(barTooltip(all, 2)).toContain('1 instrument');
    expect(barTooltip(all, 2)).not.toContain('1 instruments');
    const each = barModel(resp([series('t', [pt(day(1), 21, 1440, 1)], 'a')]), [T], asked.slice(0, 1), 'instrument', FMT);
    expect(barTooltip(each, 1)).toContain('from 1,440 readings');
    expect(barTooltip(each, 1)).not.toMatch(/instrument/);
  });

  it('a gap in the tooltip says No readings', () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)]), series('h', [pt(day(2), 40)])]), [T, H], [row('a', [measured('t', 1), measured('h', 1, '%RH')])], 'all', FMT);
    expect(barTooltip(m, 1)).toMatch(/Humidity.*No readings/s);
  });

  it('mixed units: each legend entry names its own; one unit: the axis names it', () => {
    const asked = [row('a', [measured('t', 1), raw('Pressure')])];
    const mixed = barModel(resp([series('t', [pt(day(1), 21)]), series('Pressure', [pt(day(1), 101)])]), [T, P], asked, 'all', FMT);
    expect(mixed.unit).toBeNull();
    expect(mixed.series.map((s) => s.legendName)).toEqual(['Temperature (°C)', 'Pressure (kPa)']);
    const one = barModel(resp([series('t', [pt(day(1), 21)])]), [T], asked, 'all', FMT);
    expect(one.unit).toBe('°C');
    expect((buildBarOption(one) as Record<string, any>).yAxis.name).toBe('°C');
  });

  it('escapes what someone else typed', () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)])]), [{ ...T, label: '<b>Temp</b>' }], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(barTooltip(m, 1)).toContain('&lt;b&gt;Temp&lt;/b&gt;');
    expect(barTooltip(m, 1)).not.toContain('<b>Temp</b>');
  });
});

describe('legendRows — the legend never runs into the plot', () => {
  const NAMES = ['CWH/RDU/101-01 · Temperature', 'CWH/RDU/102-01 · Temperature', 'CWH/RDU/001-00 · Temperature'];

  it('one series has no legend; several share a row while they fit, and wrap when they do not', () => {
    expect(legendRows(['Temperature'], 400)).toBe(0);
    expect(legendRows(NAMES, 1140)).toBe(1);
    expect(legendRows(NAMES, 361)).toBe(3);
    expect(legendRows(NAMES, 560)).toBe(2);
    // Before the width is known: one row.
    expect(legendRows(NAMES, null)).toBe(1);
  });

  it("the plot starts below every legend row, then below the unit's name", () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)], 'a'), series('t', [pt(day(1), 22)], 'b')]), [T], [row('a', [measured('t', 1)]), row('b', [measured('t', 1)])], 'instrument', FMT);
    const top = (rows: number) => (buildBarOption(m, undefined, rows) as Record<string, any>).grid.top;
    expect(top(1)).toBe(LEGEND_ROW_PX + 28);
    expect(top(3)).toBe(3 * LEGEND_ROW_PX + 28);
    const one = barModel(resp([series('t', [pt(day(1), 21)])]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect((buildBarOption(one, undefined, 0) as Record<string, any>).grid.top).toBe(28);
  });
});

describe('barLoadProblem — a refusal is said in the server\'s words', () => {
  it("a 400 prints the server's message verbatim", () => {
    const e = Object.assign(new Error('That window holds more than 1,000 hours; choose a larger bucket or a shorter window'), { status: 400 });
    expect(barLoadProblem(e)).toBe('That window holds more than 1,000 hours; choose a larger bucket or a shorter window');
  });

  it('any other failure is the generic one', () => {
    expect(barLoadProblem(Object.assign(new Error('boom'), { status: 500 }))).toBe(LOAD_FAILED);
    expect(barLoadProblem(new Error('offline'))).toBe(LOAD_FAILED);
    expect(barLoadProblem(Object.assign(new Error(''), { status: 400 }))).toBe(LOAD_FAILED);
  });
});
