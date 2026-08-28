import { describe, it, expect } from 'vitest';
import { showPanelFrom } from '../use-panels';

/**
 * The pure half of the hook. The hook itself is one SWR call; this is the rule,
 * and the rule is what can be wrong.
 */
describe('showPanelFrom', () => {
  it('shows everything while the config is still loading', () => {
    // Deliberate: flashing the panels away and back on every page load is worse
    // than a moment of over-showing, and hiding everything until the fetch lands
    // makes a slow network look like a broken dashboard. Safe because this is a
    // display preference — instrument_scope is what withholds data.
    expect(showPanelFrom(undefined, 'trend_charts')).toBe(true);
  });

  it('shows everything when the resolution is null', () => {
    expect(showPanelFrom(null, 'trend_charts')).toBe(true);
  });

  it('shows nothing when the list is empty', () => {
    expect(showPanelFrom([], 'trend_charts')).toBe(false);
  });

  it('shows only listed panels', () => {
    expect(showPanelFrom(['trend_charts'], 'trend_charts')).toBe(true);
    expect(showPanelFrom(['trend_charts'], 'trend_alarms')).toBe(false);
  });
});
