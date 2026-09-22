import { describe, it, expect } from 'vitest';
import { hiddenPanelsFor, READING_PANELS } from '../view-panels';

/**
 * The Tabular | Graphical toggle hides panels; it never deletes them. This pins
 * WHICH panels each view hides — in particular that the alarms widget leaves
 * with the table when Graphical is chosen (operator, 2026-09-22: "in graphical
 * view dont show the alarm widget"), which it did not before that day.
 */
describe('hiddenPanelsFor', () => {
  it('Tabular hides only the floorplan', () => {
    const hidden = hiddenPanelsFor('table', true);
    expect([...hidden]).toEqual([READING_PANELS.graphical]);
  });

  it('Graphical hides the table AND the alarms widget', () => {
    const hidden = hiddenPanelsFor('graphical', true);
    expect(hidden.has(READING_PANELS.table)).toBe(true);
    expect(hidden.has('dashboard_alarms')).toBe(true);
    expect(hidden.has(READING_PANELS.graphical)).toBe(false);
  });

  it('the trend is shown in both views', () => {
    expect(hiddenPanelsFor('table', true).has('dashboard_trend')).toBe(false);
    expect(hiddenPanelsFor('graphical', true).has('dashboard_trend')).toBe(false);
  });

  it('with no toggle nothing is hidden, whatever the URL says', () => {
    expect(hiddenPanelsFor('graphical', false).size).toBe(0);
    expect(hiddenPanelsFor('table', false).size).toBe(0);
  });
});
