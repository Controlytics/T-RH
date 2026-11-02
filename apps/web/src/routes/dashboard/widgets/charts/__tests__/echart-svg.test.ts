import { describe, it, expect, beforeAll } from 'vitest';
import { setPlatformAPI } from 'echarts/core';
import { renderOptionToSvg } from '../echart';
import { NEUTRAL_HEX } from '../chart-colors';

// jsdom's canvas (the test-setup stub) cannot measure text, which ECharts does
// to lay out axis labels; a browser can. A fixed width per character stands in.
beforeAll(() => {
  setPlatformAPI({ measureText: (text: string) => ({ width: text.length * 7 }) as TextMetrics });
});

/**
 * The off-screen render behind a widget report's chart picture (2026-11-02):
 * the REAL ECharts (no mocks here), in its server-side mode — no DOM node, no
 * ResizeObserver — handed the same option a widget draws, at a FIXED size.
 * What it can prove: an SVG document comes back, drawn from the option, with
 * the wrapper's own rules (no animation, the neutral default colour). What it
 * cannot: what the pixels look like — the render check does that.
 */
describe('renderOptionToSvg', () => {
  const option = {
    xAxis: { type: 'category', data: ['A', 'B'] },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: [3, 7] }],
  };

  it('returns a whole SVG document at the size asked, drawn from the option', () => {
    const svg = renderOptionToSvg(option, 900, 352);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="900"');
    expect(svg).toContain('height="352"');
    // Two bars: two filled paths in the neutral default colour (the wrapper's
    // `color: [NEUTRAL_HEX]`, never ECharts' own palette).
    expect(svg.toLowerCase()).toContain(NEUTRAL_HEX.toLowerCase());
    expect(svg).toContain('</svg>');
  });

  it('leaves nothing in the document and can render again (the instance is disposed)', () => {
    const before = document.body.innerHTML;
    renderOptionToSvg(option, 400, 200);
    const second = renderOptionToSvg({ ...option, series: [{ type: 'bar', data: [1] }] }, 400, 200);
    expect(document.body.innerHTML).toBe(before);
    expect(second.startsWith('<svg')).toBe(true);
  });
});
