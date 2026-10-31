import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERIES_COLORS } from '../../../time-series-chart';
import { statusClasses } from '../../../status';
import { UNJUDGED_CLASSES } from '../../key-value';
import {
  ALARM_SERIES_HEX, CHART_FONT_FAMILY, CHART_INK, DASHBOARD_SERIES_HEX, NEUTRAL_HEX, SERIES_HEX, STATUS_HEX,
  hueOf, isGreen, keyPaletteFor, withoutGreens,
} from '../chart-colors';

describe('SERIES_HEX', () => {
  it("is the series palette's own literal fallbacks, in its order", () => {
    expect(SERIES_HEX).toHaveLength(SERIES_COLORS.length);
    SERIES_HEX.forEach((hex, n) => {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(SERIES_COLORS[n]).toContain(hex);
    });
  });
});

describe('hueOf / withoutGreens — an alarm is never drawn in a green (R7-8)', () => {
  it("reads a colour's hue in degrees", () => {
    expect(hueOf('#ff0000')).toBe(0);
    expect(hueOf('#00ff00')).toBe(120);
    expect(hueOf('#0000ff')).toBe(240);
    // r 27, g 175, b 122: (122 - 27) / (175 - 27) + 2 sectors = 158.5 degrees.
    expect(hueOf('#1baf7a')).toBeCloseTo(158.5, 0);
    // A grey has no hue: never "green".
    expect(hueOf('#cad5e2')).toBeGreaterThan(200);
  });

  it('drops the greens by HUE — lime, green, emerald, teal — keeping the rest in order', () => {
    const palette = ['#2a78d6', '#84cc16', '#eda100', '#22c55e', '#00bc7d', '#14b8a6', '#e87ba4', '#0ea5e9'];
    expect(withoutGreens(palette)).toEqual(['#2a78d6', '#eda100', '#e87ba4', '#0ea5e9']);
  });

  it("the alarm palette is the series palette less its one green (#1baf7a), in order — not an index", () => {
    expect(ALARM_SERIES_HEX).toEqual(SERIES_HEX.filter((h) => h !== '#1baf7a'));
    expect(ALARM_SERIES_HEX).not.toContain('#1baf7a');
    expect(ALARM_SERIES_HEX).not.toContain(STATUS_HEX.OK);
    expect(ALARM_SERIES_HEX).toHaveLength(SERIES_HEX.length - 1);
  });
});

/**
 * Ruling F-I6 (final fix wave): the series palette's slot 3 (#1baf7a, 158.5°) is
 * the OK dot's emerald (160°), and a raw key on a comparison or bar chart took it
 * by default — a raw key drawn in "in limit" green. The DASHBOARD charts draw a
 * palette with that slot replaced, in place.
 */
describe('DASHBOARD_SERIES_HEX — no dashboard series is ever green (F-I6)', () => {
  it('no colour passes the green test', () => {
    for (const hex of DASHBOARD_SERIES_HEX) expect(isGreen(hex), hex).toBe(false);
    // The test itself bites: the series palette it replaces has its green.
    expect(SERIES_HEX.some(isGreen)).toBe(true);
  });

  it('six distinct colours, as many as the series caps allow', () => {
    expect(DASHBOARD_SERIES_HEX).toHaveLength(6);
    expect(new Set(DASHBOARD_SERIES_HEX.map((h) => h.toLowerCase())).size).toBe(6);
  });

  it("the green is replaced IN PLACE: every other slot is the series palette's, so a stored colour index keeps its meaning", () => {
    DASHBOARD_SERIES_HEX.forEach((hex, n) => {
      if (isGreen(SERIES_HEX[n])) expect(hex).not.toBe(SERIES_HEX[n]);
      else expect(hex).toBe(SERIES_HEX[n]);
    });
  });

  it('the substitute is no status colour and no other series colour, by hue as well as by value', () => {
    const sub = DASHBOARD_SERIES_HEX.find((h, n) => h !== SERIES_HEX[n])!;
    const others = [...DASHBOARD_SERIES_HEX.filter((h) => h !== sub), ...Object.values(STATUS_HEX)];
    for (const o of others) expect(sub.toLowerCase()).not.toBe(o.toLowerCase());
    // Not a hue the app reads as a verdict: not green, not the out-of-limit red (357°).
    const d = Math.abs(hueOf(sub) - hueOf(STATUS_HEX.OUT_OF_SPEC));
    expect(Math.min(d, 360 - d)).toBeGreaterThan(20);
  });

  it('the swatches a widget dialog shows are what that widget type draws', () => {
    expect(keyPaletteFor('comparison_bar')).toBe(DASHBOARD_SERIES_HEX);
    expect(keyPaletteFor('bar_chart')).toBe(DASHBOARD_SERIES_HEX);
    // The trend widget draws through the shared TimeSeriesChart, as the trend page does.
    expect(keyPaletteFor('trend_chart')).toBe(SERIES_COLORS);
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

describe('CHART_FONT_FAMILY', () => {
  it("is the page's own font stack (app.css --font-body), written out — ECharts measures text and cannot read var()", () => {
    const css = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'app.css'), 'utf-8');
    const body = /--font-body:\s*([^;]+);/.exec(css);
    expect(body).not.toBeNull();
    const norm = (stack: string) => stack.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, ''));
    expect(norm(CHART_FONT_FAMILY)).toEqual(norm(body![1]));
    expect(CHART_FONT_FAMILY).not.toContain('var(');
  });
});

describe('CHART_INK', () => {
  it("is the app's slate, and no grey a chart draws its chrome in is a verdict colour", () => {
    const verdicts = Object.entries(STATUS_HEX).filter(([k]) => k !== 'NOT_JUDGED').map(([, hex]) => hex.toLowerCase());
    for (const hex of Object.values(CHART_INK)) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(verdicts).not.toContain(hex.toLowerCase());
    }
  });
});
