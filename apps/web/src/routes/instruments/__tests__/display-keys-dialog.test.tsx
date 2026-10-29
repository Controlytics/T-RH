import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DataKeyInfo } from '@digilog/shared';

const CATALOGUE: { keys: DataKeyInfo[]; loading: boolean } = {
  loading: false,
  keys: [
    { source: 'telemetry', key: 'temperature', label: 'Temperature', numeric: true, instruments: 1, lastSeen: '2026-10-29T08:00:00.000Z', measurement: { code: 'TEMPERATURE', name: 'Temperature', unit: '°C' } },
    { source: 'telemetry', key: 'humidity', label: 'Humidity', numeric: true, instruments: 1, lastSeen: '2026-10-29T08:00:00.000Z', measurement: { code: 'HUMIDITY', name: 'Humidity', unit: '%RH' } },
    { source: 'telemetry', key: 'p', label: 'p', numeric: true, instruments: 1, lastSeen: '2026-10-29T08:00:00.000Z', measurement: null },
    { source: 'attribute', key: 'Firmware', label: 'Firmware', numeric: false, instruments: 1, lastSeen: null, measurement: null },
  ],
};
const catalogueCalls: unknown[] = [];
vi.mock('@/routes/dashboard/widgets/use-widget-data', () => ({
  useKeyCatalogue: (sel: unknown) => { catalogueCalls.push(sel); return CATALOGUE; },
}));
const FORMAT = { formatDateTime: (v: string) => v };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const executed: { action: string; opts: Record<string, unknown> }[] = [];
const REAUTH = {
  execute: async (action: string, fn: (pw?: string) => Promise<void>, opts: Record<string, () => void>) => {
    executed.push({ action, opts });
    await fn('Secret1!');
    opts.onSuccess?.();
  },
  isOpen: false, password: '', error: '', isVerifying: false, setPassword: () => {}, confirm: () => {}, cancel: () => {},
};
vi.mock('@/hooks/use-reauth', () => ({ useReauth: () => REAUTH }));
const TOAST = { toast: { success: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));
const putWithReauth = vi.fn(async () => ({}));
const put = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])), putWithReauth: (...a: unknown[]) => putWithReauth(...(a as [])) } }));

import { DisplayKeysDialog } from '../display-keys-dialog';

const PROFILE = { id: 'prof-1', name: 'T&RH Sensors', instrumentCount: 105, displayKeys: [] };

beforeEach(() => {
  executed.length = 0;
  catalogueCalls.length = 0;
  putWithReauth.mockClear();
  put.mockClear();
});

describe('DisplayKeysDialog', () => {
  it('says which instruments it applies to, and reads this instrument\'s keys', () => {
    render(<DisplayKeysDialog open instrumentId="i-1" profile={PROFILE} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText('Applies to all 105 instruments of T&RH Sensors')).toBeTruthy();
    expect(catalogueCalls.at(-1)).toEqual({ instrumentIds: ['i-1'] });
  });

  it('refuses a key already on the page, with its reason, and an attribute', () => {
    render(<DisplayKeysDialog open instrumentId="i-1" profile={PROFILE} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'Temperature (temperature)' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Already on this page as Temperature')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Humidity (humidity)' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: 'Firmware (Firmware)' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: 'p (p)' })).toHaveProperty('disabled', false);
  });

  it('Save PUTs the chosen keys with re-auth and declares onCancel', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<DisplayKeysDialog open instrumentId="i-1" profile={PROFILE} onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'p (p)' }));
    fireEvent.change(screen.getByLabelText('Unit for p'), { target: { value: 'kPa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save keys' }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledTimes(1));
    expect(putWithReauth).toHaveBeenCalledWith(
      '/api/instrument-profiles/prof-1/display-keys',
      { displayKeys: [{ source: 'telemetry', key: 'p', label: 'p', unit: 'kPa' }] },
      'Secret1!',
    );
    expect(executed[0].action).toBe('UPDATE_INSTRUMENT_PROFILE');
    expect(Object.keys(executed[0].opts).sort()).toEqual(['onCancel', 'onError', 'onSuccess']);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from the profile\'s current keys', () => {
    render(<DisplayKeysDialog open instrumentId="i-1" profile={{ ...PROFILE, displayKeys: [{ source: 'telemetry', key: 'p', label: 'Pressure' }] }} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'p (p)' })).toHaveProperty('checked', true);
    expect((screen.getByLabelText('Label for p') as HTMLInputElement).value).toBe('Pressure');
  });
});
