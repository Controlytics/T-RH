import { describe, it, expect } from 'vitest';
import { BAR_SERIES_MAX, WIDGET_INSTRUMENTS_MAX, type LatestKeyValue, type LatestValuesRow, type WidgetKey } from '@digilog/shared';
import { DASHBOARD_SERIES_HEX, STATUS_HEX, isGreen } from '../charts/chart-colors';
import { codeAxis } from '../comparison-model';
import {
  BAR_DEFAULTS, LEGEND_ROW_PX, PARTIAL_NOTE, PARTIAL_OPACITY,
  barAxis, barCaption, barLoadProblem, barModel, barPlan, barTooltip, buildBarOption, drawnDefinition, heldAnswers, hourAxis,
  legendRows, tooManyBarsText,
} from '../bar-chart-model';
import type { BucketRequest, TelemetryBucketPoint, TelemetryBucketSeries, TelemetryBuckets } from '../use-widget-data';
import { LOAD_FAILED } from '../widget-common';

const T: WidgetKey = { source: 'telemetry', key: 't', label: 'Temperature' };
const H: WidgetKey = { source: 'telemetry', key: 'h', label: 'Humidity' };
const P: WidgetKey = { source: 'telemetry', key: 'Pressure', unit: 'kPa' };
const V: WidgetKey = { source: 'telemetry', key: 'Voltage', unit: 'V' };

/** Marks which formatter drew a label, so a test can tell date-only from date + time. */
const FMT = {
  formatDate: (v: string) => `D:${v.slice(0, 10)}`,
  formatTime: (v: string) => `T:${v.slice(11, 16)}`,
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

  it('day and week buckets label the axis with the date only; the tooltip of an hour has the date and the time', () => {
    const daily = barModel(resp([series('t', [pt(day(1), 21)])]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(daily.labels[1]).toBe(`D:${day(1).slice(0, 10)}`);
    expect((buildBarOption(daily) as Record<string, any>).xAxis.data).toEqual(daily.labels);
    const weekly = barModel(resp([series('t', [pt('2026-10-25T18:30:00.000Z', 21)])], { bucket: 'week', bucketSeconds: 604_800, from: '2026-10-25T18:30:00.000Z', to: '2026-11-01T18:30:00.000Z' }), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(weekly.labels).toEqual(['D:2026-10-25']);
    const hourly = barModel(resp([series('t', [pt('2026-10-30T07:30:00.000Z', 21)])], { bucket: 'hour', bucketSeconds: 3600, from: '2026-10-30T07:00:00.000Z', to: '2026-10-30T09:00:00.000Z' }), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(hourly.labels).toEqual(['DT:2026-10-30T06:30', 'DT:2026-10-30T07:30', 'DT:2026-10-30T08:30']);
    expect(barTooltip(hourly, 1)).toContain('DT:2026-10-30T07:30');
    expect(hourly.partial).toEqual([true, false, true]);
  });

  it('R6-11: a returned start OFF the bucketSeconds grid (a DST change) fills nothing — the returned buckets only', () => {
    // 25 hours between two "day" starts: the zone changed its offset. Stepping
    // bucketSeconds from either would put slots off the server's edges.
    const off = new Date(DAY0 + 2 * 86_400_000 + 3_600_000).toISOString();
    const m = barModel(resp([series('t', [pt(day(1), 21), pt(off, 22)])]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.categories).toEqual([day(1), off]);
    expect(m.series[0].points.map((p) => p?.value)).toEqual([21, 22]);
  });

  it('nothing came back: no buckets, and every key is named as having no readings', () => {
    const m = barModel(resp([]), [T, P], [row('a', [measured('t', 1), raw('Pressure')])], 'all', FMT);
    expect(m.categories).toEqual([]);
    expect(m.series).toEqual([]);
    expect(m.unsent).toEqual(['Temperature', 'Pressure']);
  });

  it("the model names the bucket and value it was computed with — the RESPONSE's (m-4)", () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)])], { bucket: 'day', agg: 'max' }), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect([m.bucket, m.agg]).toEqual(['day', 'max']);
  });
});

describe('R6-12 — an hour bucket: the time on the axis, the date where the day changes', () => {
  const H0 = Date.parse('2026-10-29T08:30:00.000Z');
  const hours = (n: number) => Array.from({ length: n }, (_, k) => pt(new Date(H0 + k * 3_600_000).toISOString(), 21));
  const hourly = (n: number) => barModel(
    resp([series('t', hours(n))], { bucket: 'hour', bucketSeconds: 3600, from: new Date(H0).toISOString(), to: new Date(H0 + n * 3_600_000).toISOString() }),
    [T], [row('a', [measured('t', 1)])], 'all', FMT,
  );

  it('the axis prints the TIME; the first SHOWN label and each shown label on a new day add the DATE on a second line', () => {
    const m = hourly(48);
    expect(m.times[0]).toBe('T:08:30');
    expect(m.dates[0]).toBe('D:2026-10-29');
    const data = (buildBarOption(m, { rotate: 0, interval: 5 }) as Record<string, any>).xAxis.data as string[];
    // Shown: every 6th. 08:30 (first: dated), 14:30, 20:30 (same day), 02:30 (a new day: dated), …
    expect(data[0]).toBe('T:08:30\nD:2026-10-29');
    expect(data[6]).toBe('T:14:30');
    expect(data[12]).toBe('T:20:30');
    expect(data[18]).toBe('T:02:30\nD:2026-10-30');
    expect(data[24]).toBe('T:08:30');
    expect(data[42]).toBe('T:02:30\nD:2026-10-31');
    // A label that is not shown carries no date — the date goes where it is seen.
    expect(data[16]).toBe('T:00:30');
  });

  /** Hourly labels as the administered formatter prints them, starting at `startHour` on 23/10/2026. */
  const clock = (n: number, startHour = 14) => ({
    times: Array.from({ length: n }, (_, k) => `${String((startHour + k) % 24).padStart(2, '0')}:00`),
    dates: Array.from({ length: n }, (_, k) => `${23 + Math.floor((startHour + k) / 24)}/10/2026`),
  });

  it('labels stay LEVEL, never overlap-hidden, at a stride of whole hours that keeps every shown label clear of the next', () => {
    const c169 = clock(169);
    const c25 = clock(25);
    // 169 hours in a half-width card: dated labels two days apart.
    expect(hourAxis(c169.times, c169.dates, 562)).toEqual({ rotate: 0, interval: 47 });
    // The same at full width: every 12 hours.
    expect(hourAxis(c169.times, c169.dates, 1140)).toEqual({ rotate: 0, interval: 11 });
    // 25 hours in a half-width card: every 3 hours.
    expect(hourAxis(c25.times, c25.dates, 562)).toEqual({ rotate: 0, interval: 2 });
    // Before the width is known: the narrowest card's stride, never "auto" (the dates need to know).
    expect(typeof hourAxis(c169.times, c169.dates, null).interval).toBe('number');
    const option = buildBarOption(hourly(48), { rotate: 0, interval: 5 }) as Record<string, any>;
    expect(option.xAxis.axisLabel.rotate).toBe(0);
    expect(option.xAxis.axisLabel.hideOverlap).toBe(false);
  });

  it('two DATED labels side by side get a whole date of room — the first label late in its day, the next after midnight', () => {
    // 100 hours from 14:00 at 5.5 px a bucket: every 12 hours puts 14:00 (dated:
    // the first) beside 02:00 (dated: a new day) only 66 px apart — under a
    // date's width. The stride must step up to a day.
    const c = clock(100);
    expect(hourAxis(c.times, c.dates, 56 + 5.5 * 100)).toEqual({ rotate: 0, interval: 23 });
    // Starting at 01:00 the same width allows 12 hours: 01:00 (dated), 13:00, 01:00 (dated) — never two in a row.
    const early = clock(100, 1);
    expect(hourAxis(early.times, early.dates, 56 + 5.5 * 100)).toEqual({ rotate: 0, interval: 11 });
  });

  it("a dated label's two lines get a line's height each, so the date never touches the time above it", () => {
    const option = buildBarOption(hourly(48), { rotate: 0, interval: 5 }) as Record<string, any>;
    expect(option.xAxis.axisLabel.lineHeight).toBeGreaterThanOrEqual(14);
  });

  it('barAxis: an hour axis by the hour rule, a day or week axis by the code rule', () => {
    const h = hourly(169);
    expect(barAxis(h, 562)).toEqual(hourAxis(h.times, h.dates, 562));
    const d = barModel(resp([series('t', everyDayBut(-1))]), [T], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(barAxis(d, 300)).toEqual(codeAxis(d.labels, 300));
  });
});

describe('barModel — colours by the ASKED position (R6-1), series colours only (R6-8)', () => {
  it('all combined: a key that comes back empty does not shift the others', () => {
    const asked = [row('a', [measured('t', 1), raw('Pressure'), measured('h', 1, '%RH')])];
    const m = barModel(resp([series('Pressure', [pt(day(1), 101)]), series('h', [pt(day(1), 40)])]), [T, P, H], asked, 'all', FMT);
    expect(m.series.map((s) => s.name)).toEqual(['Pressure', 'Humidity']);
    expect(m.series.map((s) => s.color)).toEqual([DASHBOARD_SERIES_HEX[1], DASHBOARD_SERIES_HEX[2]]);
    expect(m.unsent).toEqual(['Temperature']);
  });

  it('F-I6: the third series — raw or not — is never drawn green', () => {
    const asked = [row('a', [measured('t', 1), raw('Pressure'), measured('h', 1, '%RH')])];
    const m = barModel(
      resp([series('t', [pt(day(1), 21)]), series('Pressure', [pt(day(1), 101)]), series('h', [pt(day(1), 40)])]),
      [T, P, H], asked, 'all', FMT,
    );
    expect(m.series).toHaveLength(3);
    for (const s of m.series) expect(isGreen(s.color), s.name).toBe(false);
  });

  it("all combined: a key's chosen colour is its own", () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)])]), [{ ...T, color: 4 }], [row('a', [measured('t', 1)])], 'all', FMT);
    expect(m.series[0].color).toBe(DASHBOARD_SERIES_HEX[4]);
  });

  it("m-7: a key without a colour never lands on the slot another key chose", () => {
    // Before: Temperature took slot 0 by position — the slot Humidity chose.
    const asked = [row('a', [measured('t', 1), measured('h', 1, '%RH')])];
    const m = barModel(resp([series('t', [pt(day(1), 21)]), series('h', [pt(day(1), 40)])]), [T, { ...H, color: 0 }], asked, 'all', FMT);
    expect(m.series.map((s) => s.color)).toEqual([DASHBOARD_SERIES_HEX[1], DASHBOARD_SERIES_HEX[0]]);
  });

  it('m-5: the legend is a key, not a filter — no click hides a series the tooltip would still list', () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)]), series('h', [pt(day(1), 40)])]), [T, H], [row('a', [measured('t', 1), measured('h', 1, '%RH')])], 'all', FMT);
    expect((buildBarOption(m) as Record<string, any>).legend.selectedMode).toBe(false);
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
    expect(m.series.map((s) => s.color)).toEqual([DASHBOARD_SERIES_HEX[1], DASHBOARD_SERIES_HEX[2], DASHBOARD_SERIES_HEX[3]]);
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
    expect(option.color).toEqual([DASHBOARD_SERIES_HEX[0]]);
    for (const s of option.series) {
      expect(s.markLine).toBeUndefined();
      expect(DASHBOARD_SERIES_HEX).toContain(s.itemStyle.color);
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

  it("a raw key with the widget's decimals prints at them, whatever the value", () => {
    const asked = [row('a', [raw('Pressure')])];
    const own = barModel(resp([series('Pressure', [pt(day(1), 101.698580417)])]), [{ ...P, decimals: 2 }], asked, 'all', FMT);
    expect(own.series[0].decimals).toBe(2);
    expect(barTooltip(own, 1)).toContain('101.70 kPa');
  });

  it("R6-10: a raw AVERAGE prints at the precision the DEVICE reports (its latest raw readings), never the mean's", () => {
    // The device sends 101.3; the mean is 101.698580417. Before: "101.698580 kPa".
    const one = barModel(resp([series('Pressure', [pt(day(1), 101.698580417)])]), [P], [row('a', [raw('Pressure', { value: 101.3 })])], 'all', FMT);
    expect(one.series[0].decimals).toBe(1);
    expect(barTooltip(one, 1)).toContain('101.7 kPa');
    // Across the asked instruments: the most digits any device reports (a quoted number is a number).
    const two = barModel(resp([series('Pressure', [pt(day(1), 101.698580417)])]), [P],
      [row('a', [raw('Pressure', { value: 101.3 })]), row('b', [raw('Pressure', { value: '101.25' })])], 'all', FMT);
    expect(two.series[0].decimals).toBe(2);
    // Each instrument: its OWN device.
    const each = barModel(resp([series('Pressure', [pt(day(1), 101.698580417)], 'a'), series('Pressure', [pt(day(1), 99.25)], 'b')]), [P],
      [row('a', [raw('Pressure', { value: 101 })]), row('b', [raw('Pressure', { value: 99.125 })])], 'instrument', FMT);
    expect(each.series.map((s) => s.decimals)).toEqual([0, 3]);
    // No numeric latest reading: the series' own values.
    const none = barModel(resp([series('Pressure', [pt(day(1), 101.25)])]), [P], [row('a', [raw('Pressure', { value: 'RUN' })])], 'all', FMT);
    expect(none.series[0].decimals).toBe(2);
  });

  it('R6-10: a raw minimum or maximum IS a reading — it keeps the precision of the values themselves', () => {
    const asked = [row('a', [raw('Pressure', { value: 101.3 })])];
    const max = barModel(resp([series('Pressure', [pt(day(1), 101.25), pt(day(2), 101.5)])], { agg: 'max' }), [P], asked, 'all', FMT);
    expect(max.series[0].decimals).toBe(2);
    expect(barTooltip(max, 2)).toContain('101.50 kPa');
  });

  it('m-2: a reading count says its figure ONCE — "4,320 readings" — with no unit and no "from"; its axis steps by whole readings', () => {
    const asked = [row('a', [measured('t', 1)]), row('b', [measured('t', 1)]), row('c', [measured('t', 1)])];
    const m = barModel(resp([series('t', [pt(day(1), 4320, 4320, 3), pt(day(2), 1, 1, 1)])], { agg: 'count' }), [T], asked, 'all', FMT);
    expect(m.series[0].decimals).toBe(0);
    expect(m.unit).toBeNull();
    expect(barTooltip(m, 1)).toContain('>4,320 readings<');
    expect(barTooltip(m, 1)).not.toContain('from');
    expect(barTooltip(m, 1)).toContain('3 instruments');
    expect(barTooltip(m, 2)).toContain('>1 reading<');
    const option = buildBarOption(m) as Record<string, any>;
    expect(option.yAxis.minInterval).toBe(1);
    expect(option.yAxis.name).toBe('');
    // Each instrument: the count alone.
    const each = barModel(resp([series('t', [pt(day(1), 1440, 1440, 1)], 'a')], { agg: 'count' }), [T], asked.slice(0, 1), 'instrument', FMT);
    expect(barTooltip(each, 1)).toContain('>1,440 readings<');
    expect(barTooltip(each, 1)).not.toMatch(/instrument|from/);
  });

  it('m-3: the value axis and the tooltip group a figure with ONE formatter, so no locale makes them disagree', () => {
    const asked = [row('a', [measured('t', 1)])];
    const m = barModel(resp([series('t', [pt(day(1), 504000, 504000)])], { agg: 'count' }), [T], asked, 'all', FMT);
    const formatter = (buildBarOption(m) as Record<string, any>).yAxis.axisLabel.formatter as (v: number) => string;
    const original = Number.prototype.toLocaleString;
    // An en-IN browser groups by lakh: 5,04,000.
    Number.prototype.toLocaleString = function lakh(this: number) { return this === 504000 ? '5,04,000' : original.call(this); };
    try {
      expect(formatter(504000)).toBe('5,04,000');
      expect(barTooltip(m, 1)).toContain('>5,04,000 readings<');
    } finally {
      Number.prototype.toLocaleString = original;
    }
    // An average's axis prints like its tooltip: ungrouped, as every reading in the app.
    const avg = barModel(resp([series('t', [pt(day(1), 1013.25)])]), [T], asked, 'all', FMT);
    expect(((buildBarOption(avg) as Record<string, any>).yAxis.axisLabel.formatter as (v: number) => string)(1000)).toBe('1000');
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

  it("m-1: the estimate is ECharts' own layout — the legend's padding is 0 (it wraps at the full width) and a row is 28 px", () => {
    const m = barModel(resp([series('t', [pt(day(1), 21)], 'a'), series('t', [pt(day(1), 22)], 'b')]), [T], [row('a', [measured('t', 1)]), row('b', [measured('t', 1)])], 'instrument', FMT);
    expect((buildBarOption(m) as Record<string, any>).legend.padding).toBe(0);
    expect(LEGEND_ROW_PX).toBe(28);
  });
});

describe('a held answer (fix round 1, I-1): drawn under a failed refresh only when it answers the widget as it stands', () => {
  const REQ: BucketRequest = { instrumentIds: ['a', 'b'], keys: ['t', 'h'], from: FROM, to: TO, bucket: 'day', agg: 'avg', groupBy: 'all' };
  const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

  it('the same request answers it, rolling or fixed', () => {
    expect(heldAnswers(REQ, { ...REQ }, false)).toBe(true);
    expect(heldAnswers(REQ, { ...REQ, instrumentIds: ['a', 'b'], keys: ['t', 'h'] }, true)).toBe(true);
  });

  it("a ROLLING window's minute shift (or an outage's minutes) is the same window; a FIXED window moved is not", () => {
    const later = { ...REQ, from: shift(FROM, 30 * 60_000), to: shift(TO, 30 * 60_000) };
    expect(heldAnswers(REQ, later, true)).toBe(true);
    expect(heldAnswers(REQ, later, false)).toBe(false);
  });

  it('another span (a period changed), other instruments, keys, bucket, value or grouping: not the widget as it stands', () => {
    expect(heldAnswers(REQ, { ...REQ, from: shift(FROM, -86_400_000) }, true)).toBe(false);
    expect(heldAnswers(REQ, { ...REQ, instrumentIds: ['a'] }, true)).toBe(false);
    expect(heldAnswers(REQ, { ...REQ, keys: ['t'] }, true)).toBe(false);
    expect(heldAnswers(REQ, { ...REQ, bucket: 'hour' }, true)).toBe(false);
    expect(heldAnswers(REQ, { ...REQ, agg: 'max' }, true)).toBe(false);
    expect(heldAnswers(REQ, { ...REQ, groupBy: 'instrument' }, true)).toBe(false);
  });

  it("drawnDefinition: the keys, instruments and grouping the HELD answer was asked with, in the widget's terms", () => {
    const rows = [row('a', [measured('t', 1)]), row('b', [measured('t', 1)]), row('c', [measured('t', 1)])];
    const d = drawnDefinition({ ...REQ, instrumentIds: ['b', 'a'], keys: ['t'], groupBy: 'instrument' }, [T, H], rows);
    expect(d.keys).toEqual([T]);
    expect(d.asked.map((r) => r.instrumentId)).toEqual(['b', 'a']);
    expect(d.groupBy).toBe('instrument');
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
