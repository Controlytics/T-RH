import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Configuration → Attribute Display Names (2026-09-16): one row per attribute
 * key in use, a Display name beside each, one Save.
 *
 * Three properties are protected. The page opens PRE-FILLED with every key the
 * server knows (on a profile or recorded on an instrument) so an admin types
 * names, not keys. A save sends the WHOLE map — the dynamic PUT replaces the
 * row, so a partial body would erase every other name — with blank names
 * dropped, so clearing a box is how a rename is undone. And a key typed for a
 * row the server did not offer is sent as typed, because a device-written key
 * no profile lists still deserves a name.
 */
const STORED = { current: {} as Record<string, string> };
const AVAILABLE = { current: ['Building', 'Enable_Temp_NMT', 'Room'] };

const mutateStored = vi.fn();
const globalMutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/config/dynamic/attribute-labels') return { data: { labels: STORED.current }, mutate: mutateStored };
    if (key === '/api/roles/attribute-access') return { data: { roles: [], availableKeys: AVAILABLE.current }, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: (...a: unknown[]) => globalMutate(...a),
}));

const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => put(...a), get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const { AttributeLabelsConfigPage } = await import('../attribute-labels');

const renderPage = () => render(<MemoryRouter><AttributeLabelsConfigPage /></MemoryRouter>);
const nameField = (key: string) => screen.getByRole('textbox', { name: `Display name for ${key}` });
const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

beforeEach(() => {
  STORED.current = {};
  AVAILABLE.current = ['Building', 'Enable_Temp_NMT', 'Room'];
  put.mockReset().mockResolvedValue({});
  mutateStored.mockReset();
  globalMutate.mockReset();
});

describe('AttributeLabelsConfigPage', () => {
  it('opens with a row per key in use, the stored name filled in and the rest blank', () => {
    STORED.current = { Enable_Temp_NMT: 'High temperature alarm enabled' };
    renderPage();
    expect(nameField('Building')).toHaveValue('');
    expect(nameField('Enable_Temp_NMT')).toHaveValue('High temperature alarm enabled');
    expect(nameField('Room')).toHaveValue('');
  });

  it('also lists a stored key that no profile or instrument carries any more', () => {
    STORED.current = { Legacy_Key: 'Old name' };
    renderPage();
    expect(nameField('Legacy_Key')).toHaveValue('Old name');
  });

  it('saves the WHOLE map keyed by KEY, dropping blank names, and refreshes every reader', async () => {
    STORED.current = { Room: 'Cleanroom number', Building: 'Site building' };
    renderPage();
    fireEvent.change(nameField('Enable_Temp_NMT'), { target: { value: '  High temperature alarm enabled ' } });
    // Clearing a name is how a rename is undone.
    fireEvent.change(nameField('Building'), { target: { value: '' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/config/dynamic/attribute-labels', {
      labels: { Room: 'Cleanroom number', Enable_Temp_NMT: 'High temperature alarm enabled' },
    }));
    // The narrow-slice route every screen reads must be revalidated, or the
    // Attributes panel keeps printing the old name until its cache expires.
    await waitFor(() => expect(globalMutate).toHaveBeenCalledWith('/api/config/attribute-labels/current'));
  });

  it('Save is quiet until something changed', () => {
    STORED.current = { Room: 'Cleanroom number' };
    renderPage();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    fireEvent.change(nameField('Room'), { target: { value: 'Cleanroom' } });
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('lets an admin add a key the server did not offer and saves it as typed', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /add key/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /new attribute key/i }), { target: { value: 't_ll' } });
    fireEvent.change(nameField('t_ll'), { target: { value: 'Low temperature limit (device)' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/config/dynamic/attribute-labels', {
      labels: { t_ll: 'Low temperature limit (device)' },
    }));
  });

  it('refuses to save a duplicate key, case-insensitively, and says which row', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /add key/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /new attribute key/i }), { target: { value: 'building' } });
    fireEvent.change(nameField('building'), { target: { value: 'x' } });
    expect(screen.getByText(/already listed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });
});
