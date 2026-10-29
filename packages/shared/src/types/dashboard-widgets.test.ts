import { describe, it, expect } from 'vitest';
import {
  customWidgetSchema, widgetsEqual, widgetItemId, widgetIdOf, isWidgetItem,
  WIDGET_TYPES, type CustomWidget,
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

describe('customWidgetSchema', () => {
  it('accepts one widget of each type', () => {
    for (const type of WIDGET_TYPES) {
      expect(customWidgetSchema.safeParse(widget({ type })).success).toBe(true);
    }
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
