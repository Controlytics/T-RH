import { describe, it, expect } from 'vitest';
import { WIDGET_INSTRUMENTS_MAX, type LatestKeyValue, type LatestValuesRow, type WidgetKey } from '@digilog/shared';
import { CHART_FONT_FAMILY, SERIES_HEX, STATUS_HEX } from '../charts/chart-colors';
import { buildComparisonOption, codeAxis, comparisonModel, comparisonTooltip } from '../comparison-model';
import { noReadingsFor } from '../widget-common';

const WORDS = { failure: 'Error', outOfRange: 'OL' };
const T: WidgetKey = { source: 'telemetry', key: 't', label: 'Temperature' };
const P: WidgetKey = { source: 'telemetry', key: 'Pressure', unit: 'kPa' };

const measured = (value: unknown, over: Partial<NonNullable<LatestKeyValue['judged']>> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 't', value, ts: '2026-10-30T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false, ...over },
});
const raw = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 'Pressure', value, ts: '2026-10-30T10:00:00.000Z', unit: null, decimals: null, display: null,
  judged: null, ...over,
});
const row = (id: string, values: LatestKeyValue[], code = `CWH/RDU/${id}`): LatestValuesRow => ({
  instrumentId: id, code, name: id, functionalLocationName: null, locationAttribute: null,
  reporting: true, lastSeenAt: null, values,
});

const VERDICT_HEXES = Object.entries(STATUS_HEX).filter(([k]) => k !== 'NOT_JUDGED').map(([, hex]) => hex);

describe('comparisonModel', () => {
  it('instruments in the server order on the axis; one series per key, in its widget colour', () => {
    const rows = [row('101-01', [measured(21.46), raw(2.5)]), row('001-00', [measured(23), raw(4)])];
    const m = comparisonModel(rows, [T, { ...P, color: 4 }], WORDS);
    expect(m.codes).toEqual(['CWH/RDU/101-01', 'CWH/RDU/001-00']);
    expect(m.series.map((s) => s.name)).toEqual(['Temperature', 'Pressure']);
    expect(m.series[0].color).toBe(SERIES_HEX[0]);
    expect(m.series[1].color).toBe(SERIES_HEX[4]);
    expect(m.series[0].points.map((p) => p.value)).toEqual([21.46, 23]);
    expect(m.total).toBe(2);
  });

  it("a key with no colour takes its own position's palette slot", () => {
    const m = comparisonModel([row('a', [measured(1), raw(2)])], [T, P], WORDS);
    expect(m.series.map((s) => s.color)).toEqual([SERIES_HEX[0], SERIES_HEX[1]]);
  });

  it("m-7: a key without a colour never lands on the slot another key chose", () => {
    // Before: Temperature took slot 0 by position — the slot Pressure chose.
    const m = comparisonModel([row('a', [measured(1), raw(2)])], [T, { ...P, color: 0 }], WORDS);
    expect(m.series.map((s) => s.color)).toEqual([SERIES_HEX[1], SERIES_HEX[0]]);
  });

  it('m-5: the legend is a key, not a filter — no click hides a series the tooltip would still list', () => {
    const m = comparisonModel([row('a', [measured(1), raw(2)])], [T, P], WORDS);
    expect((buildComparisonOption(m) as Record<string, any>).legend.selectedMode).toBe(false);
  });

  it('a value that is not a number is a GAP (null), never 0', () => {
    const rows = [
      row('a', [measured(21), raw('RUN')]),
      row('b', [measured(22), raw(true)]),
      row('c', [measured(23), raw(null, { ts: null })]),
      row('d', [measured(24), raw('3.5')]),
    ];
    const m = comparisonModel(rows, [T, P], WORDS);
    expect(m.series[1].points.map((p) => p.value)).toEqual([null, null, null, 3.5]);
    const data = (buildComparisonOption(m).series as Record<string, any>[])[1].data;
    expect(data).toEqual([null, null, null, 3.5]);
    expect(data).not.toContain(0);
  });

  it('a faulted measured reading is a gap even when it arrived as a number (OL = 60)', () => {
    const m = comparisonModel([row('a', [measured(60, { rangeError: true })]), row('b', [measured('NA', { sensorError: true })])], [T], WORDS);
    expect(m.series[0].points.map((p) => p.value)).toEqual([null, null]);
    expect(m.series[0].points.map((p) => p.text)).toEqual(['OL', 'Error']);
  });

  it(`spends its ${WIDGET_INSTRUMENTS_MAX} only on instruments that have sent a key, and counts the rest`, () => {
    const rows = [
      row('silent', [measured(null, {}), raw(null, { ts: null })]),
      ...Array.from({ length: WIDGET_INSTRUMENTS_MAX + 7 }, (_, n) => row(`i${n}`, [measured(20 + n / 10), raw(null, { ts: null })])),
    ];
    rows[0].values[0] = { ...rows[0].values[0], ts: null };
    const m = comparisonModel(rows, [T, P], WORDS);
    expect(m.codes).toHaveLength(WIDGET_INSTRUMENTS_MAX);
    expect(m.codes[0]).toBe('CWH/RDU/i0');
    expect(m.total).toBe(WIDGET_INSTRUMENTS_MAX + 7);
    expect(m.series.every((s) => s.points.length === WIDGET_INSTRUMENTS_MAX)).toBe(true);
  });

  it('none sent: nothing to draw', () => {
    const m = comparisonModel([row('a', [measured(null)])].map((r) => ({ ...r, values: [{ ...r.values[0], ts: null }] })), [T], WORDS);
    expect(m.codes).toEqual([]);
    expect(m.total).toBe(0);
  });

  it("the axis names a unit only when every plotted value shares it", () => {
    expect(comparisonModel([row('a', [measured(21)]), row('b', [measured(22)])], [T], WORDS).unit).toBe('°C');
    expect(comparisonModel([row('a', [measured(21), raw(2)])], [T, P], WORDS).unit).toBeNull();
    expect(comparisonModel([row('a', [raw(2)])], [{ ...P, unit: undefined }], WORDS).unit).toBeNull();
  });

  it('mixed units: each legend name carries its own unit; one shared unit stays on the axis (M4)', () => {
    const humid: LatestKeyValue = { ...measured(45), key: 'h', unit: '%RH' };
    const H: WidgetKey = { source: 'telemetry', key: 'h', label: 'Humidity' };
    const mixed = comparisonModel([row('a', [measured(21), humid])], [T, H], WORDS);
    expect(mixed.unit).toBeNull();
    expect(mixed.series.map((s) => s.legendName)).toEqual(['Temperature (°C)', 'Humidity (%RH)']);
    // The tooltip keeps the plain label: its values already carry their units.
    expect(mixed.series.map((s) => s.name)).toEqual(['Temperature', 'Humidity']);
    expect((buildComparisonOption(mixed).series as any[]).map((s) => s.name)).toEqual(['Temperature (°C)', 'Humidity (%RH)']);
    const same = comparisonModel([row('a', [measured(21), { ...measured(22), key: 'h' }])], [T, H], WORDS);
    expect(same.unit).toBe('°C');
    expect(same.series.map((s) => s.legendName)).toEqual(['Temperature', 'Humidity']);
    // A number with no unit beside one in °C: mixed, and the unitless key gets no brackets.
    const bare = comparisonModel([row('a', [measured(21), raw(2)])], [T, { ...P, unit: undefined }], WORDS);
    expect(bare.unit).toBeNull();
    expect(bare.series.map((s) => s.legendName)).toEqual(['Temperature (°C)', 'Pressure']);
    // A key with only text plots nothing, so °C is the one unit and the axis names it.
    const text = comparisonModel([row('a', [measured(21), raw('RUN')])], [T, { ...P, unit: undefined }], WORDS);
    expect(text.unit).toBe('°C');
    expect(text.series.map((s) => s.legendName)).toEqual(['Temperature', 'Pressure']);
  });

  it(`a key sent ONLY beyond the ${WIDGET_INSTRUMENTS_MAX}-instrument cap: not drawn, and NOT "No readings" — it has readings (fix round 2)`, () => {
    const V: WidgetKey = { source: 'telemetry', key: 'Voltage', label: 'Voltage' };
    const never: LatestKeyValue = { ...raw(null, { ts: null }), key: 'Voltage' };
    const rows = Array.from({ length: WIDGET_INSTRUMENTS_MAX + 1 }, (_, n) => row(`i${n}`, [measured(20), never]));
    // Instrument #51 — past the cap — is the only one that has sent Voltage.
    rows[WIDGET_INSTRUMENTS_MAX] = row(`i${WIDGET_INSTRUMENTS_MAX}`, [measured(20), { ...raw(230), key: 'Voltage' }]);
    const m = comparisonModel(rows, [T, V], WORDS);
    expect(m.codes).toHaveLength(WIDGET_INSTRUMENTS_MAX);
    expect(m.total).toBe(WIDGET_INSTRUMENTS_MAX + 1);
    expect(m.series.map((x) => x.name)).toEqual(['Temperature']);
    expect(m.unsent).toEqual([]);
  });

  it('a key NO drawn instrument has sent is not drawn as an empty series, and is named in key order (M5)', () => {
    const V: WidgetKey = { source: 'telemetry', key: 'Voltage', label: 'Voltage' };
    const W: WidgetKey = { source: 'telemetry', key: 'Power' };
    const never = (key: string): LatestKeyValue => ({ ...raw(null, { ts: null }), key });
    const m = comparisonModel([row('a', [never('Voltage'), measured(21), never('Power')])], [V, T, W], WORDS);
    expect(m.series.map((s) => s.name)).toEqual(['Temperature']);
    expect(m.unsent).toEqual(['Voltage', 'Power']);
    // The colour stays the KEY's own: Temperature is the second key, so its slot is 1.
    expect(m.series[0].color).toBe(SERIES_HEX[1]);
    expect(comparisonModel([row('a', [measured(21)])], [T], WORDS).unsent).toEqual([]);
  });
});

describe('noReadingsFor — the ONE wording for keys nobody has sent (the bar chart reuses it)', () => {
  it('names them in order; nothing to say is null', () => {
    expect(noReadingsFor(['Voltage'])).toBe('No readings for Voltage');
    expect(noReadingsFor(['Voltage', 'Power'])).toBe('No readings for Voltage, Power');
    expect(noReadingsFor([])).toBeNull();
  });
});

describe('comparisonTooltip — what the value card would say, escaped', () => {
  it("a measured key prints the SERVER's unit; a raw key the WIDGET's", () => {
    const m = comparisonModel([row('101-01', [{ ...measured(21.46), unit: '°C' }, raw(2.5)])], [{ ...T }, { ...P, unit: 'kPa' }], WORDS);
    const html = comparisonTooltip(m, 0);
    expect(html).toContain('CWH/RDU/101-01');
    expect(html).toContain('21.5 °C');
    expect(html).toContain('2.5 kPa');
    // The widget cannot rename a measured key's unit.
    const forced = comparisonModel([row('a', [measured(21)])], [{ ...T, unit: 'F' }], WORDS);
    expect(comparisonTooltip(forced, 0)).toContain('21.0 °C');
  });

  it('a gap names itself: NA, the fault word, the text as received — never a unit beside it', () => {
    const m = comparisonModel([row('a', [measured(60, { rangeError: true }), raw('RUN')]), row('b', [measured(20), raw(null)])], [T, P], WORDS);
    const a = comparisonTooltip(m, 0);
    expect(a).toContain('>OL<');
    expect(a).toContain('>RUN<');
    expect(a).not.toContain('OL °C');
    expect(a).not.toContain('RUN kPa');
    expect(comparisonTooltip(m, 1)).toContain('>NA<');
  });

  it('device text and labels cannot inject markup', () => {
    const m = comparisonModel([row('a', [raw('<img src=x onerror=alert(1)>')], '<b>X</b>')], [{ ...P, label: 'P & "Q"' }], WORDS);
    const html = comparisonTooltip(m, 0);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>X</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('P &amp; &quot;Q&quot;');
  });
});

describe('buildComparisonOption', () => {
  const rows = [row('101-01', [measured(21.46), raw(2.5)]), row('001-00', [measured(30), raw(4)])];

  it('grouped bars, one per key, coloured by the series palette — never a verdict, never a limit line (ruling P4)', () => {
    const m = comparisonModel(rows, [T, P], WORDS);
    const option = buildComparisonOption(m) as Record<string, any>;
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.data).toEqual(['CWH/RDU/101-01', 'CWH/RDU/001-00']);
    expect(option.series).toHaveLength(2);
    expect(option.series.map((s: any) => s.type)).toEqual(['bar', 'bar']);
    expect(option.series.map((s: any) => s.itemStyle.color)).toEqual([SERIES_HEX[0], SERIES_HEX[1]]);
    expect(option.color).toEqual([SERIES_HEX[0], SERIES_HEX[1]]);
    // 30 °C is out of limit — the bar does not say so.
    const json = JSON.stringify(option).toLowerCase();
    for (const hex of VERDICT_HEXES) expect(json).not.toContain(hex.toLowerCase());
    expect(json).not.toContain('markline');
  });

  it('the legend shows only when there is more than one key to tell apart', () => {
    expect((buildComparisonOption(comparisonModel(rows, [T, P], WORDS)) as any).legend.show).toBe(true);
    expect((buildComparisonOption(comparisonModel(rows, [T], WORDS)) as any).legend.show).toBe(false);
  });

  it("is drawn in the page's font, and its tooltip is the model's", () => {
    const m = comparisonModel(rows, [T, P], WORDS);
    const option = buildComparisonOption(m) as Record<string, any>;
    expect(option.textStyle.fontFamily).toBe(CHART_FONT_FAMILY);
    expect(option.tooltip.trigger).toBe('axis');
    expect(option.tooltip.confine).toBe(true);
    expect(option.tooltip.formatter([{ dataIndex: 1 }])).toBe(comparisonTooltip(m, 1));
    expect(option.yAxis.name).toBe('');
    expect((buildComparisonOption(comparisonModel(rows, [T], WORDS)) as any).yAxis.name).toBe('°C');
  });

  it('the code axis it is given is the one it draws', () => {
    const m = comparisonModel(rows, [T], WORDS);
    expect((buildComparisonOption(m, { rotate: 90, interval: 2 }) as any).xAxis.axisLabel).toMatchObject({ rotate: 90, interval: 2 });
    expect((buildComparisonOption(m, { rotate: 45, interval: 0 }) as any).xAxis.axisLabel).toMatchObject({ rotate: 45, interval: 0 });
    expect((buildComparisonOption(m, { rotate: 0, interval: 0 }) as any).xAxis.axisLabel).toMatchObject({ rotate: 0, interval: 0 });
  });

  it('leaves room over the plot for the legend and for the unit over the value axis', () => {
    const one = buildComparisonOption(comparisonModel(rows, [T], WORDS)) as any;
    const two = buildComparisonOption(comparisonModel(rows, [T, P], WORDS)) as any;
    expect(one.yAxis.name).toBe('°C');
    expect(two.yAxis.name).toBe('');
    expect(one.grid.top).toBeGreaterThan((buildComparisonOption(comparisonModel([row('a', [raw(1)])], [{ ...P, unit: undefined }], WORDS)) as any).grid.top);
    expect(two.grid.top).toBeGreaterThanOrEqual(28);
  });
});

describe('codeAxis — the codes are never a block: level, turned 45°, or upright with a stride (M3)', () => {
  const codes = (n: number) => Array.from({ length: n }, (_, k) => `CWH/RDU/${String(100 + k)}-01`);
  /** Code labels shown ECharts-style: index 0, then every (interval + 1)th. */
  const shown = (n: number, interval: number) => Array.from({ length: n }, (_, k) => k).filter((k) => k % (interval + 1) === 0).length;

  it('three codes in a wide card stay level; in a quarter-width card they turn (render check: one was hidden)', () => {
    expect(codeAxis(codes(3), 1140)).toEqual({ rotate: 0, interval: 0 });
    expect(codeAxis(codes(3), 260)).toEqual({ rotate: 45, interval: 0 });
  });

  it('a dozen codes at full width turn 45°, every one shown; eight stay level', () => {
    expect(codeAxis(codes(12), 1140)).toEqual({ rotate: 45, interval: 0 });
    expect(codeAxis(codes(8), 1140)).toEqual({ rotate: 0, interval: 0 });
  });

  it('fifty in a half-width card stand upright with a stride, so neighbours sit a full line apart', () => {
    const width = 562;
    const a = codeAxis(codes(50), width);
    expect(a.rotate).toBe(90);
    expect(typeof a.interval).toBe('number');
    const per = (width - 56) / 50;
    // Upright, the gap across the text between two shown codes is (interval + 1) bars.
    expect(((a.interval as number) + 1) * per).toBeGreaterThanOrEqual(16);
    // …and no wider stride than that needs: one fewer would collide.
    expect((a.interval as number) * per).toBeLessThan(16);
    expect(shown(50, a.interval as number)).toBeGreaterThanOrEqual(20);
  });

  it('fifty in a quarter-width card: a longer stride, still a line apart', () => {
    const a = codeAxis(codes(50), 260);
    expect(a.rotate).toBe(90);
    expect(((a.interval as number) + 1) * ((260 - 56) / 50)).toBeGreaterThanOrEqual(16);
  });

  it('turned 45° only while neighbours stay a line apart across the text; tighter than that, upright', () => {
    // 20 codes in 520 px: 23.2 px a bar, 16.4 across the text at 45° — still 45°.
    expect(codeAxis(codes(20), 520).rotate).toBe(45);
    // 30 codes in 520 px: 15.5 px a bar, 10.9 across — upright.
    expect(codeAxis(codes(30), 520).rotate).toBe(90);
  });

  it('before the width is known, the count decides', () => {
    expect(codeAxis(codes(8), null)).toEqual({ rotate: 0, interval: 0 });
    expect(codeAxis(codes(9), null)).toEqual({ rotate: 45, interval: 'auto' });
    expect(codeAxis(codes(9), 0)).toEqual({ rotate: 45, interval: 'auto' });
    expect(codeAxis([], 100)).toEqual({ rotate: 0, interval: 0 });
  });
});
