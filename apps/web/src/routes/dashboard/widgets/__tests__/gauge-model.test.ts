import { describe, it, expect } from 'vitest';
import type { LatestKeyValue, LatestValuesRow, WidgetKey } from '@digilog/shared';
import { statusClasses } from '../../status';
import { UNJUDGED_CLASSES } from '../key-value';
import { CHART_FONT_FAMILY, NEUTRAL_HEX, SERIES_HEX, STATUS_HEX } from '../charts/chart-colors';
import { GAUGE_SIZE, READING_BOX_PX, buildGaugeOption, gaugeModel, gaugePairs, readingSize, type GaugeModel } from '../gauge-model';

const WORDS = { failure: 'Error', outOfRange: 'OL' };
const T: WidgetKey = { source: 'telemetry', key: 't', label: 'Temperature' };
const P: WidgetKey = { source: 'telemetry', key: 'Pressure', unit: 'kPa' };

const judged = (over: Partial<NonNullable<LatestKeyValue['judged']>> = {}): NonNullable<LatestKeyValue['judged']> => ({
  limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false, ...over,
});
const measured = (value: unknown, over: Partial<NonNullable<LatestKeyValue['judged']>> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 't', value, ts: '2026-10-30T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: judged(over),
});
const raw = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 'Pressure', value, ts: '2026-10-30T10:00:00.000Z', unit: null, decimals: null, display: null,
  judged: null, ...over,
});

/** Every status colour a raw key must never take — NOT_JUDGED is the neutral one itself. */
const VERDICT_HEXES = Object.entries(STATUS_HEX).filter(([k]) => k !== 'NOT_JUDGED').map(([, hex]) => hex);
const expectNeverAVerdict = (m: GaugeModel) => {
  expect(m.color === NEUTRAL_HEX || SERIES_HEX.includes(m.color)).toBe(true);
  expect(VERDICT_HEXES).not.toContain(m.color);
};

describe('gaugeModel — a MEASURED key with both bounds is BANDED, judged by quantityVerdict', () => {
  it('in limit: the arc sweeps to the reading between the bounds, in the OK colour', () => {
    const m = gaugeModel(measured(21.46), T, {}, true, WORDS);
    expect(m.kind).toBe('banded');
    expect(m.min).toBe(18);
    expect(m.max).toBe(27);
    expect(m.value).toBe(21.46);
    expect(m.position).toBeCloseTo((21.46 - 18) / 9, 10);
    expect(m.breach).toBeNull();
    expect(m.text).toBe('21.5');
    expect(m.unit).toBe('°C');
    expect(m.color).toBe(STATUS_HEX.OK);
    expect(m.label).toBe('In limit');
    expect(m.classes).toEqual(statusClasses('OK'));
    expect(m.scale).toEqual({ label: 'Limits', text: '18.0 - 27.0', unit: '°C' });
  });

  it("the scale IS the band (bandGaugeState's rule): a high breach pegs a full arc, in red", () => {
    const m = gaugeModel(measured(30), T, {}, true, WORDS);
    expect(m.kind).toBe('banded');
    expect(m.min).toBe(18);
    expect(m.max).toBe(27);
    expect(m.position).toBe(1);
    expect(m.breach).toBe('high');
    expect(m.color).toBe(STATUS_HEX.OUT_OF_SPEC);
    expect(m.label).toBe('Out of limit');
    expect(m.text).toBe('30.0');
  });

  it('a low breach is a zero-length arc — the red is carried by the ring (see buildGaugeOption)', () => {
    const m = gaugeModel(measured(12), T, {}, true, WORDS);
    expect(m.position).toBe(0);
    expect(m.breach).toBe('low');
    expect(m.color).toBe(STATUS_HEX.OUT_OF_SPEC);
    const series = (buildGaugeOption(m).series as Record<string, any>[])[0];
    expect(series.progress.show).toBe(false);
    expect(series.axisLine.lineStyle.color[0][1]).toMatch(/^rgba\(251, 44, 54, /);
  });

  it('a stale in-limit reading reads Offline, in the Offline colour', () => {
    const m = gaugeModel(measured(21), T, {}, false, WORDS);
    expect(m.kind).toBe('banded');
    expect(m.color).toBe(STATUS_HEX.STALE);
    expect(m.label).toBe('Offline');
  });

  it('a RANGE fault arrives with its number (60) — the arc places NOTHING and the word replaces it', () => {
    const m = gaugeModel(measured(60, { rangeError: true }), T, {}, true, WORDS);
    expect(m.kind).toBe('banded');
    expect(m.value).toBeNull();
    expect(m.position).toBeNull();
    expect(m.breach).toBeNull();
    expect(m.text).toBe('OL');
    expect(m.fault).toBe(true);
    expect(m.unit).toBeNull();
    expect(m.color).not.toBe(STATUS_HEX.OUT_OF_SPEC);
    expect(m.color).toBe(STATUS_HEX.NO_DATA);
  });

  it("a sensor failure prints the administered failure word, exactly as keyCell does", () => {
    const m = gaugeModel(measured('NA', { sensorError: true }), T, {}, true, { failure: 'Probe dead', outOfRange: 'OL' });
    expect(m.text).toBe('Probe dead');
    expect(m.fault).toBe(true);
    expect(m.position).toBeNull();
  });

  it('no reading: the band is still drawn (the bounds are real), nothing placed, NA', () => {
    const m = gaugeModel(measured(null), T, {}, true, WORDS);
    expect(m.kind).toBe('banded');
    expect(m.position).toBeNull();
    expect(m.text).toBe('NA');
    expect(m.unit).toBeNull();
    expect(m.color).toBe(STATUS_HEX.NO_DATA);
    expect(m.label).toBe('No data');
    expect(gaugeModel(undefined, T, {}, true, WORDS).kind).toBe('value-only');
  });

  it("a bound's TEXT prints in the limits line in place of its number", () => {
    const m = gaugeModel(measured(21, { limitMaxText: '27 (For Reference)' }), T, {}, true, WORDS);
    expect(m.scale).toEqual({ label: 'Limits', text: '18.0 - 27 (For Reference)', unit: null });
    expect(m.max).toBe(27);
  });

  it('a measured key ignores the widget scale', () => {
    const m = gaugeModel(measured(21), T, { min: 0, max: 100 }, true, WORDS);
    expect(m.min).toBe(18);
    expect(m.max).toBe(27);
  });
});

describe('gaugeModel — a MEASURED key with no usable band is VALUE-ONLY', () => {
  it('both bounds absent: Not assessed, in NEUTRAL — exactly as keyCell (Review Focus 5)', () => {
    const m = gaugeModel(measured(21, { limitMin: null, limitMax: null }), T, {}, true, WORDS);
    expect(m.kind).toBe('value-only');
    expect(m.min).toBeNull();
    expect(m.max).toBeNull();
    expect(m.position).toBeNull();
    expect(m.label).toBe('Not assessed');
    expect(m.color).toBe(NEUTRAL_HEX);
    expect(m.classes).toEqual(UNJUDGED_CLASSES);
    expect(m.scale).toBeNull();
    expect(m.text).toBe('21.0');
  });

  it('one bound (NMT) is still judged: its verdict colour, and the bound named', () => {
    const ok = gaugeModel(measured(21, { limitMin: null }), T, {}, true, WORDS);
    expect(ok.kind).toBe('value-only');
    expect(ok.color).toBe(STATUS_HEX.OK);
    expect(ok.scale).toEqual({ label: 'Limits', text: 'NMT 27.0', unit: '°C' });
    const out = gaugeModel(measured(30, { limitMin: null }), T, {}, true, WORDS);
    expect(out.color).toBe(STATUS_HEX.OUT_OF_SPEC);
  });

  it('a mis-administered band (high <= low) draws no arc; the verdict still colours it', () => {
    const m = gaugeModel(measured(21, { limitMin: 27, limitMax: 18 }), T, {}, true, WORDS);
    expect(m.kind).toBe('value-only');
    expect(m.position).toBeNull();
    // 21 is under the "low" bound of 27: quantityVerdict calls it out of limit, and so does the ring.
    expect(m.color).toBe(STATUS_HEX.OUT_OF_SPEC);
    expect(m.label).toBe('Out of limit');
    const zeroWidth = gaugeModel(measured(18, { limitMin: 18, limitMax: 18 }), T, {}, true, WORDS);
    expect(zeroWidth.kind).toBe('value-only');
    expect(zeroWidth.color).toBe(STATUS_HEX.OK);
  });
});

describe('gaugeModel — a RAW key is never judged and never takes a status colour', () => {
  it('with the widget scale: SCALED, neutral, placed between the scale ends', () => {
    const m = gaugeModel(raw(2.5), P, { min: 0, max: 10 }, true, WORDS);
    expect(m.kind).toBe('scaled');
    expect(m.min).toBe(0);
    expect(m.max).toBe(10);
    expect(m.value).toBe(2.5);
    expect(m.position).toBeCloseTo(0.25, 10);
    expect(m.breach).toBeNull();
    expect(m.text).toBe('2.5');
    expect(m.unit).toBe('kPa');
    expect(m.color).toBe(NEUTRAL_HEX);
    expect(m.label).toBe('Not judged');
    expect(m.scale).toEqual({ label: 'Scale', text: '0 - 10', unit: 'kPa' });
    expectNeverAVerdict(m);
  });

  it('off the scale is clamped to its end — never a breach, never red', () => {
    const hi = gaugeModel(raw(14), P, { min: 0, max: 10 }, true, WORDS);
    expect(hi.position).toBe(1);
    expect(hi.breach).toBeNull();
    expect(hi.text).toBe('14');
    expectNeverAVerdict(hi);
    expect(gaugeModel(raw(-3), P, { min: 0, max: 10 }, true, WORDS).position).toBe(0);
  });

  it("the scale ends print at the widget's decimals when it sets them", () => {
    const m = gaugeModel(raw('2.345'), { ...P, decimals: 1 }, { min: 0, max: 10 }, true, WORDS);
    expect(m.text).toBe('2.3');
    expect(m.scale).toEqual({ label: 'Scale', text: '0.0 - 10.0', unit: 'kPa' });
  });

  it('without the widget scale: VALUE-ONLY on a neutral full ring (Review Focus 5)', () => {
    const m = gaugeModel(raw(0.05), P, {}, true, WORDS);
    expect(m.kind).toBe('value-only');
    expect(m.position).toBeNull();
    expect(m.min).toBeNull();
    expect(m.text).toBe('0.05');
    expect(m.unit).toBe('kPa');
    expect(m.color).toBe(NEUTRAL_HEX);
    expect(m.scale).toBeNull();
    const ring = (buildGaugeOption(m).series as Record<string, any>[])[0];
    expect(ring.progress.show).toBe(false);
    expect(ring.axisLine.lineStyle.color).toEqual([[1, NEUTRAL_HEX]]);
  });

  it('an offline instrument: the word says Offline, the ring stays NEUTRAL (amber is a status colour)', () => {
    const m = gaugeModel(raw(2.5), P, { min: 0, max: 10 }, false, WORDS);
    expect(m.label).toBe('Offline');
    expect(m.color).toBe(NEUTRAL_HEX);
    expectNeverAVerdict(m);
  });

  it('text is printed as received and places nothing; a unit never sits beside it', () => {
    const m = gaugeModel(raw('RUN'), P, { min: 0, max: 10 }, true, WORDS);
    expect(m.kind).toBe('scaled');
    expect(m.value).toBeNull();
    expect(m.position).toBeNull();
    expect(m.text).toBe('RUN');
    expect(m.unit).toBeNull();
  });

  it('an attribute is raw: its server display, neutral', () => {
    const attr: LatestKeyValue = { ...raw('27'), source: 'attribute', key: 'High', display: '27.0' };
    const m = gaugeModel(attr, { source: 'attribute', key: 'High' }, {}, true, WORDS);
    expect(m.text).toBe('27.0');
    expect(m.kind).toBe('value-only');
    expectNeverAVerdict(m);
  });

  it('no value at all: NA on a neutral ring', () => {
    const m = gaugeModel(undefined, P, {}, true, WORDS);
    expect(m.text).toBe('NA');
    expect(m.kind).toBe('value-only');
    expect(m.color).toBe(NEUTRAL_HEX);
  });

  it('every raw case, reporting or not, scaled or not, is neutral', () => {
    for (const reporting of [true, false]) {
      for (const opts of [{}, { min: 0, max: 10 }]) {
        for (const v of [raw(5), raw(50), raw(-5), raw('x'), raw(null), undefined]) {
          expectNeverAVerdict(gaugeModel(v, P, opts, reporting, WORDS));
        }
      }
    }
  });
});

describe('buildGaugeOption — one ring, the band gauge\'s geometry, no ECharts chrome', () => {
  const series = (m: GaugeModel) => (buildGaugeOption(m).series as Record<string, any>[])[0];

  it('a full ring swept clockwise from 12 o\'clock, the position as a fraction of it', () => {
    const m = gaugeModel(measured(21.46), T, {}, true, WORDS);
    const s = series(m);
    expect(s.type).toBe('gauge');
    expect(s.startAngle).toBe(90);
    expect(s.endAngle).toBe(-270);
    expect(s.min).toBe(0);
    expect(s.max).toBe(1);
    expect(s.data).toEqual([{ value: m.position }]);
    expect(s.progress).toMatchObject({ show: true, width: GAUGE_SIZE.stroke, itemStyle: { color: STATUS_HEX.OK } });
    expect(s.axisLine.lineStyle.width).toBe(GAUGE_SIZE.stroke);
    expect(s.radius).toBe(GAUGE_SIZE.outerRadius);
  });

  it("the track is the arc's own colour, faint (band-gauge's 0.18); a neutral one a little stronger to be seen", () => {
    expect(series(gaugeModel(measured(21), T, {}, true, WORDS)).axisLine.lineStyle.color).toEqual([[1, 'rgba(0, 188, 125, 0.18)']]);
    expect(series(gaugeModel(raw(2), P, { min: 0, max: 10 }, true, WORDS)).axisLine.lineStyle.color).toEqual([[1, 'rgba(202, 213, 226, 0.3)']]);
  });

  it('nothing to place (no reading, a fault, text) draws the track alone', () => {
    for (const m of [gaugeModel(measured(null), T, {}, true, WORDS), gaugeModel(measured(60, { rangeError: true }), T, {}, true, WORDS), gaugeModel(raw('RUN'), P, { min: 0, max: 10 }, true, WORDS)]) {
      expect(series(m).progress.show).toBe(false);
      expect(series(m).data).toEqual([{ value: 0 }]);
    }
  });

  it('draws no pointer, ticks, labels, title, detail or tooltip — the number is the page\'s, in Inter', () => {
    const option = buildGaugeOption(gaugeModel(measured(21), T, {}, true, WORDS)) as Record<string, any>;
    const s = option.series[0];
    for (const part of ['pointer', 'anchor', 'axisTick', 'splitLine', 'axisLabel', 'title', 'detail']) {
      expect(s[part].show).toBe(false);
    }
    expect(s.silent).toBe(true);
    expect(option.tooltip).toBeUndefined();
    expect(option.textStyle.fontFamily).toBe(CHART_FONT_FAMILY);
    expect(option.color).toEqual([STATUS_HEX.OK]);
  });

  it('a raw gauge option carries no verdict colour anywhere', () => {
    for (const m of [gaugeModel(raw(5), P, { min: 0, max: 10 }, true, WORDS), gaugeModel(raw(5), P, {}, false, WORDS)]) {
      const json = JSON.stringify(buildGaugeOption(m)).toLowerCase();
      for (const hex of VERDICT_HEXES) expect(json).not.toContain(hex.toLowerCase());
      // …nor their rgba forms on the track.
      expect(json).not.toMatch(/rgba\((251, 44, 54|254, 154, 0|144, 161, 185|0, 188, 125),/);
    }
  });
});

describe('gaugePairs — the cap is spent only on keys an instrument has SENT', () => {
  const row = (id: string, values: LatestKeyValue[]): LatestValuesRow => ({
    instrumentId: id, code: `CODE-${id}`, name: id, functionalLocationName: null, locationAttribute: null,
    reporting: true, lastSeenAt: null, values,
  });

  it('instrument by instrument, key by key, skipping a key never received', () => {
    const rows = [
      row('a', [measured(21), raw(2)]),
      row('b', [measured(22), raw(null, { ts: null })]),
    ];
    const keys: WidgetKey[] = [T, P];
    const pairs = gaugePairs(rows, keys);
    expect(pairs.map((p) => `${p.row.instrumentId}:${p.key.key}`)).toEqual(['a:t', 'a:Pressure', 'b:t']);
    expect(pairs[0].value).toBe(rows[0].values[0]);
  });

  it('a key that arrived once and is NA now is still drawn (it was sent)', () => {
    expect(gaugePairs([row('a', [measured(null)])], [T])).toHaveLength(1);
  });
});

describe('readingSize — the value steps down to the ring, so it is never clipped', () => {
  it("the box is the ring's hole, less a little air", () => {
    expect(READING_BOX_PX).toBe(2 * (GAUGE_SIZE.outerRadius - GAUGE_SIZE.stroke) - 6);
  });

  it('a short reading is the big figure; each longer one a step smaller', () => {
    expect(readingSize('21.5')).toBe('text-[24px]');
    expect(readingSize('100.0')).toBe('text-[24px]');
    expect(readingSize('1013.25')).toBe('text-[19px]');
    expect(readingSize('1013.2500')).toBe('text-[15px]');
    expect(readingSize('MAINTENANCE')).toBe('text-[12px]');
  });

  it('the longest realistic values take the last step: a 10-decimal reading, a device float, a 24-character fault word', () => {
    // 10 = TELEMETRY_DECIMALS_MAX; 24 = RS485_FAILURE_TEXT_MAX / SENSOR_RANGE_TEXT_MAX.
    expect(readingSize('21.4567891234')).toBe('text-[11px]');
    expect(readingSize('1013.2500000001')).toBe('text-[11px]');
    expect(readingSize('Probe disconnected (bus)')).toBe('text-[11px]');
    expect('Probe disconnected (bus)').toHaveLength(24);
    const m = gaugeModel(measured(21.4567891234), T, {}, true, WORDS);
    expect(m.text).toBe('21.5');
    expect(gaugeModel({ ...measured(21.4567891234), decimals: 10 }, T, {}, true, WORDS).text).toBe('21.4567891234');
  });
});
