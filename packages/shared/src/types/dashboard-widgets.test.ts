import { describe, it, expect } from 'vitest';
import { PANEL_KEYS } from './panels.js';
import {
  customWidgetSchema, widgetsEqual, widgetItemId, widgetIdOf, isWidgetItem,
  WIDGET_TYPES, WIDGET_TYPE_SPECS, widgetPanelGate, GAUGES_SHOWN_MAX, BAR_SERIES_MAX, TEXT_CARD_MAX,
  TREND_SERIES_MAX, WIDGET_KEYS_MAX, GAUGE_KEYS_MAX, COMPARISON_KEYS_MAX, type CustomWidget,
} from './dashboard-widgets.js';

const ID = '7d3c8a52-3f0e-4b8e-9a51-2a3b4c5d6e7f';
const INSTRUMENT = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';

const widget = (over: Partial<CustomWidget> = {}): CustomWidget => ({
  id: ID,
  type: 'value_cards',
  title: 'Room pressures',
  source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 'p' }],
  options: {},
  ...over,
});

const issues = (v: unknown) => {
  const r = customWidgetSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

const PLAN = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const none = (type: CustomWidget['type'], options: CustomWidget['options'] = {}) => widget({ type, keys: [], options });
/** The smallest valid body of each type that is not the default value_cards fixture. */
const MINIMAL: Partial<Record<CustomWidget['type'], CustomWidget>> = {
  alarm_table: none('alarm_table'),
  pie_chart: none('pie_chart', { of: 'status' }),
  alarm_counts: none('alarm_counts'),
  status_grid: none('status_grid'),
  instrument_list: none('instrument_list'),
  text_card: none('text_card', { text: 'Hello' }),
  floorplan: none('floorplan', { planId: PLAN }),
};

describe('customWidgetSchema', () => {
  it('accepts one widget of each type', () => {
    for (const type of WIDGET_TYPES) {
      // An alarm table lists alarms, not keys (spec §5): its fixture carries none.
      const w = MINIMAL[type] ?? widget({ type });
      expect(customWidgetSchema.safeParse(w).success).toBe(true);
    }
  });

  it('accepts an alarm table with no keys and a status filter', () => {
    const r = customWidgetSchema.safeParse(widget({ type: 'alarm_table', keys: [], options: { status: 'active-unack' } }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.options.status).toBe('active-unack');
  });

  it('refuses an alarm table with a key, with a period, or a non-alarm widget with a status', () => {
    expect(issues(widget({ type: 'alarm_table' }))).toContain('An alarm table takes no keys');
    expect(issues(widget({ type: 'alarm_table', keys: [], options: { period: '24h' } }))).toContain('An alarm table has no period');
    expect(issues(widget({ options: { status: 'active-ack' } }))).toContain('Only an alarm table has a status filter');
  });

  it('still refuses a value_cards widget with no keys', () => {
    expect(issues(widget({ keys: [] }))).toContain('Choose at least one key');
  });

  it('accepts every optional field at its bounds', () => {
    const r = customWidgetSchema.safeParse(widget({
      source: { mode: 'instruments', ids: [INSTRUMENT] },
      keys: [{ source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa', decimals: 6, color: 5 }],
      options: { period: '24h', pageSize: 50 },
    }));
    expect(r.success).toBe(true);
  });

  it('refuses a blank title, too many keys or instruments, and out-of-range display settings', () => {
    expect(issues(widget({ title: '  ' }))).not.toHaveLength(0);
    expect(issues(widget({ keys: Array.from({ length: 21 }, (_, n) => ({ source: 'telemetry' as const, key: `k${n}` })) }))).not.toHaveLength(0);
    const ids = Array.from({ length: 51 }, (_, n) => `0b1c2d3e-4f50-4617-8a9b-${String(n).padStart(12, '0')}`);
    expect(issues(widget({ source: { mode: 'instruments', ids } }))).not.toHaveLength(0);
    expect(issues(widget({ keys: [{ source: 'telemetry', key: 'p', decimals: 7 }] }))).not.toHaveLength(0);
    expect(issues(widget({ keys: [{ source: 'telemetry', key: 'p', color: 6 }] }))).not.toHaveLength(0);
    expect(issues(widget({ options: { period: 'custom' as never } }))).not.toHaveLength(0);
    expect(issues(widget({ type: 'pie' as never }))).not.toHaveLength(0);
  });

  it('refuses the same key twice', () => {
    expect(issues(widget({ keys: [{ source: 'telemetry', key: 't' }, { source: 'telemetry', key: 't' }] })))
      .not.toHaveLength(0);
    // The same NAME under the other source is a different key.
    expect(issues(widget({ keys: [{ source: 'telemetry', key: 'Location' }, { source: 'attribute', key: 'Location' }] })))
      .toHaveLength(0);
  });

  it('refuses an attribute key on a trend chart, saying why', () => {
    expect(issues(widget({ type: 'trend_chart', keys: [{ source: 'attribute', key: 'Location' }] })))
      .toContain('Attributes have no history to plot');
    expect(issues(widget({ type: 'value_cards', keys: [{ source: 'attribute', key: 'Location' }] })))
      .toHaveLength(0);
    expect(issues(widget({ type: 'timeseries_table', keys: [{ source: 'attribute', key: 'Location' }] })))
      .toContain('Attributes have no history to list');
    expect(issues(widget({ type: 'latest_table', keys: [{ source: 'attribute', key: 'Location' }] })))
      .toHaveLength(0);
  });
});

describe('widgetsEqual', () => {
  it('ignores object-key order and treats absent as none', () => {
    const a = widget({ keys: [{ source: 'telemetry', key: 'p', label: 'P', unit: 'kPa' }] });
    const b = JSON.parse('{"options":{},"keys":[{"unit":"kPa","label":"P","key":"p","source":"telemetry"}],"source":{"mode":"selection"},"title":"Room pressures","type":"value_cards","id":"' + ID + '"}');
    expect(widgetsEqual([a], [b])).toBe(true);
    expect(widgetsEqual(undefined, [])).toBe(true);
  });

  it('sees a changed label', () => {
    expect(widgetsEqual([widget()], [widget({ title: 'Other' })])).toBe(false);
    expect(widgetsEqual([widget()], [])).toBe(false);
  });
});

describe('widget grid items', () => {
  it('names a widget item w:<id> and reads it back', () => {
    expect(widgetItemId(ID)).toBe(`w:${ID}`);
    expect(widgetIdOf(`w:${ID}`)).toBe(ID);
    expect(isWidgetItem(`w:${ID}`)).toBe(true);
  });

  it('does not take a panel key, or a w: prefix without an id, for a widget', () => {
    expect(widgetIdOf('telemetry_table')).toBeNull();
    expect(widgetIdOf('w:')).toBeNull();
    expect(widgetIdOf('w:not-a-uuid')).toBeNull();
    expect(isWidgetItem('custom_widgets')).toBe(false);
  });
});

describe('the widget-type registry', () => {
  it('appends the nine phase 2 types after the existing five, in order', () => {
    expect([...WIDGET_TYPES]).toEqual([
      'value_cards', 'latest_table', 'trend_chart', 'timeseries_table', 'alarm_table',
      'gauge', 'bar_chart', 'comparison_bar', 'pie_chart', 'alarm_counts', 'status_grid', 'instrument_list', 'text_card', 'floorplan',
    ]);
  });

  it('has a spec for every type, with keysMax within the schema cap', () => {
    for (const t of WIDGET_TYPES) {
      expect(WIDGET_TYPE_SPECS[t]).toBeDefined();
      expect(WIDGET_TYPE_SPECS[t].keysMax).toBeLessThanOrEqual(WIDGET_KEYS_MAX);
    }
    expect(GAUGES_SHOWN_MAX).toBe(24);
    expect(BAR_SERIES_MAX).toBe(TREND_SERIES_MAX);
    expect(TEXT_CARD_MAX).toBe(2000);
    expect(WIDGET_TYPE_SPECS.gauge.keysMax).toBe(GAUGE_KEYS_MAX);
    expect(WIDGET_TYPE_SPECS.comparison_bar.keysMax).toBe(COMPARISON_KEYS_MAX);
  });

  it('only ever names a panel that exists', () => {
    // PanelKey widens to string, so the compiler cannot catch a typo.
    for (const t of WIDGET_TYPES) {
      const panel = WIDGET_TYPE_SPECS[t].panel;
      if (typeof panel === 'string') expect(PANEL_KEYS).toContain(panel);
    }
    const pie = (of: 'status' | 'alarm_types') => widgetPanelGate(none('pie_chart', { of }));
    expect(PANEL_KEYS).toContain(pie('alarm_types'));
    expect(pie('status')).toBeNull();
  });

  it('records which types follow the dashboard window', () => {
    const follows = WIDGET_TYPES.filter((t) => WIDGET_TYPE_SPECS[t].followsWindow);
    expect(follows).toEqual(['trend_chart', 'timeseries_table', 'bar_chart']);
  });

  it('names the extra panel a widget needs', () => {
    expect(widgetPanelGate(widget())).toBeNull();
    expect(widgetPanelGate(none('alarm_table'))).toBe('dashboard_alarms');
    expect(widgetPanelGate(none('alarm_counts'))).toBe('dashboard_alarms');
    expect(widgetPanelGate(none('pie_chart', { of: 'alarm_types' }))).toBe('dashboard_alarms');
    expect(widgetPanelGate(none('pie_chart', { of: 'status' }))).toBeNull();
    expect(widgetPanelGate(none('floorplan', { planId: PLAN }))).toBe('telemetry_floorplan');
    expect(widgetPanelGate(none('status_grid'))).toBeNull();
  });
});

describe('the phase 2 widget types', () => {
  const k = (key: string, source: 'telemetry' | 'attribute' = 'telemetry') => ({ source, key });
  const six = Array.from({ length: 6 }, (_, n) => k(`k${n}`));
  const seven = Array.from({ length: 7 }, (_, n) => k(`k${n}`));

  it('parses each with a minimal valid body', () => {
    expect(issues(widget({ type: 'gauge' }))).toEqual([]);
    expect(issues(widget({ type: 'gauge', options: { min: 0, max: 100 } }))).toEqual([]);
    expect(issues(widget({ type: 'bar_chart' }))).toEqual([]);
    expect(issues(widget({ type: 'bar_chart', options: { period: '24h', bucket: 'hour', agg: 'avg', groupBy: 'instrument' } }))).toEqual([]);
    expect(issues(widget({ type: 'comparison_bar' }))).toEqual([]);
    expect(issues(none('pie_chart', { of: 'alarm_types' }))).toEqual([]);
    expect(issues(none('alarm_counts'))).toEqual([]);
    expect(issues(none('status_grid'))).toEqual([]);
    expect(issues(none('instrument_list', { pageSize: 25 }))).toEqual([]);
    expect(issues(none('text_card', { text: 'x'.repeat(2000) }))).toEqual([]);
    expect(issues(none('floorplan', { planId: PLAN }))).toEqual([]);
  });

  it('refuses an option outside its type', () => {
    expect(issues(widget({ type: 'gauge', options: { bucket: 'day' } }))).toContain('A gauge takes no bucket');
    expect(issues(widget({ type: 'comparison_bar', options: { period: '24h' } }))).toContain('A comparison bar takes no period');
    expect(issues(none('status_grid', { pageSize: 10 }))).toContain('A status grid takes no page size');
    expect(issues(none('alarm_counts', { status: 'active-ack' }))).toContain('An alarm counts widget takes no status filter');
    expect(issues(widget({ type: 'bar_chart', options: { min: 0, max: 5 } }))).toContain('A bar chart takes no scale minimum');
    expect(issues(none('text_card', { text: 'a', planId: PLAN }))).toContain('A text card takes no floor plan');
  });

  it('refuses keys on a type that takes none', () => {
    const opts: Record<string, CustomWidget['options']> = {
      pie_chart: { of: 'status' }, text_card: { text: 'a' }, floorplan: { planId: PLAN },
    };
    for (const type of ['pie_chart', 'alarm_counts', 'status_grid', 'instrument_list', 'text_card', 'floorplan'] as const) {
      expect(issues(widget({ type, options: opts[type] ?? {} }))).toHaveLength(1);
    }
    expect(issues(widget({ type: 'status_grid' }))).toContain('A status grid takes no keys');
  });

  it('needs at least one key on a keyed type', () => {
    for (const type of ['gauge', 'bar_chart', 'comparison_bar'] as const) {
      expect(issues(widget({ type, keys: [] }))).toContain('Choose at least one key');
    }
  });

  it('refuses an attribute key on a bar chart', () => {
    expect(issues(widget({ type: 'bar_chart', keys: [k('Location', 'attribute')] }))).toContain('Attributes have no history to plot');
    expect(issues(widget({ type: 'gauge', keys: [k('Location', 'attribute')] }))).toEqual([]);
    expect(issues(widget({ type: 'comparison_bar', keys: [k('Location', 'attribute')] }))).toEqual([]);
  });

  it('caps the keys of a gauge, a bar chart and a comparison bar at six', () => {
    for (const type of ['gauge', 'bar_chart', 'comparison_bar'] as const) {
      expect(issues(widget({ type, keys: six }))).toEqual([]);
      expect(issues(widget({ type, keys: seven }))).toContain('At most 6 keys');
    }
  });

  it('wants both bounds of a gauge or neither, and min below max', () => {
    expect(issues(widget({ type: 'gauge', options: { min: 0 } }))).toContain('Set both the minimum and the maximum, or neither');
    expect(issues(widget({ type: 'gauge', options: { max: 10 } }))).toContain('Set both the minimum and the maximum, or neither');
    expect(issues(widget({ type: 'gauge', options: { min: 5, max: 5 } }))).toContain('The minimum must be below the maximum');
    expect(issues(widget({ type: 'gauge', options: { min: 9, max: 5 } }))).toContain('The minimum must be below the maximum');
    expect(issues(widget({ type: 'gauge', options: { min: -1, max: 1 } }))).toEqual([]);
    expect(issues(widget({ type: 'gauge', options: { min: Number.NaN, max: 1 } }))).not.toHaveLength(0);
    expect(issues(widget({ type: 'gauge', options: { min: 0, max: Infinity } }))).not.toHaveLength(0);
  });

  it('refuses a bad bucket, aggregate, grouping or pie subject', () => {
    expect(issues(widget({ type: 'bar_chart', options: { bucket: 'month' as never } }))).not.toHaveLength(0);
    expect(issues(widget({ type: 'bar_chart', options: { agg: 'sum' as never } }))).not.toHaveLength(0);
    expect(issues(widget({ type: 'bar_chart', options: { groupBy: 'room' as never } }))).not.toHaveLength(0);
    expect(issues(none('pie_chart', { of: 'severity' as never }))).not.toHaveLength(0);
  });

  it('needs a pie to say what it shows', () => {
    expect(issues(none('pie_chart'))).toContain('Choose what the pie shows');
  });

  it('needs a text card to have text of 1 to 2000 characters, trimmed', () => {
    expect(issues(none('text_card'))).toContain("Write the card's text");
    expect(issues(none('text_card', { text: '' }))).toContain("Write the card's text");
    expect(issues(none('text_card', { text: '   ' }))).toContain("Write the card's text");
    expect(issues(none('text_card', { text: 'x'.repeat(2001) }))).not.toHaveLength(0);
    const r = customWidgetSchema.safeParse(none('text_card', { text: '  hi  ' }));
    expect(r.success && r.data.options.text).toBe('hi');
  });

  it('needs a floor plan to name a plan, by uuid', () => {
    expect(issues(none('floorplan'))).toContain('Choose a floor plan');
    expect(issues(none('floorplan', { planId: 'nope' }))).toContain('Not a floor plan id');
  });

  it('strips, never refuses, a phase 2 option on one of the old five', () => {
    const parsed = (w: CustomWidget) => {
      const r = customWidgetSchema.safeParse(w);
      return r.success ? r.data : null;
    };
    expect(parsed(widget({ options: { planId: PLAN } }))?.options).toEqual({});
    expect(parsed(none('alarm_table', { of: 'status', status: 'active-ack' }))?.options).toEqual({ status: 'active-ack' });
    expect(parsed(widget({ type: 'latest_table', options: { min: 9, max: 1 } }))?.options).toEqual({});
    expect(parsed(widget({ type: 'trend_chart', options: { period: '24h', bucket: 'day', agg: 'max', text: 'x' } }))?.options)
      .toEqual({ period: '24h' });
    // A new type keeps its own options.
    expect(parsed(widget({ type: 'gauge', options: { min: 1, max: 2 } }))?.options).toEqual({ min: 1, max: 2 });
  });

  it('a stored old widget compares equal to itself and to its stripped form', () => {
    const stored = widget({ options: { period: '24h' } });
    expect(widgetsEqual([stored], [stored])).toBe(true);
    expect(widgetsEqual([widget({ options: { planId: PLAN } })], [widget()])).toBe(true);
  });

  it('keeps the old five accepting what they always did', () => {
    // Options the old schema never policed stay unpoliced on the old types.
    expect(issues(widget({ options: { period: '24h', pageSize: 10 } }))).toEqual([]);
    expect(issues(widget({ type: 'latest_table', options: { period: '24h' } }))).toEqual([]);
    expect(issues(widget({ type: 'trend_chart', options: { pageSize: 25 } }))).toEqual([]);
    expect(issues(none('alarm_table', { pageSize: 10, status: 'cleared-ack' }))).toEqual([]);
    expect(issues(widget({ keys: Array.from({ length: WIDGET_KEYS_MAX }, (_, n) => k(`k${n}`)) }))).toEqual([]);
  });
});
