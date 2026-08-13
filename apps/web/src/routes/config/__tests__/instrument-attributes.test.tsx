import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Editing attribute keys PER PROFILE.
 *
 * Three properties are worth protecting. A save must go to the right place —
 * the config key for the default template, the profile itself for a profile —
 * because sending a profile's list to the config endpoint would silently
 * rewrite the template for every future profile. Switching target must not
 * discard unsaved edits, since the editor deliberately ignores server
 * revalidations mid-edit and there is nothing else to recover them from. And a
 * profile that omits Block / Area / Location must say so: those are real
 * placement columns, and instruments registered there get them empty.
 *
 * `swr` is mocked module-wide rather than driven through SWRConfig, matching
 * the convention in routes/instruments/__tests__.
 */
const PROFILES = {
  data: [
    { id: 'p1', name: 'Cleanroom AHU', instrumentCount: 12, attributeKeys: 'Block\nArea\nRoom' },
    { id: 'p2', name: 'Warehouse Sensors', instrumentCount: 3, attributeKeys: 'Asset Tag' },
    { id: 'p3', name: 'Full Placement', instrumentCount: 1, attributeKeys: 'Block\nArea\nLocation' },
  ],
  total: 3,
};
const DEFAULT_CONFIG = { keys: 'Block\nArea\nLocation' };

const mutateProfiles = vi.fn();
const mutateDefault = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => (
    typeof key === 'string' && key.includes('/api/instrument-profiles')
      ? { data: PROFILES, mutate: mutateProfiles }
      : { data: DEFAULT_CONFIG, mutate: mutateDefault }
  ),
}));

const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => put(...a), get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const { InstrumentAttributesConfigPage } = await import('../instrument-attributes');

const renderPage = () => render(
  <MemoryRouter><InstrumentAttributesConfigPage /></MemoryRouter>,
);

const selectTarget = (value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: /editing/i }), { target: { value } });

const keyField = (n: number) => screen.getByRole('textbox', { name: `Attribute key ${n}` });
const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

beforeEach(() => {
  put.mockReset().mockResolvedValue({});
  mutateProfiles.mockReset();
  mutateDefault.mockReset();
});

describe('InstrumentAttributesConfigPage — target picker', () => {
  it('opens on the default template and shows its keys', () => {
    renderPage();
    expect(keyField(1)).toHaveValue('Block');
    expect(keyField(3)).toHaveValue('Location');
  });

  it('shows the selected profile keys, not the default, after switching', () => {
    renderPage();
    selectTarget('p2');
    expect(keyField(1)).toHaveValue('Asset Tag');
    // The default's third key must be gone — a stale row here would mean the
    // editor kept one target's list while claiming to show another's.
    expect(screen.queryByRole('textbox', { name: 'Attribute key 2' })).not.toBeInTheDocument();
  });

  it('saves a profile through the profile PUT, not the config PUT', async () => {
    renderPage();
    selectTarget('p2');
    fireEvent.change(keyField(1), { target: { value: 'Firmware Rev' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/instrument-profiles/p2', { attributeKeys: 'Firmware Rev' },
    ));
  });

  it('saves the default through the config PUT', async () => {
    renderPage();
    fireEvent.change(keyField(1), { target: { value: 'Block X' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/config/dynamic/instrument-attributes', { keys: 'Block X\nArea\nLocation' },
    ));
  });

  it('refuses to switch target while dirty unless the discard is confirmed', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    fireEvent.change(keyField(1), { target: { value: 'Block X' } });
    selectTarget('p2');
    expect(confirmSpy).toHaveBeenCalled();
    // Still editing the default: the edit survived and the switch did not happen.
    expect(keyField(1)).toHaveValue('Block X');
    confirmSpy.mockRestore();
  });

  it('switches and discards when the confirm is accepted', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.change(keyField(1), { target: { value: 'Block X' } });
    selectTarget('p2');
    expect(keyField(1)).toHaveValue('Asset Tag');
    confirmSpy.mockRestore();
  });

  it('switches without prompting when nothing was edited', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    selectTarget('p2');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('InstrumentAttributesConfigPage — placement advisory', () => {
  it('warns when a profile omits placement keys', () => {
    renderPage();
    selectTarget('p2');  // only "Asset Tag"
    expect(screen.getByText(/placement columns/i)).toBeInTheDocument();
    expect(screen.getByText(/Block, Area, Location/)).toBeInTheDocument();
  });

  it('names only the placement keys actually missing', () => {
    renderPage();
    selectTarget('p1');  // has Block + Area, missing Location
    expect(screen.getByText(/does not ask for Location/)).toBeInTheDocument();
  });

  it('does not warn when all three placement keys are present', () => {
    renderPage();
    selectTarget('p3');
    expect(screen.queryByText(/placement columns/i)).not.toBeInTheDocument();
  });

  it('does not warn on the default template, which is asked for on no form', () => {
    renderPage();
    fireEvent.change(keyField(3), { target: { value: '' } });  // drop Location
    expect(screen.queryByText(/placement columns/i)).not.toBeInTheDocument();
  });
});
