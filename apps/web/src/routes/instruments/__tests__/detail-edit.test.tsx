import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * The Details card's edit form (2026-09-16, operator: "there user can edit
 * Instrument ID & Profile Type and is gateway selection i dont need other
 * options Block, area, location, Description and expected interval options in
 * details section", then "remove profile change option in instrument page").
 * TWO fields, nothing else, and the PUT carries only what those two say — an
 * omitted field leaves the stored value alone, so the trimmed form cannot
 * blank a description nobody typed, and cannot move the profile.
 */
const instrument = {
  id: 'i-1', name: 'CWH/RDU/001-00', code: 'CWH/RDU/001-00', isActive: true,
  instrumentType: 'T/RH', manufacturer: null, model: null, serialNumber: null,
  description: 'North wing', expectedIntervalSec: 60,
  tokenPrefix: 'ABCD1234', lastSeenAt: null, tokenRevealable: true,
  createdAt: '2026-08-06T00:00:00.000Z', createdBy: null,
  block: 'CWH', area: 'QC', location: 'LCMS',
  isGateway: false, gatewayId: null, lastSeenVia: null,
  profileId: 'p-1', profileName: 'T&RH Sensors',
};
const profiles = { data: [{ id: 'p-1', name: 'T&RH Sensors' }, { id: 'p-2', name: 'Gateways' }] };

const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instruments/i-1') return { data: instrument, mutate };
    if (key === '/api/instrument-profiles') return { data: profiles, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/attributes') return { data: { data: [] }, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/children') return { data: { data: [] }, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));

const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    put: (...a: unknown[]) => put(...a),
    get: vi.fn(), post: vi.fn(), delete: vi.fn(),
    getWithReauth: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(),
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: () => '', formatDateTime: (v: string) => v }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentDetailPage } = await import('../detail');

const renderPage = () => render(
  <MemoryRouter initialEntries={['/instruments/i-1']}>
    <Routes><Route path="/instruments/:id" element={<InstrumentDetailPage />} /></Routes>
  </MemoryRouter>,
);
const details = () => screen.getByTestId('details-card');
const startEdit = () => fireEvent.click(within(details()).getByRole('button', { name: 'Edit' }));

beforeEach(() => { put.mockReset().mockResolvedValue({}); mutate.mockReset(); });

describe('instrument detail — Details edit form', () => {
  it('offers exactly Instrument ID and Is Gateway — no profile change', () => {
    renderPage();
    startEdit();
    const card = details();
    expect(within(card).getByRole('textbox', { name: 'Instrument ID' })).toHaveValue('CWH/RDU/001-00');
    expect(within(card).queryByRole('combobox')).toBeNull();
    expect(within(card).getByRole('checkbox', { name: /is gateway/i })).not.toBeChecked();
    for (const gone of [/profile/i, /block/i, /^area/i, /location/i, /description/i, /expected interval/i, /^active/i]) {
      expect(within(card).queryByLabelText(gone)).toBeNull();
    }
    expect(within(card).getAllByRole('textbox')).toHaveLength(1);
    expect(within(card).getAllByRole('checkbox')).toHaveLength(1);
    // The profile is still SHOWN, read-only.
    expect(within(card).getByText('T&RH Sensors')).toBeInTheDocument();
  });

  it('the read view shows no Block, Area, Location, Description or interval rows', () => {
    renderPage();
    const card = details();
    for (const gone of ['Block', 'Area', 'Location', 'Description', 'Expected interval']) {
      expect(within(card).queryByText(gone)).toBeNull();
    }
    expect(within(card).getByText('Instrument ID')).toBeInTheDocument();
    expect(within(card).getByText('Profile')).toBeInTheDocument();
  });

  it('Save sends only the gateway flag when the ID is unchanged — never the profile', async () => {
    renderPage();
    startEdit();
    fireEvent.click(within(details()).getByRole('checkbox', { name: /is gateway/i }));
    fireEvent.click(within(details()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instruments/i-1', { isGateway: true }));
    // The stored description, interval, placement AND profile were NOT sent, so they survive.
    const body = put.mock.calls[0][1] as Record<string, unknown>;
    for (const k of ['profileId', 'description', 'expectedIntervalSec', 'block', 'area', 'location', 'name', 'isActive', 'code']) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it('Save sends the new Instrument ID when it changed', async () => {
    renderPage();
    startEdit();
    fireEvent.change(within(details()).getByRole('textbox', { name: 'Instrument ID' }), { target: { value: 'CWH/RDU/001-01' } });
    fireEvent.click(within(details()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instruments/i-1', {
      code: 'CWH/RDU/001-01', isGateway: false,
    }));
  });

  it('Cancel discards the draft', () => {
    renderPage();
    startEdit();
    fireEvent.change(within(details()).getByRole('textbox', { name: 'Instrument ID' }), { target: { value: 'X' } });
    fireEvent.click(within(details()).getByRole('button', { name: 'Cancel' }));
    expect(within(details()).queryByRole('textbox')).toBeNull();
    expect(put).not.toHaveBeenCalled();
    expect(within(details()).getByText('CWH/RDU/001-00')).toBeInTheDocument();
  });
});
