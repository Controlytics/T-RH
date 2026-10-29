import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { customWidgetSchema, type CustomWidget, type DataKeyInfo } from '@digilog/shared';

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

import { WidgetDialog } from '../widget-dialog';
import { RoleDefaultDialog } from '../role-default-dialog';

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
