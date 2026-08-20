import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Editing attribute keys PER PROFILE.
 *
 * Three properties are worth protecting. A save must land on the SELECTED
 * profile — there is no shared list any more, so writing to the wrong id
 * silently reshapes another profile's registration form. Switching profile must
 * not discard unsaved edits, since the editor deliberately ignores server
 * revalidations mid-edit and there is nothing else to recover them from. And a
 * profile that omits Block / Area / Location must say so: those are real
 * placement columns, and instruments registered there get them empty — which is
 * now every brand-new profile, because a new one starts with no keys at all.
 *
 * `swr` is mocked module-wide rather than driven through SWRConfig, matching
 * the convention in routes/instruments/__tests__.
 */
const PROFILES = {
  data: [
    { id: 'p1', name: 'Cleanroom Probe', instrumentCount: 12, attributeKeys: 'Block\nArea\nRoom' },
    { id: 'p2', name: 'Warehouse Sensors', instrumentCount: 3, attributeKeys: 'Asset Tag' },
    { id: 'p3', name: 'Full Placement', instrumentCount: 1, attributeKeys: 'Block\nArea\nLocation' },
    { id: 'p4', name: 'Brand New', instrumentCount: 0, attributeKeys: '' },
  ],
  total: 4,
};

const mutateProfiles = vi.fn();
let profilesResponse: unknown = PROFILES;
vi.mock('swr', () => ({
  default: () => ({ data: profilesResponse, mutate: mutateProfiles }),
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
  profilesResponse = PROFILES;
  put.mockReset().mockResolvedValue({});
  mutateProfiles.mockReset();
});

describe('InstrumentAttributesConfigPage — profile picker', () => {
  it('opens on the first profile and shows its keys', () => {
    renderPage();
    expect(keyField(1)).toHaveValue('Block');
    expect(keyField(3)).toHaveValue('Room');
  });

  it('offers no shared or default target — only profiles', () => {
    renderPage();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toHaveLength(PROFILES.data.length);
    expect(options.some((o) => /default/i.test(o ?? ''))).toBe(false);
  });

  it('shows the selected profile keys, not the previous one, after switching', () => {
    renderPage();
    selectTarget('p2');
    expect(keyField(1)).toHaveValue('Asset Tag');
    // A stale row here would mean the editor kept one profile's list while
    // claiming to show another's.
    expect(screen.queryByRole('textbox', { name: 'Attribute key 2' })).not.toBeInTheDocument();
  });

  it('saves to the SELECTED profile', async () => {
    renderPage();
    selectTarget('p2');
    fireEvent.change(keyField(1), { target: { value: 'Firmware Rev' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/instrument-profiles/p2', { attributeKeys: 'Firmware Rev' },
    ));
  });

  it('never writes to the global config key', async () => {
    // REGRESSION GUARD: the `instrument-attributes` config key still exists but
    // seeds nothing. A save that reached it would edit a list no form asks for.
    renderPage();
    fireEvent.change(keyField(1), { target: { value: 'Block X' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls.every(([url]) => !String(url).includes('/api/config/'))).toBe(true);
  });

  it('refuses to switch profile while dirty unless the discard is confirmed', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    fireEvent.change(keyField(1), { target: { value: 'Block X' } });
    selectTarget('p2');
    expect(confirmSpy).toHaveBeenCalled();
    // Still on p1: the edit survived and the switch did not happen.
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

describe('InstrumentAttributesConfigPage — no profiles', () => {
  it('sends the admin to create a profile instead of showing an editor', () => {
    // The keys live ON a profile, so with none there is nothing this page could
    // save. Showing the editor anyway would give a Save button with no target.
    profilesResponse = { data: [], total: 0 };
    renderPage();
    expect(screen.getByRole('link', { name: /instrument profiles/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /editing/i })).not.toBeInTheDocument();
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
    renderPage();  // p1 has Block + Area, missing Location
    expect(screen.getByText(/does not ask for Location/)).toBeInTheDocument();
  });

  it('does not warn when all three placement keys are present', () => {
    renderPage();
    selectTarget('p3');
    expect(screen.queryByText(/placement columns/i)).not.toBeInTheDocument();
  });

  it('warns on a brand-new empty profile, which asks for no placement at all', () => {
    // A new profile starts empty since 2026-08-08, so this advisory is the only
    // thing standing between it and a blank Placement column.
    renderPage();
    selectTarget('p4');
    expect(screen.getByText(/Block, Area, Location/)).toBeInTheDocument();
  });
});
