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
/** The stored display-name map, as the SUPER_ADMIN editor endpoint returns it. */
const LABELS = { current: {} as Record<string, string> };
const mutateLabels = vi.fn();
const globalMutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string) => {
    if (key === '/api/config/dynamic/attribute-labels') return { data: { labels: LABELS.current }, mutate: mutateLabels };
    return { data: profilesResponse, mutate: mutateProfiles };
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

const { InstrumentAttributesConfigPage } = await import('../instrument-attributes');

const renderPage = () => render(
  <MemoryRouter><InstrumentAttributesConfigPage /></MemoryRouter>,
);

const selectTarget = (value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: /editing/i }), { target: { value } });

const keyField = (n: number) => screen.getByRole('textbox', { name: `Attribute key ${n}` });
const nameField = (n: number) => screen.getByRole('textbox', { name: `Display name ${n}` });
const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

beforeEach(() => {
  profilesResponse = PROFILES;
  LABELS.current = {};
  put.mockReset().mockResolvedValue({});
  mutateProfiles.mockReset();
  mutateLabels.mockReset();
  globalMutate.mockReset();
});

/**
 * Display names (2026-09-16, operator: "dont give as seperate configuration
 * add in instrument attributes configuration"). A Display name box beside each
 * key. The names are ONE global map (`attribute-labels`) — the same key is
 * called the same thing in every profile — saved through the generic dynamic
 * PUT as the WHOLE map, merged: this profile's rows are written over the stored
 * map, other profiles' names are untouched, a blank clears the key's name.
 */
describe('InstrumentAttributesConfigPage — display names', () => {
  it('shows a Display name box beside each key, pre-filled from the stored map', () => {
    LABELS.current = { Room: 'Cleanroom number' };
    renderPage();
    expect(nameField(1)).toHaveValue('');       // Block
    expect(nameField(3)).toHaveValue('Cleanroom number');
  });

  it('a name alone is dirty, saves the merged WHOLE map by KEY, and refreshes every reader', async () => {
    LABELS.current = { Room: 'Cleanroom number', 'Asset Tag': 'Tag' };
    renderPage();
    // Clean: the button reads "Saved" and is disabled. A name change alone lights it.
    expect(screen.getByRole('button', { name: /^saved$/i })).toBeDisabled();
    fireEvent.change(nameField(2), { target: { value: '  Site area ' } });
    fireEvent.change(nameField(3), { target: { value: '' } });   // clears Room's name
    save();
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/config/dynamic/attribute-labels', {
      labels: { 'Asset Tag': 'Tag', Area: 'Site area' },
    }));
    // The keys did not change, so the profile is NOT rewritten.
    expect(put.mock.calls.every(([url]) => !String(url).includes('/api/instrument-profiles/'))).toBe(true);
    await waitFor(() => expect(globalMutate).toHaveBeenCalledWith('/api/config/attribute-labels/current'));
  });

  it('a renamed KEY carries its display name to the new key', async () => {
    LABELS.current = { Room: 'Cleanroom number' };
    renderPage();
    fireEvent.change(keyField(3), { target: { value: 'Room No' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instrument-profiles/p1', { attributeKeys: 'Block\nArea\nRoom No' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/config/dynamic/attribute-labels', {
      labels: { 'Room No': 'Cleanroom number' },
    }));
  });

  it('switching profile shows THAT profile\'s names for its keys', () => {
    LABELS.current = { 'Asset Tag': 'Tag' };
    renderPage();
    selectTarget('p2');
    expect(nameField(1)).toHaveValue('Tag');
  });
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

  it('never writes the KEYS to the retired global config row', async () => {
    // REGRESSION GUARD: the `instrument-attributes` config key still exists but
    // seeds nothing. A save that reached it would edit a list no form asks for.
    // (Display NAMES do go to `/api/config/dynamic/attribute-labels` — that is
    // a different row, and the one place they live.)
    renderPage();
    fireEvent.change(keyField(1), { target: { value: 'Block X' } });
    save();
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls.every(([url]) => !String(url).includes('instrument-attributes'))).toBe(true);
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
