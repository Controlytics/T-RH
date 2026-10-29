import { describe, it, expect } from 'vitest';
import { WIDGET_COLOR_COUNT, type LatestKeyValue, type WidgetKey } from '@digilog/shared';
import { statusClasses } from '../../status';
import { SERIES_COLORS } from '../../time-series-chart';
import { formatKeyValue, keyCell, decimalsSeen, isMeasured, UNJUDGED_CLASSES } from '../key-value';

const WORDS = { failure: 'Error', outOfRange: 'OL' };
const RAW_KEY: WidgetKey = { source: 'telemetry', key: 'p' };

const raw = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 'p', value, ts: '2026-10-28T10:00:00.000Z',
  unit: null, decimals: null, display: null, judged: null, ...over,
});
const measured = (value: unknown, over: Partial<LatestKeyValue['judged'] & object> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 't', value, ts: '2026-10-28T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false, ...over },
});

describe('a raw key is shown, never judged', () => {
  it('a raw key never renders green', () => {
    // Compared against the palette itself, so a palette change cannot slip a
    // green past this test (mutate the constant, not just the branch).
    const ok = statusClasses('OK');
    const cell = keyCell(raw(21.5), true, RAW_KEY, WORDS);
    expect(cell.judged).toBe(false);
    expect(cell.label).toBe('Not judged');
    for (const field of ['dot', 'text', 'bg', 'border'] as const) {
      expect(cell.classes[field]).not.toBe(ok[field]);
    }
    expect(cell.classes).toEqual(UNJUDGED_CLASSES);
  });

  it("an offline instrument's raw key reads Offline, not In limit", () => {
    const cell = keyCell(raw(21.5), false, RAW_KEY, WORDS);
    expect(cell.label).toBe('Offline');
    expect(cell.classes).toEqual(statusClasses('STALE'));
  });

  it('a raw key prints as received', () => {
    expect(formatKeyValue(raw(0.05), RAW_KEY)).toBe('0.05');
    expect(formatKeyValue(raw('NA'), RAW_KEY)).toBe('NA');
    expect(formatKeyValue(raw(true), RAW_KEY)).toBe('true');
    expect(formatKeyValue(raw({ a: 1 }), RAW_KEY)).toBe('{"a":1}');
    expect(formatKeyValue(raw(null), RAW_KEY)).toBe('NA');
    expect(formatKeyValue(undefined, RAW_KEY)).toBe('NA');
  });

  it('widget decimals apply to a raw key only', () => {
    expect(formatKeyValue(raw(0.05), { ...RAW_KEY, decimals: 2 })).toBe('0.05');
    expect(formatKeyValue(raw('1.23456'), { ...RAW_KEY, decimals: 1 })).toBe('1.2');
    // A measured key keeps the server's precision whatever the widget says.
    expect(formatKeyValue(measured(21.456), { source: 'telemetry', key: 't', decimals: 3 })).toBe('21.5');
  });

  it('a raw key carries the widget unit; NA carries none', () => {
    expect(keyCell(raw(3), true, { ...RAW_KEY, unit: 'kPa' }, WORDS).unit).toBe('kPa');
    expect(keyCell(raw('3.5'), true, { ...RAW_KEY, unit: 'kPa' }, WORDS).unit).toBe('kPa');
    expect(keyCell(raw(null), true, { ...RAW_KEY, unit: 'kPa' }, WORDS).unit).toBeNull();
  });

  it('a unit never sits beside text or true/false — it belongs to a number', () => {
    // Seen in the 2026-10-28 render check: "true kPa".
    expect(keyCell(raw(true), true, { ...RAW_KEY, unit: 'kPa' }, WORDS).unit).toBeNull();
    expect(keyCell(raw('NA'), true, { ...RAW_KEY, unit: 'kPa' }, WORDS).unit).toBeNull();
    expect(keyCell(raw('RUN'), true, { ...RAW_KEY, unit: 'kPa' }, WORDS).unit).toBeNull();
    expect(keyCell(measured('NA'), true, { source: 'telemetry', key: 't' }, WORDS).unit).toBeNull();
  });
});

describe('a measured key is the server\'s', () => {
  it("prints the server's decimals, from a quoted number as the gateways send it", () => {
    const cell = keyCell(measured('21.456'), true, { source: 'telemetry', key: 't' }, WORDS);
    expect(cell.text).toBe('21.5');
    expect(cell.unit).toBe('°C');
    expect(cell.judged).toBe(true);
    expect(cell.classes).toEqual(statusClasses('OK'));
    expect(cell.label).toBe('In limit');
  });

  it('a breach is red, a stale in-limit reading is Offline', () => {
    expect(keyCell(measured(30), true, { source: 'telemetry', key: 't' }, WORDS).classes).toEqual(statusClasses('OUT_OF_SPEC'));
    expect(keyCell(measured(21), false, { source: 'telemetry', key: 't' }, WORDS).label).toBe('Offline');
  });

  it('the widget cannot change a measured unit', () => {
    expect(keyCell(measured(21), true, { source: 'telemetry', key: 't', unit: 'F' }, WORDS).unit).toBe('°C');
  });

  it('a faulted measured key shows the fault word, not the number', () => {
    const cell = keyCell(measured(60, { rangeError: true }), true, { source: 'telemetry', key: 't' }, WORDS);
    expect(cell.text).toBe('OL');
    expect(cell.unit).toBeNull();
    expect(cell.classes).not.toEqual(statusClasses('OUT_OF_SPEC'));
  });

  it('a measured key with no bound in force is Not assessed', () => {
    const cell = keyCell(measured(21, { limitMin: null, limitMax: null }), true, { source: 'telemetry', key: 't' }, WORDS);
    expect(cell.label).toBe('Not assessed');
  });

  it('measured is the server\'s answer, judged !== null', () => {
    expect(isMeasured(measured(1))).toBe(true);
    expect(isMeasured(raw(1))).toBe(false);
  });
});

describe('attributes', () => {
  it("print the server's display, else the value", () => {
    const attr = (value: unknown, display: string | null): LatestKeyValue => ({ ...raw(value), source: 'attribute', key: 'Firmware', display });
    expect(formatKeyValue(attr('25', '25.0'), { source: 'attribute', key: 'Firmware' })).toBe('25.0');
    expect(formatKeyValue(attr('1.2', null), { source: 'attribute', key: 'Firmware' })).toBe('1.2');
    expect(keyCell(attr('1.2', null), true, { source: 'attribute', key: 'Firmware' }, WORDS).label).toBe('Not judged');
  });
});

describe('decimalsSeen — the precision the data actually has', () => {
  it('is the most fractional digits received, capped at 6', () => {
    expect(decimalsSeen([1, 2.25, 3.1])).toBe(2);
    expect(decimalsSeen([])).toBe(0);
    expect(decimalsSeen([0.123456789])).toBe(6);
  });
});

it('a widget colour index covers the chart palette exactly', () => {
  expect(SERIES_COLORS.length).toBe(WIDGET_COLOR_COUNT);
});
