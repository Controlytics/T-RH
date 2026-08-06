import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '../confirm-dialog';

/**
 * The shared destructive-action confirm, extracted 2026-08-06 from six call
 * sites (five of them `window.confirm`).
 *
 * What is pinned here is the SAFETY contract, not the styling: the confirm
 * button is the only path to the action, cancel and backdrop are not, and
 * nothing is clickable while a request is in flight. A styled dialog that
 * stopped guarding would be worse than the OS one it replaced.
 */
const base = {
  open: true,
  title: 'Delete thing',
  message: 'Delete the thing?',
  confirmLabel: 'Delete thing',
  onConfirm: vi.fn(),
  onClose: vi.fn(),
};

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(<ConfirmDialog {...base} open={false} />);
    expect(screen.queryByText('Delete thing')).not.toBeInTheDocument();
  });

  it('shows the title, the question and the confirm label', () => {
    render(<ConfirmDialog {...base} />);
    expect(screen.getByText('Delete the thing?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete thing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('fires onConfirm only from the confirm button', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete thing' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // Optional on purpose: inventing red copy for ordinary config rows would
  // train operators to skip the panel where it carries a real consequence.
  it('omits the warning panel when there is no warning', () => {
    const { rerender } = render(<ConfirmDialog {...base} />);
    expect(screen.queryByText(/cannot be recovered/i)).not.toBeInTheDocument();
    rerender(<ConfirmDialog {...base} warning="It cannot be recovered." />);
    expect(screen.getByText('It cannot be recovered.')).toBeInTheDocument();
  });

  it('disables both buttons and shows the busy label while in flight', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog {...base} busy busyLabel="Deleting…" onConfirm={onConfirm} onClose={onClose} />);

    const confirmBtn = screen.getByRole('button', { name: 'Deleting…' });
    expect(confirmBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();

    fireEvent.click(confirmBtn);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Esc while a delete is running would hide a request whose outcome the
  // operator can no longer see.
  it('ignores Escape while busy, but honours it otherwise', () => {
    const onClose = vi.fn();
    const { rerender } = render(<ConfirmDialog {...base} busy onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    rerender(<ConfirmDialog {...base} busy={false} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
