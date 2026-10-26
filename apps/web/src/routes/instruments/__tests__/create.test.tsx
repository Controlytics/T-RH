import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Registering an instrument, after the 2026-08-07 trim and the 2026-08-08
 * per-profile attributes change.
 *
 * Three properties are worth protecting here. The form no longer asks for a
 * NAME — the API still requires one, so the code is sent as both, and a
 * regression would be a 400 at the only moment a token is issuable. The
 * attribute keys come from the PROFILE, not from a global config and certainly
 * not from a hardcoded set, which is the whole point of administering them per
 * profile. And the Attributes section must tell its four states apart —
 * no-profile / loading / empty / failed — because collapsing any of them into
 * "no attributes" lets an operator register a device with every attribute
 * missing and no signal that anything went wrong.
 */
const PROFILES = { data: [{ id: 'p-1', name: 'Cleanroom-A' }, { id: 'p-2', name: 'Utility' }] };

/** p-1's key list. p-2 always asks for nothing, so the empty state is reachable. */
const PROFILE_KEYS = { current: 'Block\nRoom\nCalibration Due' as string | null };
/** Drives the single-profile fetch so the loading and failure states are reachable. */
const PROFILE_FETCH = { loading: false, error: false };
/** Configuration → Attribute Display Names, as the narrow-slice route returns it. */
const LABELS = { current: {} as Record<string, string> };
/** `GET /api/functional-locations` — undefined = not loaded, as every older case runs. */
const TREE = { current: undefined as unknown };

/**
 * URL-PRECISE. The page reads the profile LIST (`/api/instrument-profiles`) and
 * one PROFILE (`/api/instrument-profiles/:id`); a mock matching both with
 * `.includes()` would answer the list with a single profile, leaving the
 * <select> with no options so nothing could be chosen and every "it posts …"
 * test failed for a reason unrelated to what it tested.
 */
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instrument-profiles') return { data: PROFILES };
    if (key === '/api/config/attribute-labels/current') return { data: { labels: LABELS.current } };
    if (key === '/api/functional-locations') return { data: TREE.current };
    if (typeof key === 'string' && key.startsWith('/api/instrument-profiles/')) {
      if (PROFILE_FETCH.loading) return { data: undefined, isLoading: true };
      if (PROFILE_FETCH.error) return { data: undefined, error: new Error('unreachable') };
      const id = key.slice('/api/instrument-profiles/'.length);
      return { data: { id, attributeKeys: id === 'p-2' ? '' : PROFILE_KEYS.current } };
    }
    return { data: undefined };
  },
}));

const post = vi.fn();
const postWithReauth = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    postWithReauth: (...a: unknown[]) => postWithReauth(...a),
    get: vi.fn(), put: vi.fn(), delete: vi.fn(),
  },
}));

const errorToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: errorToast } }),
}));
/** Every action the screen signed under (audit 2026-10-03, SEC-7). Pass-through
 *  otherwise, as the Attributes panel test does: the callback runs with no
 *  password — the path for a role whose policy is off. */
const reauthActions: string[] = [];
/**
 * How the operator answers the password dialog. `none` = no dialog (policy
 * off); `password` = the policy pre-opened it and a password arrived; on a
 * `REAUTH_REQUIRED` thrown out of the callback the REAL hook opens the dialog
 * retroactively and REPLAYS the callback with the password — modelled here as
 * `retry` (operator confirms) or `cancel` (operator cancels).
 */
const dialog = { current: 'none' as 'none' | 'password' | 'cancel' };
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      reauthActions.push(action);
      try {
        await cb(dialog.current === 'password' ? 'pw' : undefined);
        await opts?.onSuccess?.();
      } catch (e) {
        if ((e as { error?: string })?.error !== 'REAUTH_REQUIRED') { opts?.onError?.(e); return; }
        if (dialog.current === 'cancel') { opts?.onCancel?.(); return; }
        try { await cb('pw'); await opts?.onSuccess?.(); } catch (e2) { opts?.onError?.(e2); }
      }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentCreatePage } = await import('../create');

const renderPage = () => render(<MemoryRouter><InstrumentCreatePage /></MemoryRouter>);
const created = { id: 'i-1', code: 'PROBE-A1', token: 'TOK' };

beforeEach(() => {
  PROFILE_KEYS.current = 'Block\nRoom\nCalibration Due';
  PROFILE_FETCH.loading = false;
  PROFILE_FETCH.error = false;
  LABELS.current = {};
  TREE.current = undefined;
  post.mockReset().mockResolvedValue(created);
  postWithReauth.mockReset().mockResolvedValue(created);
  errorToast.mockReset();
  dialog.current = 'none';
});

/**
 * Choose a profile. Attribute fields do not exist until one is chosen, so almost
 * every test needs this — and choosing it is what decides which fields appear.
 */
const choose = (id = 'p-1') =>
  fireEvent.change(screen.getByRole('combobox', { name: /profile/i }), { target: { value: id } });

const fillId = (code: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: /instrument id/i }), { target: { value: code } });
  // Every instrument belongs to a profile, so the form cannot submit without
  // one. Chosen here rather than in each test, which are about other fields.
  choose('p-1');
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: /create instrument/i }));

describe('InstrumentCreatePage — the trimmed form', () => {
  it('asks for the Instrument ID and not a separate Name', () => {
    renderPage();
    expect(screen.getByRole('textbox', { name: /instrument id/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^name/i })).not.toBeInTheDocument();
  });

  // 2026-09-16, operator: "in instrument id field dont put any instructions,
  // user will enter different Instrument ids format so it should not
  // restricted", then "remove instrument id restriction popup" — the MQTT
  // wildcard/reserved-segment guard went too, with its consequence stated
  // (see the shared schema test). No pattern, no hint, no toast: any text.
  it('puts no format restriction or instruction on the Instrument ID field', () => {
    renderPage();
    const id = screen.getByRole('textbox', { name: /instrument id/i });
    expect(id).not.toHaveAttribute('pattern');
    expect(id).not.toHaveAttribute('title');
    expect(id).not.toHaveAttribute('placeholder');
  });

  it('sends an Instrument ID containing an MQTT wildcard unchanged, with no popup', async () => {
    renderPage();
    fillId('T+RH/001');
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments', expect.objectContaining({ code: 'T+RH/001' }),
    ));
    expect(errorToast).not.toHaveBeenCalled();
  });

  it('accepts a slash-coded Instrument ID and sends it unchanged', async () => {
    renderPage();
    fillId('CWH/RDU/002-00');
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments', expect.objectContaining({ code: 'CWH/RDU/002-00' }),
    ));
    expect(errorToast).not.toHaveBeenCalled();
  });

  // Attribute keys are the stored identity; the FORM prints the administered
  // display name where one exists and the key where none does.
  it('labels an attribute field with its configured display name, else the key', () => {
    LABELS.current = { Room: 'Cleanroom number' };
    renderPage();
    choose('p-1');
    expect(screen.getByRole('textbox', { name: 'Cleanroom number' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Room' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Block' })).toBeInTheDocument();
  });

  it('no longer asks for expected interval or hardware', () => {
    renderPage();
    for (const gone of [/expected interval/i, /manufacturer/i, /model/i, /serial/i, /description/i]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  // The API requires `name`; the form stopped asking for one.
  it('sends the code as the name', async () => {
    renderPage();
    fillId('PROBE-A1');
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments', expect.objectContaining({ code: 'PROBE-A1', name: 'PROBE-A1' }),
    ));
  });

  it('signs the registration under the CREATE_INSTRUMENT re-auth action (audit 2026-10-03, SEC-7)', async () => {
    reauthActions.length = 0;
    renderPage();
    fillId('PROBE-A1');
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments', expect.anything()));
    expect(reauthActions).toEqual(['CREATE_INSTRUMENT']);
  });

  // Block / Area / Location are configured keys like any other — one Attributes
  // section, no special-cased trio — but they are real COLUMNS. Written as
  // attribute rows they would look identical on screen while quietly emptying
  // the Instruments list's placement filters.
  it('routes Block to the instrument column, not to an attribute', async () => {
    renderPage();
    fillId('P-2');
    fireEvent.change(screen.getByRole('textbox', { name: /^block$/i }), { target: { value: 'B1' } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments', expect.objectContaining({ block: 'B1' })));
    expect(post).not.toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', expect.objectContaining({ key: 'Block' }),
    );
  });

  it('has no placement inputs of its own — they come from the profile key list', () => {
    PROFILE_KEYS.current = 'Room';
    renderPage();
    choose('p-1');
    // The profile asks only for Room, so the placement trio must be absent even
    // though the page knows how to route them.
    expect(screen.getByRole('textbox', { name: /^room$/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^block$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^area$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^location$/i })).not.toBeInTheDocument();
  });
});

describe('InstrumentCreatePage — attributes come from the profile', () => {
  it('renders one field per key of the CHOSEN profile, in order', () => {
    renderPage();
    choose('p-1');
    expect(screen.getByRole('textbox', { name: /^room$/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /calibration due/i })).toBeInTheDocument();
  });

  it('asks for nothing, and says why, before a profile is chosen', () => {
    renderPage();
    expect(screen.getByText(/choose a profile to see the attributes/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^room$/i })).not.toBeInTheDocument();
  });

  it('asks a different profile for its own keys', () => {
    renderPage();
    choose('p-2');  // asks for nothing
    expect(screen.getByText(/asks for no attributes/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^room$/i })).not.toBeInTheDocument();
  });

  it('shows a LOADING line, never "no attributes", while the profile is in flight', () => {
    // The distinction that matters: rendering nothing here is
    // indistinguishable from "this profile asks for nothing", and an operator
    // would submit an instrument with every attribute missing.
    PROFILE_FETCH.loading = true;
    renderPage();
    choose('p-1');
    expect(screen.getByText(/loading the attributes/i)).toBeInTheDocument();
    expect(screen.queryByText(/asks for no attributes/i)).not.toBeInTheDocument();
  });

  it('warns explicitly when the profile list cannot be loaded', () => {
    PROFILE_FETCH.error = true;
    renderPage();
    choose('p-1');
    expect(screen.getByText(/could not load the attributes/i)).toBeInTheDocument();
    expect(screen.queryByText(/asks for no attributes/i)).not.toBeInTheDocument();
  });

  it('writes only the attributes that were filled in', async () => {
    renderPage();
    fillId('P-3');
    fireEvent.change(screen.getByRole('textbox', { name: /^room$/i }), { target: { value: 'B-204' } });
    submit();

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Room', value: 'B-204' },
    ));
    // 'Calibration Due' was left blank — posting '' would store an empty
    // attribute where the operator meant "not recorded".
    expect(post).not.toHaveBeenCalledWith('/api/instruments/i-1/attributes', expect.objectContaining({ key: 'Calibration Due' }));
  });

  // The instrument and its token already exist by the time attributes are
  // written. Throwing that away over one failed attribute would cost the
  // operator the only moment the token is knowable.
  it('keeps the instrument when an attribute write fails, and says which', async () => {
    post.mockImplementation((url: string) =>
      url.endsWith('/attributes') ? Promise.reject(new Error('nope')) : Promise.resolve(created));
    renderPage();
    fillId('P-4');
    fireEvent.change(screen.getByRole('textbox', { name: /^room$/i }), { target: { value: 'B-204' } });
    submit();

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(
      expect.stringMatching(/created/i), expect.stringMatching(/Room/),
    ));
    // The token dialog still opens — the registration succeeded.
    expect(await screen.findByText(/PROBE-A1/)).toBeInTheDocument();
  });

  it('explains where to configure keys when the profile asks for none', () => {
    renderPage();
    choose('p-2');
    expect(screen.getByText(/asks for no attributes/i)).toBeInTheDocument();
    expect(screen.getByText(/Configuration/)).toBeInTheDocument();
  });

  // An unreachable profile must not block registering a device — the same
  // non-blocking posture the global config read had.
  it('still registers when the profile cannot be read', async () => {
    PROFILE_FETCH.error = true;
    renderPage();
    fillId('P-5');
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments', expect.objectContaining({ code: 'P-5' })));
  });
});

describe('InstrumentCreatePage — switching profile', () => {
  it('confirms before discarding typed values, and keeps them when declined', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    choose('p-1');
    fireEvent.change(screen.getByRole('textbox', { name: /^room$/i }), { target: { value: '214' } });
    choose('p-2');
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /^room$/i })).toHaveValue('214');
    confirmSpy.mockRestore();
  });

  it('clears the values when the discard is accepted', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    choose('p-1');
    fireEvent.change(screen.getByRole('textbox', { name: /^room$/i }), { target: { value: '214' } });
    choose('p-2');
    expect(screen.getByText(/asks for no attributes/i)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('does not prompt when nothing was typed', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    choose('p-1');
    choose('p-2');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

/**
 * Audit 2026-10-12, finding 3. The attribute writes went out as bare posts even
 * inside the re-auth callback that HAD the password, and a `REAUTH_REQUIRED`
 * from them (the role's Attribute Access asks for one; CREATE_INSTRUMENT
 * ships OFF, so no password was collected up front) was swallowed as an
 * ordinary failure: the attribute was reported unsaved and never retried.
 */
describe('InstrumentCreatePage — the attribute writes are signed too', () => {
  const REAUTH = { error: 'REAUTH_REQUIRED', message: 'Password required' };

  it('sends the collected password with every attribute write', async () => {
    dialog.current = 'password';
    renderPage();
    fillId('P-6');
    fireEvent.change(screen.getByRole('textbox', { name: /^room$/i }), { target: { value: 'B-204' } });
    submit();
    await waitFor(() => expect(postWithReauth).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Room', value: 'B-204' }, 'pw',
    ));
    expect(post).not.toHaveBeenCalledWith('/api/instruments/i-1/attributes', expect.anything());
  });

  it('asks for the password when an attribute write demands one, and registers ONCE', async () => {
    post.mockImplementation((url: string) =>
      url.endsWith('/attributes') ? Promise.reject(REAUTH) : Promise.resolve(created));
    renderPage();
    fillId('P-7');
    fireEvent.change(screen.getByRole('textbox', { name: /^room$/i }), { target: { value: 'B-204' } });
    submit();
    await waitFor(() => expect(postWithReauth).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Room', value: 'B-204' }, 'pw',
    ));
    // The replay must not register the instrument a second time.
    expect(post.mock.calls.filter(([url]) => url === '/api/instruments')).toHaveLength(1);
    expect(postWithReauth).not.toHaveBeenCalledWith('/api/instruments', expect.anything(), expect.anything());
    expect(errorToast).not.toHaveBeenCalled();
    expect(await screen.findByText(/PROBE-A1/)).toBeInTheDocument();
  });

  it('still shows the registered instrument and its token when that password is cancelled', async () => {
    dialog.current = 'cancel';
    post.mockImplementation((url: string) =>
      url.endsWith('/attributes') ? Promise.reject(REAUTH) : Promise.resolve(created));
    renderPage();
    fillId('P-8');
    fireEvent.change(screen.getByRole('textbox', { name: /^room$/i }), { target: { value: 'B-204' } });
    submit();
    // The instrument EXISTS: leaving the operator on the form invites a second
    // registration, and loses the only moment the token is shown.
    expect(await screen.findByText(/PROBE-A1/)).toBeInTheDocument();
    expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/created/i), expect.stringMatching(/Room/));
  });
});

/**
 * The functional location an instrument is born in (2026-10-26). On AWS a
 * MAINTENANCE user scoped to two locations registered instruments with none and
 * lost sight of them at once — every attribute typed here came back 404. The
 * server now refuses that; the form offers only what the SERVER marks
 * `placeable` and says what is missing before the round trip.
 */
describe('InstrumentCreatePage — the functional location it is born in', () => {
  const scopedTree = {
    placementRequired: true,
    data: [
      { id: 'b-own', name: 'CWH', placeable: false, children: [
        { id: 'a-own', name: 'Module-E', placeable: true },
        { id: 'a-not', name: 'Module-F', placeable: false },
      ] },
      { id: 'b-not', name: 'Block C', placeable: false, children: [] },
    ],
  };
  const block = () => screen.getByRole('combobox', { name: 'Functional location block' });
  const area = () => screen.getByRole('combobox', { name: 'Functional location area' });

  it('refuses to submit without one when the server says placement is required', async () => {
    TREE.current = scopedTree;
    renderPage();
    fillId('P-9');
    submit();
    expect(await screen.findByText('Choose a functional location.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('does not count a Block it may not place in directly as a choice', async () => {
    TREE.current = scopedTree;
    renderPage();
    fillId('P-9');
    fireEvent.change(block(), { target: { value: 'b-own' } });
    submit();
    expect(await screen.findByText('Choose a functional location.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('offers only what the server marks placeable, and sends the chosen Area', async () => {
    TREE.current = scopedTree;
    renderPage();
    fillId('P-9');
    expect(within(block()).queryByRole('option', { name: 'Block C' })).not.toBeInTheDocument();
    fireEvent.change(block(), { target: { value: 'b-own' } });
    expect(within(area()).queryByRole('option', { name: 'Module-F' })).not.toBeInTheDocument();
    fireEvent.change(area(), { target: { value: 'a-own' } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments', expect.objectContaining({ functionalLocationId: 'a-own' }),
    ));
  });

  it('needs none, and sends none, for an unrestricted caller', async () => {
    TREE.current = { placementRequired: false, data: [{ id: 'b-1', name: 'CWH', placeable: true, children: [] }] };
    renderPage();
    fillId('P-9');
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments', expect.anything()));
    expect(post.mock.calls[0][1]).not.toHaveProperty('functionalLocationId');
  });
});
