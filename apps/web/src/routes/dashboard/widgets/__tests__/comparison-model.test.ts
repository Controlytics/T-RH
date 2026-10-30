import { describe, it, expect } from 'vitest';
import { WIDGET_INSTRUMENTS_MAX, type LatestKeyValue, type LatestValuesRow, type WidgetKey } from '@digilog/shared';
import { CHART_FONT_FAMILY, SERIES_HEX, STATUS_HEX } from '../charts/chart-colors';
import { buildComparisonOption, comparisonModel, comparisonTooltip, labelsTurn } from '../comparison-model';

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

  it('turned codes are rotated and thinned; level codes are every one, none hidden', () => {
    const m = comparisonModel(rows, [T], WORDS);
    expect((buildComparisonOption(m, true) as any).xAxis.axisLabel).toMatchObject({ rotate: 45, interval: 'auto' });
    expect((buildComparisonOption(m, false) as any).xAxis.axisLabel).toMatchObject({ rotate: 0, interval: 0 });
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

describe('labelsTurn — measured against the width each bar group gets', () => {
  const codes = (n: number) => Array.from({ length: n }, (_, k) => `CWH/RDU/${String(100 + k)}-01`);

  it('three codes in a wide card stay level; in a quarter-width card they turn (render check: one was hidden)', () => {
    expect(labelsTurn(codes(3), 1140)).toBe(false);
    expect(labelsTurn(codes(3), 260)).toBe(true);
  });

  it('a dozen codes at full width turn; eight do not', () => {
    expect(labelsTurn(codes(12), 1140)).toBe(true);
    expect(labelsTurn(codes(8), 1140)).toBe(false);
  });

  it('before the width is known, the count decides', () => {
    expect(labelsTurn(codes(8), null)).toBe(false);
    expect(labelsTurn(codes(9), null)).toBe(true);
    expect(labelsTurn(codes(9), 0)).toBe(true);
    expect(labelsTurn([], 100)).toBe(false);
  });
});
