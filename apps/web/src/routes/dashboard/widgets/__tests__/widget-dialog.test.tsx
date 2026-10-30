import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { WIDGET_TYPES, WIDGET_TYPE_SPECS, customWidgetSchema, type CustomWidget, type DataKeyInfo } from '@digilog/shared';

/** The gauge's own cap, from the registry (GAUGE_KEYS_MAX is not in the barrel). */
const GAUGE_KEYS_MAX = WIDGET_TYPE_SPECS.gauge.keysMax;

// Stable module-level objects only (fresh objects per call hang vitest).
const CATALOGUE: { keys: DataKeyInfo[]; loading: boolean } = {
  keys: [
    { source: 'telemetry', key: 't', label: 'Temperature', numeric: true, instruments: 3, lastSeen: '2026-10-28T10:00:00.000Z', measurement: { code: 'TEMPERATURE', name: 'Temperature', unit: '°C' } },
    { source: 'telemetry', key: 'p', label: 'p', numeric: true, instruments: 1, lastSeen: '2026-10-28T09:00:00.000Z', measurement: null },
    { source: 'telemetry', key: 'state', label: 'state', numeric: false, instruments: 1, lastSeen: '2026-10-28T09:00:00.000Z', measurement: null },
    { source: 'attribute', key: 'Location', label: 'Location', numeric: false, instruments: 3, lastSeen: null, measurement: null },
  ],
  loading: false,
};
const catalogueCalls: unknown[] = [];
vi.mock('../use-widget-data', () => ({
  useKeyCatalogue: (sel: unknown) => { catalogueCalls.push(sel); return CATALOGUE; },
}));
const SCOPE = {
  tree: [{ id: 'b1', name: 'Block 1', children: [{ id: 'a1', name: 'Area 1' }] }],
  blockId: '', areaId: '', scopeId: null, setBlock: () => {}, setArea: () => {}, areas: [],
  selected: null, setSelected: () => {},
  inScope: [{ id: '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b', code: 'CODE-1', name: 'One' }],
  chosen: [], overviewById: new Map(),
};
vi.mock('@/routes/data-report/use-history-scope', () => ({ useHistoryScope: () => SCOPE }));
vi.mock('../widget-panel', () => ({
  WidgetBody: ({ widget }: { widget: CustomWidget }) => <div data-testid="widget-preview">{widget.title}</div>,
}));
const FORMAT = { formatDateTime: (v: string) => `T:${v}` };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const ROLES = { data: [{ name: 'SUPER_ADMIN', displayName: 'Super Admin' }, { name: 'OPERATOR', displayName: 'Operator' }, { name: 'ADMIN', displayName: 'Admin' }] };
vi.mock('swr', () => ({ default: () => ROLES }));
const executed: { action: string; opts: Record<string, unknown> }[] = [];
const REAUTH = {
  execute: async (action: string, fn: (pw?: string) => Promise<void>, opts: Record<string, () => void>) => {
    executed.push({ action, opts });
    await fn(undefined);
    opts.onSuccess?.();
  },
  isOpen: false, password: '', error: '', isVerifying: false, setPassword: () => {}, confirm: () => {}, cancel: () => {},
};
vi.mock('@/hooks/use-reauth', () => ({ useReauth: () => REAUTH }));
const TOAST = { toast: { success: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));

import { WidgetDialog, WIDGET_OPTION_SECTIONS, type WidgetOptionSectionProps } from '../widget-dialog';
import { RoleDefaultDialog } from '../role-default-dialog';
import { KeyPicker } from '../key-picker';

const SEL = { functionalLocationId: 'fl1', directOnly: false };

/** A stand-in option section, registered by a test the way a later task registers its own. */
function TestTextSection({ widgetId, options, onChange }: WidgetOptionSectionProps) {
  return (
    <label>
      Card text
      <textarea name={`widget-text-${widgetId}`} value={options.text ?? ''} onChange={(e) => onChange({ text: e.target.value || undefined })} />
    </label>
  );
}

beforeEach(() => {
  catalogueCalls.length = 0;
  executed.length = 0;
});

const tick = (name: RegExp | string) => fireEvent.click(screen.getByRole('checkbox', { name }));

describe('WidgetDialog', () => {
  it('produces the widget JSON it shows', () => {
    const onSubmit = vi.fn();
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Value cards/ }));
    expect(screen.getByRole('radio', { name: 'Follow the dashboard selection' })).toHaveProperty('checked', true);
    tick('Temperature (t)');
    tick('Location (Location)');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Room temps' } });
    fireEvent.change(screen.getByLabelText('Label for t'), { target: { value: 'Temp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), type: 'value_cards', title: 'Room temps',
      source: { mode: 'selection' },
      keys: [{ source: 'telemetry', key: 't', label: 'Temp' }, { source: 'attribute', key: 'Location', label: 'Location' }],
      options: {},
    });
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
    // The catalogue is the dashboard selection's own.
    expect(catalogueCalls.at(-1)).toEqual({ functionalLocationId: 'fl1', directOnly: false });
  });

  it("asks for every instrument in view when the dashboard shows All Instruments", () => {
    render(<WidgetDialog open selection={{ directOnly: false }} onCancel={() => {}} onSubmit={() => {}} />);
    expect(catalogueCalls.at(-1)).toEqual({ all: true });
  });

  it('shows Time series and Attributes groups, with the Measured badge', () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    const series = screen.getByRole('group', { name: 'Time series' });
    expect(within(series).getByText('Measured · Temperature')).toBeTruthy();
    expect(within(series).getByRole('checkbox', { name: 'p (p)' })).toBeTruthy();
    const attrs = screen.getByRole('group', { name: 'Attributes' });
    expect(within(attrs).getByRole('checkbox', { name: 'Location (Location)' })).toBeTruthy();
    expect(within(attrs).queryByRole('checkbox', { name: 'Temperature (t)' })).toBeNull();
  });

  it('refuses an attribute key for a trend chart; warns about a text key, does not refuse it', () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Trend chart/ }));
    expect(screen.getByRole('checkbox', { name: 'Location (Location)' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Attributes have no history to plot')).toBeTruthy();
    const state = screen.getByRole('checkbox', { name: 'state (state)' });
    expect(state).toHaveProperty('disabled', false);
    expect(screen.getByText('No numeric reading lately')).toBeTruthy();
  });

  it('offers unit and decimals for a raw key only', () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    tick('Temperature (t)');
    tick('p (p)');
    expect(screen.getByLabelText('Unit for p')).toBeTruthy();
    expect(screen.getByLabelText('Decimals for p')).toBeTruthy();
    expect(screen.queryByLabelText('Unit for t')).toBeNull();
    expect(screen.queryByLabelText('Decimals for t')).toBeNull();
  });

  it('says what is wrong instead of submitting an invalid widget', () => {
    const onSubmit = vi.fn();
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    tick('p (p)');
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/title/i);
  });

  it('editing keeps the widget id and says Save widget', () => {
    const onSubmit = vi.fn();
    const initial: CustomWidget = {
      id: '7d3c8a52-3f0e-4b8e-9a51-2a3b4c5d6e7f', type: 'latest_table', title: 'Firmware',
      source: { mode: 'selection' }, keys: [{ source: 'attribute', key: 'Location', label: 'Location' }], options: {},
    };
    render(<WidgetDialog open initial={initial} selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Where' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save widget' }));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ id: initial.id, title: 'Where', type: 'latest_table' });
  });
});

describe('WidgetDialog - the alarm table', () => {
  it('the alarm table has no key step and submits keys []', () => {
    const onSubmit = vi.fn();
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} followLabel="Follow this dashboard" />);
    expect(screen.getByRole('radio', { name: 'Follow this dashboard' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Alarm table/ }));
    expect(screen.queryByRole('region', { name: 'Keys' })).toBeNull();
    expect(screen.queryByLabelText('Default period')).toBeNull();
    const status = screen.getByLabelText('Status') as HTMLSelectElement;
    expect(status.options[0].textContent).toBe('All statuses');
    expect(status.options).toHaveLength(5);
    fireEvent.change(status, { target: { value: 'active-unack' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Open alarms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w).toMatchObject({ type: 'alarm_table', keys: [], options: { status: 'active-unack' } });
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
  });
});

describe('RoleDefaultDialog', () => {
  it('offers every role but SUPER_ADMIN, asks for re-auth and declares onCancel', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<RoleDefaultDialog open onClose={onClose} onSave={onSave} />);
    const select = screen.getByLabelText('Role') as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value).filter(Boolean);
    expect(values).toEqual(['OPERATOR', 'ADMIN']);
    fireEvent.change(select, { target: { value: 'OPERATOR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as role default' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('OPERATOR', undefined));
    expect(executed[0].action).toBe('UPDATE_ROLE_CONFIG');
    expect(Object.keys(executed[0].opts).sort()).toEqual(['onCancel', 'onError', 'onSuccess']);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('WidgetDialog - the widget-type registry', () => {
  it('the type picker lists all fourteen types, in registry order', () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    const types = within(screen.getByRole('region', { name: 'Type' })).getAllByRole('button');
    expect(types.map((b) => b.querySelector('span')?.textContent)).toEqual([
      'Value cards', 'Latest values table', 'Trend chart', 'Time series table', 'Alarm table',
      'Gauge', 'Bar chart', 'Comparison bars', 'Pie chart', 'Alarm counts', 'Status grid',
      'Instrument list', 'Text card', 'Floor plan',
    ]);
    expect(types).toHaveLength(WIDGET_TYPES.length);
  });

  it('a type that takes no keys has no key step', () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole('region', { name: 'Keys' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Status grid/ }));
    expect(screen.queryByRole('region', { name: 'Keys' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Gauge/ }));
    expect(screen.getByRole('region', { name: 'Keys' })).toBeTruthy();
  });

  it('switching from a trend chart to a status grid DROPS its keys and period - cleared, not hidden', () => {
    const onSubmit = vi.fn();
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Trend chart/ }));
    tick('Temperature (t)');
    fireEvent.change(screen.getByLabelText('Default period'), { target: { value: '7d' } });
    expect(screen.getByLabelText('Label for t')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Status grid/ }));
    expect(screen.queryByLabelText('Default period')).toBeNull();
    expect(screen.queryByLabelText('Label for t')).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Health' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w.type).toBe('status_grid');
    expect(w.keys).toEqual([]);
    expect(w.options).toEqual({});
    expect(customWidgetSchema.safeParse(w).success).toBe(true);

    // Back on the trend chart nothing comes back: the switch cleared them.
    fireEvent.click(screen.getByRole('button', { name: /^Trend chart/ }));
    expect(screen.getByRole('checkbox', { name: 'Temperature (t)' })).toHaveProperty('checked', false);
    expect((screen.getByLabelText('Default period') as HTMLSelectElement).value).toBe('');
  });

  it('switching between two types that take the same keys keeps them; to a telemetry type drops the attributes', () => {
    const onSubmit = vi.fn();
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    tick('Temperature (t)');
    tick('Location (Location)');
    fireEvent.click(screen.getByRole('button', { name: /^Latest values table/ }));
    expect(screen.getByRole('checkbox', { name: 'Temperature (t)' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Location (Location)' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('button', { name: /^Bar chart/ }));
    expect(screen.getByRole('checkbox', { name: 'Temperature (t)' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Location (Location)' })).toHaveProperty('checked', false);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Bars' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w.keys).toEqual([{ source: 'telemetry', key: 't', label: 'Temperature' }]);
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
  });

  it('the bar chart follows the window: it offers the default period, which is saved', () => {
    const onSubmit = vi.fn();
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} periodFollowLabel="Dashboard window" />);
    fireEvent.click(screen.getByRole('button', { name: /^Bar chart/ }));
    const period = screen.getByLabelText('Default period') as HTMLSelectElement;
    expect(period.options[0].textContent).toBe('Dashboard window');
    fireEvent.change(period, { target: { value: '7d' } });
    tick('Temperature (t)');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Bars' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect((onSubmit.mock.calls[0][0] as CustomWidget).options).toEqual({ period: '7d' });
  });

  it('a type that shows the present offers no period', () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    for (const name of [/^Gauge/, /^Comparison bars/, /^Pie chart/, /^Alarm counts/, /^Instrument list/, /^Text card/, /^Floor plan/]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(screen.queryByLabelText('Default period')).toBeNull();
    }
  });

  it('the text card has no instruments step, and is stored following the selection', () => {
    const onSubmit = vi.fn();
    WIDGET_OPTION_SECTIONS.text_card = TestTextSection;
    try {
      render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Pick instruments' }));
      fireEvent.click(screen.getByRole('button', { name: /^Text card/ }));
      expect(screen.queryByRole('region', { name: 'Instruments' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Keys' })).toBeNull();
      fireEvent.change(screen.getByLabelText('Card text'), { target: { value: 'Shift handover at 06:00' } });
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Note' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
      const w = onSubmit.mock.calls[0][0] as CustomWidget;
      expect(w).toMatchObject({ type: 'text_card', source: { mode: 'selection' }, keys: [] });
      expect(w.options).toEqual({ text: 'Shift handover at 06:00' });
    } finally {
      delete WIDGET_OPTION_SECTIONS.text_card;
    }
  });

  it("a registered option section edits the widget's options; switching away drops what the new type refuses", () => {
    const onSubmit = vi.fn();
    WIDGET_OPTION_SECTIONS.text_card = TestTextSection;
    try {
      render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
      fireEvent.click(screen.getByRole('button', { name: /^Text card/ }));
      fireEvent.change(screen.getByLabelText('Card text'), { target: { value: 'Hello' } });
      fireEvent.click(screen.getByRole('button', { name: /^Status grid/ }));
      expect(screen.queryByLabelText('Card text')).toBeNull();
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Grid' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
      expect((onSubmit.mock.calls[0][0] as CustomWidget).options).toEqual({});
      // And it is gone, not hidden.
      fireEvent.click(screen.getByRole('button', { name: /^Text card/ }));
      expect((screen.getByLabelText('Card text') as HTMLTextAreaElement).value).toBe('');
    } finally {
      delete WIDGET_OPTION_SECTIONS.text_card;
    }
  });

  it('editing a widget keeps its stored options (the switch rule runs on a click, not on open)', () => {
    const onSubmit = vi.fn();
    const initial: CustomWidget = {
      id: '7d3c8a52-3f0e-4b8e-9a51-2a3b4c5d6e7f', type: 'trend_chart', title: 'Temps',
      source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 't', label: 'T' }], options: { period: '7d' },
    };
    render(<WidgetDialog open initial={initial} selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save widget' }));
    expect(onSubmit.mock.calls[0][0]).toEqual(initial);
  });

  it('starts with no option sections registered - later tasks fill the map', () => {
    expect(WIDGET_OPTION_SECTIONS).toEqual({});
  });
});

describe('KeyPicker - the type decides', () => {
  const MANY: DataKeyInfo[] = Array.from({ length: 7 }, (_, n) => ({
    source: 'telemetry' as const, key: `k${n}`, label: `k${n}`, numeric: true, instruments: 1, lastSeen: null, measurement: null,
  }));
  const chosen = (n: number) => MANY.slice(0, n).map((e) => ({ source: e.source, key: e.key, label: e.label }));

  it("caps at the type's keysMax", () => {
    render(<KeyPicker catalogue={MANY} chosen={chosen(GAUGE_KEYS_MAX)} onChange={() => {}} type="gauge" />);
    expect(screen.getByRole('checkbox', { name: 'k6 (k6)' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: 'k0 (k0)' })).toHaveProperty('disabled', false);
    expect(screen.getByText(`At most ${GAUGE_KEYS_MAX} keys on one widget.`)).toBeTruthy();
  });

  it('a phase 1 type keeps the phase 1 cap', () => {
    render(<KeyPicker catalogue={MANY} chosen={chosen(GAUGE_KEYS_MAX)} onChange={() => {}} type="value_cards" />);
    expect(screen.getByRole('checkbox', { name: 'k6 (k6)' })).toHaveProperty('disabled', false);
    expect(screen.queryByText(/^At most/)).toBeNull();
  });

  it('a bar chart refuses an attribute, with the reason', () => {
    render(<KeyPicker catalogue={CATALOGUE.keys} chosen={[]} onChange={() => {}} type="bar_chart" />);
    expect(screen.getByRole('checkbox', { name: 'Location (Location)' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Attributes have no history to plot')).toBeTruthy();
  });
});

describe('WidgetDialog - the history widget default period', () => {
  it('names "no period" as the SITE default on /, and as the dashboard window when told so', () => {
    const { unmount } = render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Trend chart/ }));
    expect((screen.getByLabelText('Default period') as HTMLSelectElement).options[0].textContent).toBe('Site default');
    unmount();
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} periodFollowLabel="Dashboard window" />);
    fireEvent.click(screen.getByRole('button', { name: /^Trend chart/ }));
    expect((screen.getByLabelText('Default period') as HTMLSelectElement).options[0].textContent).toBe('Dashboard window');
  });
});
