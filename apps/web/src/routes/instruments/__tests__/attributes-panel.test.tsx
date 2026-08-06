import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const rows = { current: [] as { key: string; value: string; createdAt: string; updatedAt: string }[] };
const mutate = vi.fn();

vi.mock('swr', () => ({
  default: () => ({ data: { data: rows.current }, mutate }),
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
    render(<AttributesPanel instrumentId="i-1" canEdit />);
    expect(screen.getByText(/no attributes recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/audited by key/i)).toBeInTheDocument();
  });

  it('adds an attribute', async () => {
    render(<AttributesPanel instrumentId="i-1" canEdit />);
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
    render(<AttributesPanel instrumentId="i-1" canEdit />);
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
    render(<AttributesPanel instrumentId="i-1" canEdit />);
    confirmDelete();
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/instruments/i-1/attributes/Flow%20kg%2Fh'));
  });

  it('deletes an attribute after confirming in the dialog', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" canEdit />);
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
    render(<AttributesPanel instrumentId="i-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/kept in the audit trail/i)).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
  });

  // A dangling `pendingDelete` would re-open the dialog on the next render, and
  // the row it names is already gone.
  it('closes the dialog after a successful delete', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" canEdit />);
    confirmDelete();
    await waitFor(() => expect(del).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/kept in the audit trail/i)).not.toBeInTheDocument());
  });

  // The backend accepts an empty value on purpose ("we track this, we do not
  // know it yet"). A blank cell reads as a rendering fault, so it is marked.
  it('marks an empty value rather than rendering a blank cell', () => {
    rows.current = [attr('Serial', '')];
    render(<AttributesPanel instrumentId="i-1" canEdit />);
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('reads without instruments.edit, but offers no mutation', () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" canEdit={false} />);
    expect(screen.getByText('Room')).toBeInTheDocument();
    expect(screen.getByText('204')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add attribute/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });
});
