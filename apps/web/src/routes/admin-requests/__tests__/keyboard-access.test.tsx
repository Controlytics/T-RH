import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

/**
 * Regression tests for M83 — the admin approval queue was keyboard-inaccessible.
 *
 * The request row was `<tr onClick>` with no role/tabIndex/onKeyDown, and the row
 * is the ONLY affordance that opens a request. A keyboard-only or AT operator
 * could not open ANY request — a total functional block on an approval workflow,
 * not a degraded experience. The slide-over it opens also had no dialog
 * semantics and no Escape handler, so even a mouse user's AT got no announcement.
 */

const REQUEST = {
  id: 'req-1',
  requestType: 'UNLOCK',
  status: 'PENDING',
  requesterName: 'Asha Rao',
  requesterEmployeeId: 'EMP-42',
  requestedAt: '2026-07-15T10:00:00.000Z',
  reason: 'Locked out after password expiry',
};

vi.mock('swr', () => ({
  default: () => ({ data: { data: [REQUEST] }, isLoading: false }),
  mutate: vi.fn(),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: vi.fn(), cancel: vi.fn(), confirm: vi.fn(), setPassword: vi.fn(),
    isOpen: false, password: '', error: '', isVerifying: false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: () => '15 Jul 2026 10:00' }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/lib/api-client', () => ({ api: { post: vi.fn() } }));
vi.mock('@/components/ui/pagination', () => ({ Pagination: () => null }));

import { AdminRequestsPage } from '../index';

/** The request row — the only affordance that opens a request. */
const getRow = () => screen.getByRole('button', { name: /Review .* request from Asha Rao/i });

describe('M83 — admin-requests keyboard accessibility', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('exposes the request row as a focusable, labelled control', () => {
    render(<AdminRequestsPage />);
    const row = getRow();
    expect(row.tagName).toBe('TR');
    expect(row).toHaveAttribute('tabIndex', '0');
  });

  it('opens the request with Enter (was mouse-only — the total block)', () => {
    render(<AdminRequestsPage />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(getRow(), { key: 'Enter' });

    const panel = screen.getByRole('dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(panel).toHaveAccessibleName(/Asha Rao/);
  });

  it('opens the request with Space', () => {
    render(<AdminRequestsPage />);
    fireEvent.keyDown(getRow(), { key: ' ' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('moves focus into the panel on open so Escape and Tab land inside it', () => {
    render(<AdminRequestsPage />);
    fireEvent.keyDown(getRow(), { key: 'Enter' });
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('closes the panel on Escape', () => {
    render(<AdminRequestsPage />);
    fireEvent.keyDown(getRow(), { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives the panel close button an accessible name', () => {
    render(<AdminRequestsPage />);
    fireEvent.keyDown(getRow(), { key: 'Enter' });
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: /close request details/i }),
    ).toBeInTheDocument();
  });

  it('conveys the active stat filter via aria-pressed, not just the accent ring', () => {
    render(<AdminRequestsPage />);
    // "All Requests" is the default filter (statusFilter === '').
    // Names include the count, e.g. "1 Pending" — anchor on the trailing label.
    expect(screen.getByRole('button', { name: /All Requests$/i })).toHaveAttribute('aria-pressed', 'true');
    const pending = screen.getByRole('button', { name: /\bPending$/i });
    expect(pending).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pending);
    expect(pending).toHaveAttribute('aria-pressed', 'true');
  });
});
