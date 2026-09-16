import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
vi.mock('@/lib/api-client', () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const errorToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: errorToast } }),
}));

const { InstrumentCreatePage } = await import('../create');

const renderPage = () => render(<MemoryRouter><InstrumentCreatePage /></MemoryRouter>);
const created = { id: 'i-1', code: 'PROBE-A1', token: 'TOK' };

beforeEach(() => {
  PROFILE_KEYS.current = 'Block\nRoom\nCalibration Due';
  PROFILE_FETCH.loading = false;
  PROFILE_FETCH.error = false;
  LABELS.current = {};
  post.mockReset().mockResolvedValue(created);
  errorToast.mockReset();
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
  // restricted". The old browser pattern allowed only [A-Za-z0-9._-], which
  // refused `/` — the character 100 of 101 codes here carry. The server's own
  // rule (`instrumentCodeTopicViolation`: no `+`/`#`/NUL, no reserved last
  // segment) is the only limit, and it is stated in a toast when it fires.
  it('puts no format restriction or instruction on the Instrument ID field', () => {
    renderPage();
    const id = screen.getByRole('textbox', { name: /instrument id/i });
    expect(id).not.toHaveAttribute('pattern');
    expect(id).not.toHaveAttribute('title');
    expect(id).not.toHaveAttribute('placeholder');
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
