import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Unlink is destructive in a way the row does not show: the child stops
 * reporting through this gateway and, unless it can reach the broker itself,
 * stops reporting at all. It confirmed through `window.confirm` until
 * 2026-08-06; what is pinned here is that the guard survived the swap to
 * `ConfirmDialog` — the row button alone must not unlink anything.
 */
const children = [
  { id: 'c-1', code: 'CH-1', name: 'Child one', isActive: true },
];

const mutateChildren = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instruments/gw-1/children') return { data: { data: children }, mutate: mutateChildren };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));

const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => put(...a), get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const { GatewayPanel } = await import('../gateway-panel');

beforeEach(() => {
  put.mockReset().mockResolvedValue({});
  mutateChildren.mockReset().mockResolvedValue(undefined);
});

describe('GatewayPanel — unlink confirmation', () => {
  it('opens the dialog without unlinking', () => {
    render(<GatewayPanel instrumentId="gw-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^unlink$/i }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/report telemetry directly/i)).toBeInTheDocument();
  });

  it('unlinks by clearing gatewayId once confirmed', async () => {
    render(<GatewayPanel instrumentId="gw-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^unlink$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^unlink instrument$/i }));
    // The write goes to the CHILD, not the gateway — a PUT against gw-1 here
    // would silently make the gateway a child of itself.
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instruments/c-1', { gatewayId: null }));
  });

  it('unlinks nothing when cancelled', async () => {
    render(<GatewayPanel instrumentId="gw-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^unlink$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/report telemetry directly/i)).not.toBeInTheDocument());
    expect(put).not.toHaveBeenCalled();
  });

  it('offers no unlink at all without instruments.edit', () => {
    render(<GatewayPanel instrumentId="gw-1" canEdit={false} />);
    expect(screen.getByText('CH-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^unlink$/i })).not.toBeInTheDocument();
  });
});
