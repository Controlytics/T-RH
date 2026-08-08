import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Registering an instrument, after the 2026-08-07 trim.
 *
 * Two properties are worth protecting here. The form no longer asks for a
 * NAME — the API still requires one, so the code is sent as both, and a
 * regression would be a 400 at the only moment a token is issuable. And the
 * attribute keys come from CONFIG: a form that silently asked for a hardcoded
 * set would defeat the whole point of administering them.
 */
const config = { current: { keys: 'Room\nCalibration Due' } as { keys?: string } | undefined };
/**
 * URL-aware, because the page now reads TWO endpoints: the attribute-key config
 * and the profile list. A mock answering both with the same object left the
 * profile <select> with no options, so nothing could be selected, the submit
 * button stayed disabled, and every "it posts …" test failed for a reason that
 * had nothing to do with what it was testing.
 */
const PROFILES = { data: [{ id: 'p-1', name: 'Cleanroom-A' }, { id: 'p-2', name: 'Utility' }] };
vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data: typeof key === 'string' && key.includes('/api/instrument-profiles') ? PROFILES : config.current,
  }),
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
  config.current = { keys: 'Block\nRoom\nCalibration Due' };
  post.mockReset().mockResolvedValue(created);
  errorToast.mockReset();
});

const fillId = (code: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: /instrument id/i }), { target: { value: code } });
  // Every instrument belongs to a profile, so the form cannot submit without
  // one. Chosen here rather than in each test, which are about other fields.
  fireEvent.change(screen.getByRole('combobox', { name: /profile/i }), { target: { value: 'p-1' } });
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: /create instrument/i }));

describe('InstrumentCreatePage — the trimmed form', () => {
  it('asks for the Instrument ID and not a separate Name', () => {
    renderPage();
    expect(screen.getByRole('textbox', { name: /instrument id/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^name/i })).not.toBeInTheDocument();
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

  it('has no placement inputs of its own — they come from the key list', () => {
    config.current = { keys: 'Room' };
    renderPage();
    expect(screen.queryByRole('textbox', { name: /^block$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^area$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^location$/i })).not.toBeInTheDocument();
  });
});

describe('InstrumentCreatePage — configured attributes', () => {
  it('renders one field per configured key, in order', () => {
    renderPage();
    expect(screen.getByRole('textbox', { name: /^room$/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /calibration due/i })).toBeInTheDocument();
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

  it('explains where to configure keys when none are set', () => {
    config.current = { keys: '' };
    renderPage();
    expect(screen.getByText(/no attribute keys are configured/i)).toBeInTheDocument();
    expect(screen.getByText(/Configuration/)).toBeInTheDocument();
  });

  // An unreachable config must not block registering a device.
  it('still registers when the config cannot be read', async () => {
    config.current = undefined;
    renderPage();
    fillId('P-5');
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments', expect.objectContaining({ code: 'P-5' })));
  });
});
