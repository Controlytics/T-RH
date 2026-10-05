import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Audit 2026-10-03, DATA-11: a visibility-scope save carries the operator's
 * REASON (the server refuses one without it — 400 REASON_REQUIRED — and stores
 * it on the CONFIG_CHANGED row), and the save goes through the UPDATE_ROLE_CONFIG
 * re-auth the server has always applied (until now the tab called `put` bare,
 * so a role whose matrix asked for a password could never save at all).
 */
const mutate = vi.fn(async () => undefined);
const SCOPES = { roles: [{ role: 'OPERATOR', scope: null }], users: [] };
const EMPTY = { data: [] };
vi.mock('swr', () => ({
  default: (key: string) => {
    if (key === '/api/roles/instrument-scope') return { data: SCOPES, mutate };
    if (key === '/api/functional-locations' || key === '/api/roles/instrument-scope/instruments') return { data: EMPTY, mutate };
    return { data: undefined, mutate };
  },
}));
const executed: string[] = [];
const withPassword = { current: false };
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void }) => {
      executed.push(action);
      await cb(withPassword.current ? 'pw' : undefined);
      opts?.onSuccess?.();
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
const put = vi.fn(async () => ({}));
const putWithReauth = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])), putWithReauth: (...a: unknown[]) => putWithReauth(...(a as [])) } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const { InstrumentScopeTab } = await import('../instrument-scope-tab');

beforeEach(() => { put.mockClear(); putWithReauth.mockClear(); executed.length = 0; withPassword.current = false; });

describe('InstrumentScopeTab — the reason and the re-auth', () => {
  it('Save stays disabled until a reason is typed; the save sends { scope, reason } under UPDATE_ROLE_CONFIG', async () => {
    render(<InstrumentScopeTab />);
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'operators see the whole plant' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/roles/instrument-scope/role/OPERATOR',
      { scope: null, reason: 'operators see the whole plant' },
    ));
    expect(executed).toEqual(['UPDATE_ROLE_CONFIG']);
  });

  it('with a password the save goes through putWithReauth, reason included', async () => {
    withPassword.current = true;
    render(<InstrumentScopeTab />);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'audit finding' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith(
      '/api/roles/instrument-scope/role/OPERATOR',
      { scope: null, reason: 'audit finding' },
      'pw',
    ));
    expect(put).not.toHaveBeenCalled();
  });
});
