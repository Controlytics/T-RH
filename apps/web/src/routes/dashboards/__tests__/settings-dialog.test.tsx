import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { DashboardDetail } from '@digilog/shared';

/**
 * The dashboard Settings dialog (2026-10-29, dashboard builder phase 1, Task 8).
 * What it sends is asserted on the PUT body: the exact `source` JSON per mode,
 * `expectedUpdatedAt`, and that nothing is sent when the form is refused.
 * NOT VERIFIED HERE: how it looks.
 */

const INST_A = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const INST_B = '1b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const PROFILE = '44444444-4444-4444-8444-000000000001';
const BLOCK = '66666666-6666-4666-8666-000000000001';
const AREA = '66666666-6666-4666-8666-000000000002';
const W1 = '11111111-1111-4111-8111-000000000001';

const SCOPE = {
  tree: [{ id: BLOCK, name: 'Block 1', children: [{ id: AREA, name: 'Area 1' }] }],
  blockId: '', areaId: '', scopeId: null, setBlock: () => {}, setArea: () => {}, areas: [],
  selected: null, setSelected: () => {},
  inScope: [{ id: INST_A, code: 'CODE-A', name: 'A' }, { id: INST_B, code: 'CODE-B', name: 'B' }],
  chosen: [], overviewById: new Map(),
};
vi.mock('@/routes/data-report/use-history-scope', () => ({ useHistoryScope: () => SCOPE }));

const PROFILES = { data: [{ id: PROFILE, name: 'Pressure Sensors' }] };
const NOTHING = { data: undefined, error: undefined, isLoading: false };
const WITH_PROFILES = { data: PROFILES, error: undefined, isLoading: false };
vi.mock('swr', () => ({
  default: (key: string | null) => (key === '/api/instrument-profiles' ? WITH_PROFILES : NOTHING),
}));
const FORMAT = { formatDateTime: (v: string) => `T:${v}`, config: { timezone: 'UTC' } };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const TOAST = { toast: { success: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));
const reauthActions: string[] = [];
const REAUTH = {
  execute: async (
    action: string,
    cb: (p?: string) => Promise<void>,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
  ) => {
    reauthActions.push(action);
    try { await cb(); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
  },
  isOpen: false, password: '', error: '', isVerifying: false,
  setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
};
vi.mock('@/hooks/use-reauth', () => ({ useReauth: () => REAUTH }));
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => put(...a), putWithReauth: vi.fn() },
}));

const { SettingsDialog } = await import('../settings-dialog');

const DASH: DashboardDetail = {
  id: 'd-1', title: 'QC Block', description: 'Dissolution rooms',
  sourceSummary: { mode: 'all', label: 'All instruments' }, widgetCount: 1,
  updatedAt: '2026-10-29T10:00:00.000Z',
  document: {
    version: 1,
    source: { mode: 'all' },
    timeWindow: { mode: 'relative', period: '24h' },
    items: [{ i: `w:${W1}`, x: 0, y: 0, w: 6, h: 5 }],
    widgets: [{ id: W1, type: 'value_cards', title: 'Cards', source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 't' }], options: {} }],
  },
};
const UNREADABLE: DashboardDetail = { ...DASH, document: { ...DASH.document, source: null } };
const SAVED = { ...DASH, updatedAt: '2026-10-29T11:00:00.000Z', title: 'Renamed' };

function mount(dashboard = DASH) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onReload = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog open dashboard={dashboard} onClose={onClose} onSaved={onSaved} onReload={onReload} />);
  return { onClose, onSaved, onReload };
}
type Sent = { title: string; description: string | null; document: DashboardDetail['document']; expectedUpdatedAt: string };
const sent = (n = 0) => put.mock.calls[n][1] as Sent;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('SettingsDialog', () => {
  beforeEach(() => {
    put.mockReset().mockResolvedValue(SAVED);
    reauthActions.length = 0;
    TOAST.toast.success.mockReset(); TOAST.toast.error.mockReset();
  });

  it('starts from the stored dashboard', () => {
    mount();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('QC Block');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Dissolution rooms');
    expect(screen.getByRole('radio', { name: 'All instruments' })).toBeChecked();
    expect(screen.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('All instruments sends {mode:all}, keeps the widgets, and sends expectedUpdatedAt through UPDATE_DASHBOARD', async () => {
    const { onSaved } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed' } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SAVED));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe('/api/dashboards/d-1');
    expect(sent()).toEqual({
      title: 'Renamed', description: 'Dissolution rooms',
      document: { ...DASH.document, source: { mode: 'all' }, timeWindow: { mode: 'relative', period: '24h' } },
      expectedUpdatedAt: '2026-10-29T10:00:00.000Z',
    });
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
  });

  it('A profile sends {mode:profile, profileId}', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'A profile' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Profile' }), { target: { value: PROFILE } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(sent().document.source).toEqual({ mode: 'profile', profileId: PROFILE });
  });

  it('A location sends the Area when one is chosen, else the Block, with Direct only', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'A location' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Block' }), { target: { value: BLOCK } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(sent().document.source).toEqual({ mode: 'location', functionalLocationId: BLOCK, directOnly: false });

    fireEvent.change(screen.getByRole('combobox', { name: 'Area' }), { target: { value: AREA } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Direct only' }));
    save();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(sent(1).document.source).toEqual({ mode: 'location', functionalLocationId: AREA, directOnly: true });
  });

  it('A location with no Block chosen is refused in place and sends nothing', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'A location' }));
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a location id');
    expect(put).not.toHaveBeenCalled();
  });

  it('Pick instruments sends the ticked ids; none ticked shows zod\'s message and sends nothing', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Pick instruments' }));
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one instrument');
    expect(put).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'CODE-B' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'CODE-A' }));
    save();
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(sent().document.source).toEqual({ mode: 'instruments', ids: [INST_B, INST_A] });
  });

  it('a stored instruments source starts ticked', () => {
    mount({ ...DASH, document: { ...DASH.document, source: { mode: 'instruments', ids: [INST_A] } } });
    expect(screen.getByRole('radio', { name: 'Pick instruments' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'CODE-A' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'CODE-B' })).not.toBeChecked();
  });

  it('the default time window is sent: a preset', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    save();
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(sent().document.timeWindow).toEqual({ mode: 'relative', period: '7d' });
  });

  it('a custom window ending before it starts is refused in place: nothing is written, and Save still sends the previous valid window', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(document.querySelector('[name="dashboard-window-from"]')!, { target: { value: '2026-10-20T10:00' } });
    fireEvent.change(document.querySelector('[name="dashboard-window-to"]')!, { target: { value: '2026-10-19T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(within(screen.getByRole('group', { name: 'Custom range' })).getByRole('alert'))
      .toHaveTextContent('The window must end after it starts');
    // Refusing the range is not a write.
    await new Promise((r) => setTimeout(r, 20));
    expect(put).not.toHaveBeenCalled();
    // Whatever is saved next is the window that was valid, never the refused one.
    save();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(sent().document.timeWindow).toEqual({ mode: 'relative', period: '24h' });
  });

  it('a valid custom window is sent as ISO instants', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(document.querySelector('[name="dashboard-window-from"]')!, { target: { value: '2026-10-19T10:00' } });
    fireEvent.change(document.querySelector('[name="dashboard-window-to"]')!, { target: { value: '2026-10-20T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    save();
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(sent().document.timeWindow).toEqual({ mode: 'fixed', from: '2026-10-19T10:00:00.000Z', to: '2026-10-20T10:00:00.000Z' });
  });

  it('an empty title cannot be saved', () => {
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });

  it('an unreadable stored source is NOT widened to all: no mode is chosen and Save asks for one', async () => {
    mount(UNREADABLE);
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose which instruments');
    expect(put).not.toHaveBeenCalled();
  });

  it('a 409 shows the danger banner with Reload, keeps the dialog, and Reload re-reads then closes', async () => {
    put.mockRejectedValue(Object.assign(new Error('changed'), { code: 'DASHBOARD_CHANGED' }));
    const { onSaved, onClose, onReload } = mount();
    save();
    const banner = await screen.findByText('This dashboard was changed by someone else.');
    expect(banner.closest('[data-testid="dialog-banner"]')).toHaveAttribute('data-tone', 'danger');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('any other refusal is shown in place and the dialog stays', async () => {
    put.mockRejectedValue(new Error('Boom'));
    const { onSaved } = mount();
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('every text input carries a distinct name', () => {
    mount();
    const names = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).map((i) => i.getAttribute('name'));
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
