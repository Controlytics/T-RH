import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * TCP/IP instruments (2026-10-31): a profile is created as Gateway (the
 * existing push path, the default) or TCP/IP (Modbus). Since change request
 * CR-1 (2026-11-02) that choice is ALL a profile says: the Slave ID and Read
 * every are each instrument's own, and a profile body carrying either is a
 * 400. Everything shown on a card is the server's answer; the browser decides
 * nothing about it.
 */

const PROFILES = {
  data: [
    { id: 'g1', name: 'T&RH Sensors', description: null, isActive: true, instrumentCount: 105, activeCount: 104, connection: 'PUSH' },
    { id: 't1', name: 'Modbus Room Sensors', description: 'QC block', isActive: true, instrumentCount: 0, activeCount: 0, connection: 'MODBUS_TCP' },
    { id: 't2', name: 'Busy Modbus', description: null, isActive: true, instrumentCount: 4, activeCount: 4, connection: 'MODBUS_TCP' },
  ],
};
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instrument-profiles') return { data: PROFILES, mutate, isLoading: false };
    return { data: undefined, mutate: vi.fn(), isLoading: false };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), delete: vi.fn(), deleteWithReauth: vi.fn(), get: vi.fn(), put: vi.fn() },
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: vi.fn(), isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
const toastError = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }) }));

const { InstrumentProfileListPage } = await import('../profile-list');

const renderPage = () => render(<MemoryRouter><InstrumentProfileListPage /></MemoryRouter>);
const openForm = () => fireEvent.click(screen.getByRole('button', { name: '+ New Profile' }));

beforeEach(() => { post.mockReset().mockResolvedValue({}); mutate.mockReset(); toastError.mockReset(); });

describe('InstrumentProfileListPage — connection', () => {
  it('preselects Gateway', () => {
    renderPage();
    openForm();
    expect(screen.getByRole('radio', { name: /^Gateway/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^TCP\/IP \(Modbus\)/ })).not.toBeChecked();
  });

  it('a Gateway profile POSTs no connection fields', async () => {
    renderPage();
    openForm();
    fireEvent.change(screen.getByPlaceholderText('Cleanroom-A'), { target: { value: 'Plain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Profile' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/instrument-profiles', { name: 'Plain' });
  });

  it('choosing TCP/IP asks for nothing more — no Read every, no Slave / Unit ID — and POSTs the connection alone', async () => {
    renderPage();
    openForm();
    fireEvent.click(screen.getByRole('radio', { name: /^TCP\/IP \(Modbus\)/ }));
    expect(screen.queryByLabelText(/read every/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/unit id|slave id/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Cleanroom-A'), { target: { value: 'Modbus A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Profile' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/instrument-profiles', { name: 'Modbus A', connection: 'MODBUS_TCP' });
  });

  it('switching back to Gateway drops the TCP/IP fields from the POST', async () => {
    renderPage();
    openForm();
    fireEvent.click(screen.getByRole('radio', { name: /^TCP\/IP \(Modbus\)/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Gateway/ }));
    fireEvent.change(screen.getByPlaceholderText('Cleanroom-A'), { target: { value: 'Back' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Profile' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/instrument-profiles', { name: 'Back' });
  });

  it('shows the API refusal under the form, not a re-implemented rule', async () => {
    post.mockRejectedValue(new Error('A profile named "Refused" already exists'));
    renderPage();
    openForm();
    fireEvent.click(screen.getByRole('radio', { name: /^TCP\/IP \(Modbus\)/ }));
    fireEvent.change(screen.getByPlaceholderText('Cleanroom-A'), { target: { value: 'Refused' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A profile named "Refused" already exists');
  });
});

describe('InstrumentProfileListPage — cards', () => {
  it('chips each card with the server\'s connection', () => {
    renderPage();
    const gw = screen.getByRole('heading', { name: /T&RH Sensors/ });
    expect(within(gw).getByText('GATEWAY')).toBeInTheDocument();
    const tcp = screen.getByRole('heading', { name: /Modbus Room Sensors/ });
    expect(within(tcp).getByText('TCP/IP')).toBeInTheDocument();
    expect(within(tcp).queryByText('GATEWAY')).not.toBeInTheDocument();
  });

  it('an empty TCP/IP profile says so and offers + New Instrument for that profile', () => {
    renderPage();
    expect(screen.getByText('TCP/IP — no instruments yet.')).toBeInTheDocument();
    expect(screen.queryByText(/read every|unit ID/i)).not.toBeInTheDocument();
    const add = screen.getByRole('link', { name: '+ New Instrument' });
    expect(add).toHaveAttribute('href', '/instruments/new?profileId=t1');
  });

  it('a populated TCP/IP profile and a Gateway profile show no such line', () => {
    renderPage();
    expect(screen.getAllByRole('link', { name: '+ New Instrument' })).toHaveLength(1);
  });
});
