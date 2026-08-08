import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const rows = { current: [] as { key: string; value: string; createdAt: string; updatedAt: string }[] };
/**
 * The administered key list, as the PROFILE returns it. Read from the owning
 * profile since 2026-08-08 — each profile asks for its own keys, so the
 * suggestions here have to follow the instrument's profile rather than a single
 * global list.
 */
const profileKeys = { current: '' };
const mutate = vi.fn();

vi.mock('swr', () => ({
  // `key` is NULL when the instrument has no profile — the panel skips the fetch
  // rather than requesting `/api/instrument-profiles/undefined`. A mock typed
  // `(key: string)` threw on that, which is the mock being wrong, not the page.
  default: (key: string | null) => {
    if (key === null) return { data: undefined, mutate };
    return key.includes('/instrument-profiles/')
      ? { data: { attributeKeys: profileKeys.current }, mutate }
      : { data: { data: rows.current }, mutate };
  },
}));

const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const { AttributesPanel } = await import('../attributes-panel');

const attr = (key: string, value: string) => ({
  key, value, createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
});

beforeEach(() => {
  rows.current = [];
  profileKeys.current = '';
  post.mockReset().mockResolvedValue({});
  put.mockReset().mockResolvedValue({});
  del.mockReset().mockResolvedValue({});
  mutate.mockReset().mockResolvedValue(undefined);
});

/** Row Delete opens the confirm dialog; the dialog's own button does the work. */
const confirmDelete = () => {
  fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
  fireEvent.click(screen.getByRole('button', { name: /^remove attribute$/i }));
};

describe('AttributesPanel', () => {
  it('explains itself when empty rather than showing a bare table', () => {
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText(/no attributes recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/audited by key/i)).toBeInTheDocument();
  });

  it('adds an attribute', async () => {
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add attribute/i }));
    fireEvent.change(screen.getByPlaceholderText(/key \(/i), { target: { value: 'Calibration Due' } });
    fireEvent.change(screen.getByPlaceholderText(/value \(/i), { target: { value: '2027-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Calibration Due', value: '2027-01-01' },
    ));
  });

  it('edits a value in place, keying the request on the attribute key', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByDisplayValue('204'), { target: { value: '205' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instruments/i-1/attributes/Room', { value: '205' }));
  });

  // A key is free text — spaces and slashes are ordinary in one ("Calibration
  // Due", "kg/h"). Unencoded, a slash would split the URL into a route that
  // does not exist and the edit would 404 for no visible reason.
  it('URL-encodes the key on edit and delete', async () => {
    rows.current = [attr('Flow kg/h', '12')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    confirmDelete();
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/instruments/i-1/attributes/Flow%20kg%2Fh'));
  });

  it('deletes an attribute after confirming in the dialog', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    // The row button only opens the dialog — nothing is destroyed by it alone.
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText(/kept in the audit trail/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^remove attribute$/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/instruments/i-1/attributes/Room'));
  });

  // The whole point of replacing `window.confirm` is that the cancel path stays
  // as safe as it was — an unstyled dialog that no longer guards anything would
  // be a worse outcome than the OS one it replaced.
  it('deletes nothing when the confirm dialog is cancelled', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/kept in the audit trail/i)).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
  });

  // A dangling `pendingDelete` would re-open the dialog on the next render, and
  // the row it names is already gone.
  it('closes the dialog after a successful delete', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    confirmDelete();
    await waitFor(() => expect(del).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/kept in the audit trail/i)).not.toBeInTheDocument());
  });

  // The backend accepts an empty value on purpose ("we track this, we do not
  // know it yet"). A blank cell reads as a rendering fault, so it is marked.
  it('marks an empty value rather than rendering a blank cell', () => {
    rows.current = [attr('Serial', '')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('reads without instruments.edit, but offers no mutation', () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit={false} />);
    expect(screen.getByText('Room')).toBeInTheDocument();
    expect(screen.getByText('204')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add attribute/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });
});


/**
 * A key added in Configuration used to change the New Instrument form ONLY, so
 * an admin who added "Calibration Due" saw nothing happen on the instruments
 * already registered — the key existed and there was no way to reach it short
 * of retyping it by hand on every one.
 */
describe('AttributesPanel — configured keys this instrument does not have', () => {
  it('offers a configured key that is missing', () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [attr('Room', 'B-204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText(/configured, not set on this instrument/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Calibration Due' })).toBeInTheDocument();
  });

  it('does not offer one the instrument already has, whatever the casing', () => {
    profileKeys.current = 'Room\ncalibration due';
    rows.current = [attr('Room', 'B-204'), attr('Calibration Due', '2027-01-01')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.queryByText(/configured, not set/i)).not.toBeInTheDocument();
  });

  // Block / Area / Location are COLUMNS, edited in Details. Offering them here
  // would write a second copy as an attribute that nothing reads.
  it('never offers the placement keys', () => {
    profileKeys.current = 'Block\nArea\nLocation';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.queryByText(/configured, not set/i)).not.toBeInTheDocument();
  });

  it('saves a filled-in key as an ordinary attribute', async () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Calibration Due' }), { target: { value: '2027-06-30' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Calibration Due', value: '2027-06-30' },
    ));
  });

  // Absent is the truth ("nobody has said yet"); an empty string is a recorded
  // fact in a §11 trail ("this was checked and is blank").
  it('will not write a blank value', () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getAllByRole('button', { name: /^save$/i })[0]).toBeDisabled();
  });

  it('offers nothing without instruments.edit', () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit={false} />);
    expect(screen.queryByText(/configured, not set/i)).not.toBeInTheDocument();
  });
});

describe('AttributesPanel — suggestions come from the profile', () => {
  it('suggests a non-placement profile key the instrument is missing', () => {
    profileKeys.current = 'Slave ID';
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByRole('textbox', { name: /slave id/i })).toBeInTheDocument();
  });

  it('offers nothing when the instrument has no profile', () => {
    // Defensive: the fetch is skipped entirely, so there are no suggestions
    // rather than a request for `/api/instrument-profiles/undefined`.
    profileKeys.current = 'Slave ID';
    render(<AttributesPanel instrumentId="i-1" profileId="" canEdit />);
    expect(screen.queryByRole('textbox', { name: /slave id/i })).not.toBeInTheDocument();
  });

  it('keeps rendering an attribute the profile no longer asks for', () => {
    // Recorded data is never hidden by a profile change — only suggestions move.
    // This is the "prompts, not values" rule at the UI layer.
    profileKeys.current = 'Slave ID';
    rows.current = [attr('Legacy Tag', 'X-9')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('Legacy Tag')).toBeInTheDocument();
    expect(screen.getByText('X-9')).toBeInTheDocument();
  });
});
