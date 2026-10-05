import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * audit 2026-10-03, SEC-7: `DELETE_INSTRUMENT_PROFILE` is an admin-configurable
 * re-auth action the server checks FIRST. The profile list's delete goes through
 * the shared hook, so a policy switched on prompts for the password instead of
 * surfacing a raw REAUTH_REQUIRED toast.
 */

const profiles = [
  { id: 'p1', name: 'RS485 T/RH', description: null, isActive: true, instrumentCount: 0, activeCount: 0 },
];
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instrument-profiles') return { data: { data: profiles }, mutate, isLoading: false };
    return { data: undefined, mutate: vi.fn(), isLoading: false };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { delete: (...a: unknown[]) => del(...a), deleteWithReauth: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
const reauthActions: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      reauthActions.push(action);
      try { await cb(); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentProfileListPage } = await import('../profile-list');

beforeEach(() => { del.mockReset().mockResolvedValue({}); mutate.mockReset(); reauthActions.length = 0; });

describe('InstrumentProfileListPage — delete', () => {
  it('signs the delete under DELETE_INSTRUMENT_PROFILE and refreshes the list', async () => {
    render(<MemoryRouter><InstrumentProfileListPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile RS485 T/RH' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/instrument-profiles/p1'));
    expect(reauthActions).toEqual(['DELETE_INSTRUMENT_PROFILE']);
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });
});
