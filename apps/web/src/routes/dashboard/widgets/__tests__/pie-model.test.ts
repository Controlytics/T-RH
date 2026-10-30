import { describe, it, expect } from 'vitest';
import type { InstrumentStatus } from '@digilog/shared';
import { NEUTRAL_HEX, SERIES_HEX, STATUS_HEX } from '../charts/chart-colors';
import { statusClasses } from '../../status';
import {
  LEGEND_BOTTOM_PX, OTHER_LABEL, PIE_HEIGHT, PIE_RING_MIN_PX, STATUS_PIE_ORDER,
  alarmTypeLabel, alarmTypePieModel, buildPieOption, piePlan, statusPieModel, type PieSlice,
} from '../pie-model';

type Row = { status: InstrumentStatus; reporting: boolean; judged?: boolean };
const row = (status: InstrumentStatus, reporting = true, judged?: boolean): Row => ({ status, reporting, judged });

/** The server's seven type tokens, in the server's order (`ALARM_TYPE_TOKENS`). */
const TOKENS = ['TEMP_HIGH', 'TEMP_LOW', 'RH_HIGH', 'RH_LOW', 'OFFLINE', 'RS485', 'RANGE'] as const;
const byType = (active: number[]) => TOKENS.map((type, n) => ({ type, active: active[n] ?? 0, unacknowledged: 0 }));

describe('statusPieModel — one slice per instrumentLook key, the server decides every one', () => {
  it('counts each look, in the fixed order, labelled and coloured from instrumentLook / STATUS_HEX', () => {
    const rows = [
      row('OK'), row('OK'), row('OK'),
      row('STALE', false),
      row('OUT_OF_SPEC'), row('OUT_OF_SPEC'),
      row('PARTIAL'),
      row('NO_DATA'),
      row('NO_DATA', true, false),
    ];
    const slices = statusPieModel(rows);
    expect(slices.map((s) => s.key)).toEqual(['OUT_OF_SPEC', 'PARTIAL', 'STALE', 'NO_DATA', 'NOT_JUDGED', 'OK']);
    expect(slices.map((s) => s.label)).toEqual(['Out of limit', 'Partial data', 'Offline', 'No data', 'Not judged', 'In limit']);
    expect(slices.map((s) => s.count)).toEqual([2, 1, 1, 1, 1, 3]);
    for (const s of slices) expect(s.hex).toBe(STATUS_HEX[s.key as keyof typeof STATUS_HEX]);
    expect(STATUS_PIE_ORDER).toEqual(['OUT_OF_SPEC', 'PARTIAL', 'STALE', 'NO_DATA', 'NOT_JUDGED', 'OK']);
  });

  it('a look nobody has is no slice, and no rows is no slice at all', () => {
    expect(statusPieModel([row('OK'), row('OK')]).map((s) => [s.key, s.count])).toEqual([['OK', 2]]);
    expect(statusPieModel([])).toEqual([]);
  });

  it('Review Focus 1: a reporting pressure-only instrument is "Not judged", neutral — never "No data", never green', () => {
    // The server says NO_DATA for it today, and judged:false.
    const [slice] = statusPieModel([row('NO_DATA', true, false)]);
    expect(slice.key).toBe('NOT_JUDGED');
    expect(slice.label).toBe('Not judged');
    expect(slice.label).not.toBe(statusClasses('NO_DATA').label);
    expect(slice.hex).toBe(NEUTRAL_HEX);
    // An independent anchor: whatever the palette says, it is not the "In limit" green.
    expect(slice.hex).not.toBe(STATUS_HEX.OK);
    expect(slice.hex).not.toBe(STATUS_HEX.NO_DATA);
  });

  it('Review Focus 1: the same instrument not reporting is "Offline"', () => {
    const [slice] = statusPieModel([row('NO_DATA', false, false)]);
    expect(slice.key).toBe('STALE');
    expect(slice.label).toBe('Offline');
    expect(slice.hex).toBe(STATUS_HEX.STALE);
  });
});

describe('alarmTypeLabel — the Alarms page\'s administered names, never a literal', () => {
  it('names a token from the administered names, else the shipped name', () => {
    expect(alarmTypeLabel('TEMP_HIGH', { limitTemperatureHigh: 'Room too warm' })).toBe('Room too warm');
    expect(alarmTypeLabel('TEMP_HIGH', undefined)).toBe('High Temperature');
    expect(alarmTypeLabel('RS485', undefined)).toBe('RS485 Temperature Failure / RS485 Humidity Failure');
  });

  it('a token the server lists but nothing names prints the server\'s token, never blank', () => {
    expect(alarmTypeLabel('VIBRATION', undefined)).toBe('VIBRATION');
  });
});

describe('alarmTypePieModel — active alarms by type', () => {
  it('only types with an active alarm, in the server\'s order, each the next series colour', () => {
    const slices = alarmTypePieModel(byType([4, 0, 2, 0, 1]), { limitHumidityHigh: 'Wet room' });
    expect(slices.map((s) => [s.key, s.label, s.count])).toEqual([
      ['TEMP_HIGH', 'High Temperature', 4],
      ['RH_HIGH', 'Wet room', 2],
      ['OFFLINE', 'Inactivity', 1],
    ]);
    expect(slices.map((s) => s.hex)).toEqual([SERIES_HEX[0], SERIES_HEX[1], SERIES_HEX[2]]);
  });

  it('nothing active is no slice (the widget then says "Nothing to show")', () => {
    expect(alarmTypePieModel(byType([0, 0, 0, 0, 0, 0, 0]), undefined)).toEqual([]);
    expect(alarmTypePieModel([], undefined)).toEqual([]);
  });

  it('R7-2: more types than colours keeps the largest five in series order and merges the rest into "Other", neutral', () => {
    // All seven active, distinct counts: RS485 (1) and TEMP_LOW (2) are the two smallest.
    const slices = alarmTypePieModel(byType([7, 2, 6, 5, 4, 1, 3]), undefined);
    expect(slices.map((s) => s.key)).toEqual(['TEMP_HIGH', 'RH_HIGH', 'RH_LOW', 'OFFLINE', 'RANGE', 'OTHER']);
    expect(slices.slice(0, 5).map((s) => s.hex)).toEqual(SERIES_HEX.slice(0, 5));
    const other = slices[5];
    expect(other.label).toBe(OTHER_LABEL);
    expect(OTHER_LABEL).toBe('Other');
    expect(other.hex).toBe(NEUTRAL_HEX);
    expect(other.count).toBe(3);
    expect(other.merged).toEqual([
      { label: 'Low Temperature', count: 2 },
      { label: 'RS485 Temperature Failure / RS485 Humidity Failure', count: 1 },
    ]);
    // Never a colour twice in one pie.
    expect(new Set(slices.map((s) => s.hex)).size).toBe(slices.length);
  });

  it('exactly as many types as colours: no "Other", every colour once', () => {
    const slices = alarmTypePieModel(byType([1, 1, 1, 1, 1, 1, 0]), undefined);
    expect(slices).toHaveLength(SERIES_HEX.length);
    expect(slices.some((s) => s.key === 'OTHER')).toBe(false);
    expect(slices.map((s) => s.hex)).toEqual([...SERIES_HEX]);
  });

  it('two types administered the same name stay two legend entries', () => {
    const slices = alarmTypePieModel(byType([1, 2]), { limitTemperatureHigh: 'Temperature', limitTemperatureLow: 'Temperature' });
    expect(new Set(slices.map((s) => s.label)).size).toBe(2);
    expect(slices.map((s) => s.label)).toEqual(['Temperature', 'Temperature (TEMP_LOW)']);
  });
});

const STATUS_SLICES: PieSlice[] = [
  { key: 'OUT_OF_SPEC', label: 'Out of limit', count: 2, hex: STATUS_HEX.OUT_OF_SPEC },
  { key: 'NOT_JUDGED', label: 'Not judged', count: 1, hex: STATUS_HEX.NOT_JUDGED },
  { key: 'OK', label: 'In limit', count: 9, hex: STATUS_HEX.OK },
];

/* eslint-disable @typescript-eslint/no-explicit-any -- an ECharts option is untyped JSON. */
describe('buildPieOption — the app\'s colours, explicitly; a key, not a filter', () => {
  const plan = piePlan(STATUS_SLICES, 600);

  it('a ring of the model\'s slices, each in its own colour, no slice labels', () => {
    const o: any = buildPieOption(STATUS_SLICES, { subject: 'status', total: 12 }, plan);
    expect(o.color).toEqual(STATUS_SLICES.map((s) => s.hex));
    const [series] = o.series;
    expect(series.type).toBe('pie');
    expect(series.data.map((d: any) => [d.name, d.value, d.itemStyle.color])).toEqual([
      ['Out of limit', 2, STATUS_HEX.OUT_OF_SPEC], ['Not judged', 1, STATUS_HEX.NOT_JUDGED], ['In limit', 9, STATUS_HEX.OK],
    ]);
    expect(series.label.show).toBe(false);
    // Neighbours of one colour (Partial and Offline share amber) are kept apart by a white edge.
    expect(series.itemStyle.borderColor).toBe('#ffffff');
    expect(series.itemStyle.borderWidth).toBeGreaterThan(0);
  });

  it('R7-1: the legend is a key, not a filter', () => {
    const o: any = buildPieOption(STATUS_SLICES, { subject: 'status', total: 12 }, plan);
    expect(o.legend.selectedMode).toBe(false);
    expect(o.legend.data).toEqual(['Out of limit', 'Not judged', 'In limit']);
    expect(o.legend.formatter('Not judged')).toBe('Not judged  1');
    // Room under the last row, or the SVG's edge cuts its descenders (render check).
    expect(o.legend.bottom).toBe(LEGEND_BOTTOM_PX);
    expect(LEGEND_BOTTOM_PX).toBeGreaterThan(0);
    expect(o.series[0].bottom).toBe(plan.legendPx + 12 + LEGEND_BOTTOM_PX);
  });

  it('the status tooltip counts instruments of the whole; the alarm tooltip counts active alarms', () => {
    const o: any = buildPieOption(STATUS_SLICES, { subject: 'status', total: 12 }, plan);
    const tip = o.tooltip.formatter({ dataIndex: 1 });
    expect(tip).toContain('Not judged');
    expect(tip).toContain('1 of 12 instruments');
    const alarms: PieSlice[] = [{ key: 'TEMP_HIGH', label: 'High <Temp>', count: 1, hex: SERIES_HEX[0] }];
    const a: any = buildPieOption(alarms, { subject: 'alarm_types' }, piePlan(alarms, 600));
    const tipA = a.tooltip.formatter({ dataIndex: 0 });
    expect(tipA).toContain('1 active alarm');
    // Labels are typed by someone else: escaped.
    expect(tipA).toContain('High &lt;Temp&gt;');
  });

  it('"Other"\'s tooltip lists each merged type and its count', () => {
    const slices = alarmTypePieModel(byType([7, 2, 6, 5, 4, 1, 3]), undefined);
    const o: any = buildPieOption(slices, { subject: 'alarm_types' }, piePlan(slices, 600));
    const tip: string = o.tooltip.formatter({ dataIndex: 5 });
    expect(tip).toContain('Other');
    expect(tip).toContain('Low Temperature');
    expect(tip).toContain('RS485 Temperature Failure / RS485 Humidity Failure');
    expect(tip).toMatch(/Low Temperature<\/span>\s*<b[^>]*>2</);
  });
});

describe('piePlan — the legend fits the panel, and its count is never cut', () => {
  const LONG: PieSlice[] = [
    { key: 'RS485', label: 'RS485 Temperature Failure / RS485 Humidity Failure', count: 12, hex: SERIES_HEX[0] },
    { key: 'OFFLINE', label: 'Inactivity', count: 3, hex: SERIES_HEX[1] },
  ];

  it('a wide panel: the names in full, one legend row, the standard height', () => {
    const p = piePlan(LONG, 1150);
    expect(p.texts).toEqual(['RS485 Temperature Failure / RS485 Humidity Failure  12', 'Inactivity  3']);
    expect(p.rows).toBe(1);
    expect(p.height).toBe(PIE_HEIGHT);
  });

  it('a quarter panel: the long name is shortened, never its count, and each entry takes its own row', () => {
    const p = piePlan(LONG, 250);
    expect(p.texts[0].endsWith('…  12')).toBe(true);
    expect(p.texts[0].length).toBeLessThan(LONG[0].label.length);
    expect(p.texts[1]).toBe('Inactivity  3');
    expect(p.rows).toBe(2);
  });

  it('a legend of many rows grows the chart rather than crushing the ring', () => {
    const seven: PieSlice[] = Array.from({ length: 6 }, (_, n) => ({ key: `k${n}`, label: `A long alarm type name ${n}`, count: n + 1, hex: SERIES_HEX[n] }));
    const p = piePlan(seven, 250);
    expect(p.rows).toBe(6);
    expect(p.height - p.legendPx - LEGEND_BOTTOM_PX - 12).toBeGreaterThanOrEqual(PIE_RING_MIN_PX);
  });

  it('an unknown width (the first frame): nothing shortened, one row', () => {
    const p = piePlan(LONG, null);
    expect(p.texts[0]).toBe('RS485 Temperature Failure / RS485 Humidity Failure  12');
    expect(p.rows).toBe(1);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
