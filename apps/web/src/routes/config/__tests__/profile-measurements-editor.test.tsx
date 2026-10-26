import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DEFAULT_PROFILE_MEASUREMENTS, type ProfileMeasurement } from '@digilog/shared';

/**
 * The Measurements section of a profile (2026-10-26, operator: "temperature and
 * humidity keys … limits keys … should be updated instrument profiles wise" and
 * "in instrument profiles NLT and MNT attributes and MKT attributes … enabled or
 * disabled"). What it must get right: the switches the operator asked for are
 * there and save what they show; a save first asks the SERVER what it would
 * clear and collects a reason; MKT is offered only where the server says the
 * unit is °C; a server refusal is said in words.
 *
 * `swr` is mocked with module-level constants (a fresh object per call re-runs
 * effects forever — see apps/web/CLAUDE.md).
 */
const TYPES = { data: [
  { code: 'TEMPERATURE', name: 'Temperature', unit: '°C', sortOrder: 1 },
  { code: 'HUMIDITY', name: 'Humidity', unit: '%RH', sortOrder: 2 },
] };
vi.mock('swr', () => ({
  default: (key: string | null) => ({ data: key === '/api/instrument-profiles/measurement-types' ? TYPES : undefined }),
}));

const post = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    putWithReauth: (...a: unknown[]) => put(...a),
    get: vi.fn(),
  },
}));
const toastError = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }),
}));
const reauthActions: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      reauthActions.push(action);
      try { await cb(); await opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { ProfileMeasurementsEditor } = await import('../profile-measurements/editor');

const PROFILE = {
  id: 'p1', name: 'T&RH Sensors', attributeKeys: 't_hl\nt_ll',
  measurements: structuredClone(DEFAULT_PROFILE_MEASUREMENTS) as ProfileMeasurement[],
};

beforeEach(() => {
  post.mockReset(); put.mockReset(); toastError.mockReset(); reauthActions.length = 0;
  post.mockResolvedValue({ clears: [{ metric: 'TEMPERATURE', source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', count: 3 }] });
  put.mockResolvedValue({});
});

describe('ProfileMeasurementsEditor', () => {
  it('shows one section per measurement, named and with its unit', () => {
    render(<ProfileMeasurementsEditor profile={PROFILE} onSaved={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Temperature (°C)' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Humidity (%RH)' })).toBeTruthy();
  });

  it('offers MKT only on the °C measurement', () => {
    render(<ProfileMeasurementsEditor profile={PROFILE} onSaved={vi.fn()} />);
    const temp = screen.getByRole('region', { name: 'Temperature (°C)' });
    const humid = screen.getByRole('region', { name: 'Humidity (%RH)' });
    expect(within(temp).getByRole('switch', { name: /MKT/ })).toBeTruthy();
    expect(within(humid).queryByRole('switch', { name: /MKT/ })).toBeNull();
  });

  it('switching NMT off asks the server what it would clear, takes a reason, then saves exactly that', async () => {
    const onSaved = vi.fn();
    render(<ProfileMeasurementsEditor profile={PROFILE} onSaved={onSaved} />);
    const temp = screen.getByRole('region', { name: 'Temperature (°C)' });
    fireEvent.click(within(temp).getByRole('switch', { name: /NMT/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save measurements' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/api/instrument-profiles/p1/measurement-impact');
    // The dialog names what will be cleared, in words.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/3 open alarm/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'NMT not judged here' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = put.mock.calls[0] as [string, { measurements: ProfileMeasurement[]; reason: string }];
    expect(url).toBe('/api/instrument-profiles/p1');
    expect(body.reason).toBe('NMT not judged here');
    expect(body.measurements.find((m) => m.code === 'TEMPERATURE')!.high.enabled).toBe(false);
    expect(body.measurements.find((m) => m.code === 'TEMPERATURE')!.low.enabled).toBe(true);
    expect(reauthActions).toEqual(['UPDATE_INSTRUMENT_PROFILE']);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('a server refusal is said in its own words', async () => {
    post.mockResolvedValue({ clears: [] });
    put.mockRejectedValue({ error: 'MKT_NOT_TEMPERATURE', message: 'MKT is calculated from a temperature in °C' });
    render(<ProfileMeasurementsEditor profile={PROFILE} onSaved={vi.fn()} />);
    const temp = screen.getByRole('region', { name: 'Temperature (°C)' });
    fireEvent.click(within(temp).getByRole('switch', { name: /NLT/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save measurements' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'checking the server refusal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][1])).toMatch(/MKT is calculated/);
  });

  it('nothing to save until something changes', () => {
    render(<ProfileMeasurementsEditor profile={PROFILE} onSaved={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Save measurements' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
