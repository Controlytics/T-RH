import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { TEXT_CARD_MAX, WIDGET_TYPES, WIDGET_TYPE_SPECS, customWidgetSchema, type CustomWidget, type DataKeyInfo } from '@digilog/shared';

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
const PLAN_QC = '11111111-aaaa-4aaa-8aaa-111111111111';
const PLAN_MF = '22222222-aaaa-4aaa-8aaa-222222222222';
const FLOORPLANS: { plans: { id: string; name: string }[]; isLoading: boolean; error: unknown } = {
  plans: [{ id: PLAN_QC, name: 'CWH — QC' }, { id: PLAN_MF, name: 'CWH — Module-F — Ground Floor' }],
  isLoading: false,
  error: undefined,
};
vi.mock('../../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../../use-telemetry')>()),
  useFloorplans: () => FLOORPLANS,
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

import { WidgetDialog, WIDGET_OPTION_SECTIONS } from '../widget-dialog';
import { DASHBOARD_SERIES_HEX, isGreen } from '../charts/chart-colors';
import { RoleDefaultDialog } from '../role-default-dialog';
import { KeyPicker } from '../key-picker';
import { WIDGET_PAGE_SIZE_DEFAULT, widgetPageSize } from '../type-switch';

const SEL = { functionalLocationId: 'fl1', directOnly: false };

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

  it("Rows per page names the renderer's own default - the ONE constant both read", () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    for (const [name, type] of [[/^Latest values table/, 'latest_table'], [/^Time series table/, 'timeseries_table'], [/^Instrument list/, 'instrument_list']] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      const select = screen.getByLabelText('Rows per page') as HTMLSelectElement;
      expect(select.options[0].textContent).toBe(String(WIDGET_PAGE_SIZE_DEFAULT[type]));
      expect(widgetPageSize({ type, options: {} })).toBe(WIDGET_PAGE_SIZE_DEFAULT[type]);
      expect(widgetPageSize({ type, options: { pageSize: 50 } })).toBe(50);
    }
    expect(WIDGET_PAGE_SIZE_DEFAULT.instrument_list).toBe(10);
    expect(WIDGET_PAGE_SIZE_DEFAULT.latest_table).toBe(25);
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
  });

  it("a registered option section edits the widget's options; switching away drops what the new type refuses", () => {
    const onSubmit = vi.fn();
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

  it('registers exactly the option sections that have landed - each widget task adds its own', () => {
    expect(Object.keys(WIDGET_OPTION_SECTIONS)).toEqual(['gauge', 'bar_chart', 'pie_chart', 'text_card', 'floorplan']);
  });

  it('the title box has a name of its own', () => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.getByLabelText('Title').getAttribute('name')).toBe('widget-title');
  });
});

describe('WidgetDialog - the text card', () => {
  const openText = (onSubmit = vi.fn()) => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Text card/ }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Note' } });
    return onSubmit;
  };
  const counter = () => screen.getByTestId('widget-text-count');

  it(`a textarea named widget-text, its count against the schema's ${TEXT_CARD_MAX}`, () => {
    openText();
    const box = screen.getByLabelText('Card text') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.getAttribute('name')).toBe('widget-text');
    expect(counter().textContent).toBe(`0 / ${TEXT_CARD_MAX}`);
    fireEvent.change(box, { target: { value: 'Shift handover\nat 06:00' } });
    expect(counter().textContent).toBe(`23 / ${TEXT_CARD_MAX}`);
    // No cap on the box itself: a paste over the limit is never cut silently.
    expect(box.getAttribute('maxlength')).toBeNull();
  });

  it('over the limit the count says so and Add refuses in the schema\'s words', () => {
    const onSubmit = openText();
    fireEvent.change(screen.getByLabelText('Card text'), { target: { value: 'x'.repeat(TEXT_CARD_MAX + 1) } });
    expect(counter().textContent).toBe(`${TEXT_CARD_MAX + 1} / ${TEXT_CARD_MAX}`);
    expect(counter().className).toContain('text-red-700');
    expect(screen.getByLabelText('Card text').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(`The text must be ${TEXT_CARD_MAX} characters or fewer`);
    // At the limit it is accepted.
    fireEvent.change(screen.getByLabelText('Card text'), { target: { value: 'x'.repeat(TEXT_CARD_MAX) } });
    expect(counter().className).not.toContain('text-red-700');
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect((onSubmit.mock.calls[0][0] as CustomWidget).options.text).toHaveLength(TEXT_CARD_MAX);
  });

  it('M-3: the count is the TRIMMED length, as the schema counts — trailing spaces past the cap are no problem', () => {
    const onSubmit = openText();
    fireEvent.change(screen.getByLabelText('Card text'), { target: { value: `  ${'x'.repeat(TEXT_CARD_MAX)}   \n` } });
    expect(counter().textContent).toBe(`${TEXT_CARD_MAX} / ${TEXT_CARD_MAX}`);
    expect(counter().className).not.toContain('text-red-700');
    expect(screen.getByLabelText('Card text').getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect((onSubmit.mock.calls[0][0] as CustomWidget).options.text).toHaveLength(TEXT_CARD_MAX);
  });

  it('no text is refused in the schema\'s words', () => {
    const onSubmit = openText();
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe("Write the card's text");
  });

  it('editing a text card shows its stored text and keeps it', () => {
    const onSubmit = vi.fn();
    const initial: CustomWidget = {
      id: '5a1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5c', type: 'text_card', title: 'Note',
      source: { mode: 'selection' }, keys: [], options: { text: 'Line 1\nLine 2' },
    };
    render(<WidgetDialog open initial={initial} selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    expect((screen.getByLabelText('Card text') as HTMLTextAreaElement).value).toBe('Line 1\nLine 2');
    fireEvent.click(screen.getByRole('button', { name: 'Save widget' }));
    expect(onSubmit.mock.calls[0][0]).toEqual(initial);
  });
});

describe('WidgetDialog - the floor plan', () => {
  const openPlan = (onSubmit = vi.fn()) => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Floor plan/ }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'QC floor' } });
    return onSubmit;
  };

  it('picks one of the plans the server lists; none is chosen until one is', () => {
    const onSubmit = openPlan();
    const select = screen.getByLabelText('Floor plan') as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Choose a floor plan'], [PLAN_QC, 'CWH — QC'], [PLAN_MF, 'CWH — Module-F — Ground Floor'],
    ]);
    expect(select.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Choose a floor plan');
    fireEvent.change(select, { target: { value: PLAN_MF } });
    // The preview scrolls a width-fitted plan as its card does, and is the
    // positioned box a "not available" message centres in.
    expect(screen.getByTestId('widget-preview').parentElement!.className.split(/\s+/))
      .toEqual(expect.arrayContaining(['relative', 'max-h-[30rem]', 'min-h-[12rem]', 'overflow-y-auto']));
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w).toMatchObject({ type: 'floorplan', keys: [], options: { planId: PLAN_MF } });
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
  });

  it('a stored plan that is gone is shown as gone, not as another plan', () => {
    const gone = '33333333-aaaa-4aaa-8aaa-333333333333';
    const initial: CustomWidget = {
      id: '5a1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5d', type: 'floorplan', title: 'Old floor',
      source: { mode: 'selection' }, keys: [], options: { planId: gone },
    };
    render(<WidgetDialog open initial={initial} selection={SEL} onCancel={() => {}} onSubmit={() => {}} />);
    const select = screen.getByLabelText('Floor plan') as HTMLSelectElement;
    expect(select.value).toBe(gone);
    expect(select.selectedOptions[0].textContent).toBe('This floor plan is not available.');
  });
});

describe('WidgetDialog - what the pie shows', () => {
  const openPie = (onSubmit = vi.fn()) => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Pie chart/ }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Health' } });
    return onSubmit;
  };

  it('offers "Instrument status" and "Active alarms by type", neither chosen until one is — what is shown is what is stored', () => {
    const onSubmit = openPie();
    const group = screen.getByRole('radiogroup', { name: 'The pie shows' });
    const choices = within(group).getAllByRole('radio');
    expect(choices.map((r) => r.closest('label')?.textContent)).toEqual(['Instrument status', 'Active alarms by type']);
    expect(choices.map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    // One name for the pair, distinct to this widget.
    expect(new Set(choices.map((r) => r.getAttribute('name'))).size).toBe(1);
    expect(choices[0].getAttribute('name')).toMatch(/^widget-pie-of-[0-9a-f-]{36}$/);
    // Unchosen, the schema's own words — no silent default.
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Choose what the pie shows');
  });

  it('the subject chosen is the option saved', () => {
    const onSubmit = openPie();
    fireEvent.click(screen.getByRole('radio', { name: 'Active alarms by type' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w).toMatchObject({ type: 'pie_chart', keys: [], options: { of: 'alarm_types' } });
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
  });

  it('editing a pie shows its stored subject chosen, and keeps it', () => {
    const onSubmit = vi.fn();
    const initial: CustomWidget = {
      id: '5a1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b', type: 'pie_chart', title: 'Health',
      source: { mode: 'selection' }, keys: [], options: { of: 'status' },
    };
    render(<WidgetDialog open initial={initial} selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    expect(screen.getByRole('radio', { name: 'Instrument status' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Save widget' }));
    expect(onSubmit.mock.calls[0][0]).toEqual(initial);
  });

  it('switching away drops the subject the next type refuses', () => {
    const onSubmit = openPie();
    fireEvent.click(screen.getByRole('radio', { name: 'Instrument status' }));
    fireEvent.click(screen.getByRole('button', { name: /^Status grid/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect((onSubmit.mock.calls[0][0] as CustomWidget).options).toEqual({});
  });
});

describe('WidgetDialog - the bar chart options', () => {
  const openBars = (onSubmit = vi.fn()) => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Bar chart/ }));
    tick('Temperature (t)');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Bars' } });
    return onSubmit;
  };
  const optionsOf = (label: string) =>
    [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => [o.value, o.textContent]);

  it('offers Bucket, Value and Show, each with its own name, set to the defaults', () => {
    openBars();
    expect(optionsOf('Bucket')).toEqual([['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']]);
    expect(optionsOf('Value')).toEqual([['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum'], ['count', 'Reading count']]);
    expect(optionsOf('Show')).toEqual([['all', 'All instruments combined'], ['instrument', 'Each instrument']]);
    const names = ['Bucket', 'Value', 'Show'].map((l) => (screen.getByLabelText(l) as HTMLSelectElement).name);
    expect(names[0]).toMatch(/^widget-bar-bucket-[0-9a-f-]{36}$/);
    expect(names[1]).toMatch(/^widget-bar-agg-[0-9a-f-]{36}$/);
    expect(names[2]).toMatch(/^widget-bar-group-[0-9a-f-]{36}$/);
    expect((screen.getByLabelText('Bucket') as HTMLSelectElement).value).toBe('hour');
    expect((screen.getByLabelText('Value') as HTMLSelectElement).value).toBe('avg');
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('all');
  });

  it('saves only the options a bar chart takes, and the shared schema accepts them', () => {
    const onSubmit = openBars();
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'day' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'count' } });
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'instrument' } });
    fireEvent.change(screen.getByLabelText('Default period'), { target: { value: '7d' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w.type).toBe('bar_chart');
    expect(w.options).toEqual({ bucket: 'day', agg: 'count', groupBy: 'instrument', period: '7d' });
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
  });

  it.each([
    ['Bucket', 'week', { bucket: 'week' }],
    ['Value', 'min', { agg: 'min' }],
    ['Show', 'instrument', { groupBy: 'instrument' }],
  ] as const)('%s writes its own option and nothing else', (label, value, expected) => {
    const onSubmit = openBars();
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect((onSubmit.mock.calls[0][0] as CustomWidget).options).toEqual(expected);
  });

  it('F-I6: its colour swatches show what a bar chart draws — the third is the dashboard palette, never the green', () => {
    openBars();
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    DASHBOARD_SERIES_HEX.forEach((hex, n) => {
      expect((screen.getByRole('button', { name: `Colour ${n + 1} for t` }) as HTMLElement).style.background).toBe(rgb(hex));
    });
    expect(isGreen(DASHBOARD_SERIES_HEX[2])).toBe(false);
  });

  it('an untouched bar chart saves no options — the renderer reads the same defaults', () => {
    const onSubmit = openBars();
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect((onSubmit.mock.calls[0][0] as CustomWidget).options).toEqual({});
  });

  it('editing a bar chart shows its stored options', () => {
    const initial: CustomWidget = {
      id: '7d3c8a52-3f0e-4b8e-9a51-2a3b4c5d6e7f', type: 'bar_chart', title: 'Bars',
      source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 't' }], options: { bucket: 'week', agg: 'min', groupBy: 'instrument' },
    };
    const onSubmit = vi.fn();
    render(<WidgetDialog open initial={initial} selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    expect((screen.getByLabelText('Bucket') as HTMLSelectElement).value).toBe('week');
    expect((screen.getByLabelText('Value') as HTMLSelectElement).value).toBe('min');
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('instrument');
    fireEvent.click(screen.getByRole('button', { name: 'Save widget' }));
    expect(onSubmit.mock.calls[0][0]).toEqual(initial);
  });

  it('switching to a trend chart drops what a trend chart does not take, and keeps the period', () => {
    const onSubmit = openBars();
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'week' } });
    fireEvent.change(screen.getByLabelText('Default period'), { target: { value: '30d' } });
    fireEvent.click(screen.getByRole('button', { name: /^Trend chart/ }));
    expect(screen.queryByLabelText('Bucket')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w.type).toBe('trend_chart');
    expect(w.options).toEqual({ period: '30d' });
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
  });
});

describe('WidgetDialog - the gauge scale', () => {
  const HEADING = 'Scale for keys the server does not judge';
  /** The shared schema's own words, read from it rather than retyped. */
  const schemaMessage = (options: CustomWidget['options']) => {
    const r = customWidgetSchema.safeParse({
      id: '7d3c8a52-3f0e-4b8e-9a51-2a3b4c5d6e7f', type: 'gauge', title: 'G', source: { mode: 'selection' },
      keys: [{ source: 'telemetry', key: 't' }], options,
    });
    return r.success ? null : r.error.issues[0].message;
  };
  const openGauge = (onSubmit = vi.fn()) => {
    render(<WidgetDialog open selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Gauge/ }));
    tick('Temperature (t)');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Dials' } });
    return onSubmit;
  };

  it('offers Scale minimum and Scale maximum under its heading, each with its own name', () => {
    openGauge();
    const group = screen.getByRole('group', { name: HEADING });
    const min = within(group).getByLabelText('Scale minimum') as HTMLInputElement;
    const max = within(group).getByLabelText('Scale maximum') as HTMLInputElement;
    expect(min.type).toBe('number');
    expect(min.name).toMatch(/^widget-gauge-min-[0-9a-f-]{36}$/);
    expect(max.name).toMatch(/^widget-gauge-max-[0-9a-f-]{36}$/);
    expect(min.name).not.toBe(max.name);
  });

  it('saves the scale it was given', () => {
    const onSubmit = openGauge();
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '-5' } });
    fireEvent.change(screen.getByLabelText('Scale maximum'), { target: { value: '10.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w.options).toEqual({ min: -5, max: 10.5 });
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
  });

  it("one end without the other: the shared schema's words, under the empty field, and nothing is saved", () => {
    const onSubmit = openGauge();
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '0' } });
    const words = schemaMessage({ min: 0 });
    expect(words).toBe('Set both the minimum and the maximum, or neither');
    const max = screen.getByLabelText('Scale maximum');
    expect(max.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(max.getAttribute('aria-describedby')!)!.textContent).toBe(words);
    expect(screen.getByLabelText('Scale minimum').getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a minimum not below the maximum: the shared schema's words, under the minimum", () => {
    const onSubmit = openGauge();
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Scale maximum'), { target: { value: '10' } });
    const words = schemaMessage({ min: 10, max: 10 });
    expect(words).toBe('The minimum must be below the maximum');
    const min = screen.getByLabelText('Scale minimum');
    expect(min.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(min.getAttribute('aria-describedby')!)!.textContent).toBe(words);
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clearing both leaves no scale; an untouched gauge saves none', () => {
    const onSubmit = openGauge();
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Scale maximum'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Scale maximum'), { target: { value: '' } });
    expect(screen.queryByText('Set both the minimum and the maximum, or neither')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect((onSubmit.mock.calls[0][0] as CustomWidget).options).toEqual({});
  });

  it('editing a gauge shows its stored scale', () => {
    const initial: CustomWidget = {
      id: '7d3c8a52-3f0e-4b8e-9a51-2a3b4c5d6e7f', type: 'gauge', title: 'Dials',
      source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 'p' }], options: { min: 0, max: 250 },
    };
    const onSubmit = vi.fn();
    render(<WidgetDialog open initial={initial} selection={SEL} onCancel={() => {}} onSubmit={onSubmit} />);
    expect((screen.getByLabelText('Scale minimum') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('Scale maximum') as HTMLInputElement).value).toBe('250');
    fireEvent.click(screen.getByRole('button', { name: 'Save widget' }));
    expect(onSubmit.mock.calls[0][0]).toEqual(initial);
  });

  it('switching to comparison bars drops the scale - it has none', () => {
    const onSubmit = openGauge();
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Scale maximum'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /^Comparison bars/ }));
    expect(screen.queryByRole('group', { name: HEADING })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const w = onSubmit.mock.calls[0][0] as CustomWidget;
    expect(w.type).toBe('comparison_bar');
    expect(w.options).toEqual({});
    expect(customWidgetSchema.safeParse(w).success).toBe(true);
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

  it.each(['trend_chart', 'bar_chart', 'gauge', 'comparison_bar'] as const)(
    'a %s flags a key with no numeric reading lately, and still offers it',
    (type) => {
      render(<KeyPicker catalogue={CATALOGUE.keys} chosen={[]} onChange={() => {}} type={type} />);
      expect(screen.getByText('No numeric reading lately')).toBeTruthy();
      expect(screen.getByRole('checkbox', { name: 'state (state)' })).toHaveProperty('disabled', false);
    },
  );

  it('a table does not flag a text key', () => {
    render(<KeyPicker catalogue={CATALOGUE.keys} chosen={[]} onChange={() => {}} type="latest_table" />);
    expect(screen.queryByText('No numeric reading lately')).toBeNull();
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
