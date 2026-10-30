import { describe, it, expect } from 'vitest';
import { SERIES_COLORS } from '../../../time-series-chart';
import { statusClasses } from '../../../status';
import { UNJUDGED_CLASSES } from '../../key-value';
import { NEUTRAL_HEX, SERIES_HEX, STATUS_HEX } from '../chart-colors';

describe('SERIES_HEX', () => {
  it("is the series palette's own literal fallbacks, in its order", () => {
    expect(SERIES_HEX).toHaveLength(SERIES_COLORS.length);
    SERIES_HEX.forEach((hex, n) => {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(SERIES_COLORS[n]).toContain(hex);
    });
  });
});

describe('STATUS_HEX', () => {
  /*
   * Each hex is the Tailwind v4 palette colour (oklch, converted to sRGB) of the
   * status's DOT class in status.ts. Pinning the class here makes a change in
   * status.ts fail this file instead of leaving the charts on the old colour.
   */
  const SOURCE: [keyof typeof STATUS_HEX, string, string][] = [
    ['OUT_OF_SPEC', statusClasses('OUT_OF_SPEC').dot, '#fb2c36'],
    ['STALE', statusClasses('STALE').dot, '#fe9a00'],
    ['PARTIAL', statusClasses('PARTIAL').dot, '#fe9a00'],
    ['NO_DATA', statusClasses('NO_DATA').dot, '#90a1b9'],
    ['OK', statusClasses('OK').dot, '#00bc7d'],
    ['NOT_JUDGED', UNJUDGED_CLASSES.dot, '#cad5e2'],
  ];
  const CLASS: Record<string, string> = {
    OUT_OF_SPEC: 'bg-red-500', STALE: 'bg-amber-500', PARTIAL: 'bg-amber-500',
    NO_DATA: 'bg-slate-400', OK: 'bg-emerald-500', NOT_JUDGED: 'bg-slate-300',
  };

  it.each(SOURCE)('%s matches its dot class %s', (key, dot, hex) => {
    expect(dot).toBe(CLASS[key]);
    expect(STATUS_HEX[key]).toBe(hex);
  });

  it('covers every key and nothing else', () => {
    expect(Object.keys(STATUS_HEX).sort()).toEqual(['NOT_JUDGED', 'NO_DATA', 'OK', 'OUT_OF_SPEC', 'PARTIAL', 'STALE']);
  });

  it('the neutral is the not-judged colour, and is no status colour', () => {
    expect(NEUTRAL_HEX).toBe(STATUS_HEX.NOT_JUDGED);
    for (const k of ['OUT_OF_SPEC', 'STALE', 'PARTIAL', 'NO_DATA', 'OK'] as const) {
      expect(NEUTRAL_HEX).not.toBe(STATUS_HEX[k]);
    }
  });
});
