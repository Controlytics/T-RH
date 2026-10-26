import { describe, it, expect } from 'vitest';
import {
  isMktEnabled, isMktOn, mktCelsius, mktFromExpMean, MKT_DELTA_H_OVER_R_K, KELVIN_OFFSET,
} from './mkt.js';

describe('mktCelsius — ICH Q1A(R2) / USP <1150>', () => {
  it('equals the temperature when every reading is the same', () => {
    expect(mktCelsius([25, 25, 25])!).toBeCloseTo(25, 6);
    expect(mktCelsius([-20])!).toBeCloseTo(-20, 6);
  });

  it('weights toward the hot readings — above the arithmetic mean, below the max', () => {
    const mkt = mktCelsius([20, 30])!;
    expect(mkt).toBeGreaterThan(25);
    expect(mkt).toBeLessThan(30);
    // Worked by hand from the formula with ΔH/R = 10,000 K:
    // mean(exp(-10000/293.15), exp(-10000/303.15)) → 10000 / -ln(mean) - 273.15.
    const expected = MKT_DELTA_H_OVER_R_K
      / -Math.log((Math.exp(-10000 / 293.15) + Math.exp(-10000 / 303.15)) / 2) - KELVIN_OFFSET;
    expect(mkt).toBeCloseTo(expected, 9);
    expect(mkt).toBeCloseTo(26.26, 2);
  });

  it('is null with no readings, and skips a reading below absolute zero', () => {
    expect(mktCelsius([])).toBeNull();
    expect(mktCelsius([-300])).toBeNull();
    expect(mktCelsius([-300, 25])!).toBeCloseTo(25, 6);
  });

  it('agrees with mktFromExpMean, which is what the SQL path feeds', () => {
    const readings = [21.2, 22.9, 24.5, 19.8];
    const terms = readings.map((c) => Math.exp(-MKT_DELTA_H_OVER_R_K / (c + KELVIN_OFFSET)));
    const expMean = terms.reduce((a, b) => a + b, 0) / terms.length;
    expect(mktFromExpMean(expMean)).toBeCloseTo(mktCelsius(readings)!, 9);
    expect(mktFromExpMean(null)).toBeNull();
    expect(mktFromExpMean(0)).toBeNull();
  });
});

describe('isMktEnabled — OFF unless the attribute says on', () => {
  it('reads 1 / True / yes / on, case-folded, on a case-folded key', () => {
    expect(isMktEnabled([{ key: 'isMktCalculationEnabled', value: '1' }])).toBe(true);
    expect(isMktEnabled([{ key: 'ISMKTCALCULATIONENABLED', value: 'True' }])).toBe(true);
    expect(isMktEnabled([{ key: ' isMktCalculationEnabled ', value: ' yes ' }])).toBe(true);
  });

  it('is OFF for 0 / False, for an unreadable value, and when the attribute is absent', () => {
    expect(isMktEnabled([{ key: 'isMktCalculationEnabled', value: '0' }])).toBe(false);
    expect(isMktEnabled([{ key: 'isMktCalculationEnabled', value: 'False' }])).toBe(false);
    expect(isMktEnabled([{ key: 'isMktCalculationEnabled', value: 'maybe' }])).toBe(false);
    expect(isMktEnabled([{ key: 'isMktCalculationEnabled', value: '' }])).toBe(false);
    expect(isMktEnabled([{ key: 'Enable_Temp_NMT', value: '1' }])).toBe(false);
    expect(isMktEnabled([])).toBe(false);
  });
});

describe('isMktOn — the profile switch in front of the instrument attribute', () => {
  const attr = (value: string) => [{ key: 'IsMktCalculationEnabled', value }];
  it('profile off: never, whatever the instrument says', () => {
    expect(isMktOn({ enabled: false, attributeKeys: ['isMktCalculationEnabled'] }, attr('1'))).toBe(false);
  });
  it('profile on with no attribute named: always', () => {
    expect(isMktOn({ enabled: true, attributeKeys: [] }, [])).toBe(true);
  });
  it('profile on with an attribute named: the instrument decides, absent = off', () => {
    const s = { enabled: true, attributeKeys: ['isMktCalculationEnabled'] };
    expect(isMktOn(s, attr('1'))).toBe(true);
    expect(isMktOn(s, attr('0'))).toBe(false);
    expect(isMktOn(s, [])).toBe(false);
  });
});
