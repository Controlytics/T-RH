import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef } from 'react';

/**
 * Audit 2026-10-03, DATA-11 (closed 2026-10-05): the Permissions tab is where
 * a role's permissions actually change from the UI. The server now refuses a
 * change to the permission SET without a reason (400 REASON_REQUIRED) and
 * stores it on the CONFIG_CHANGED row, and challenges the save under
 * UPDATE_ROLE_CONFIG — so the tab collects the reason and saves through the
 * re-auth hook (it called `put` bare until now).
 */
const mutate = vi.fn(async () => undefined);
const ROLE_CONFIG = { permissions: {} };
const notified = new Set<string>();
vi.mock('swr', () => ({
  default: (key: string, opts?: { onSuccess?: (d: unknown) => void }) => {
    if (typeof key === 'string' && key.startsWith('/api/config/roles/')) {
      // SWR fires onSuccess AFTER the fetch, never during render; a synchronous
      // call here would set state mid-render and loop. Once per key, deferred.
      if (!notified.has(key)) { notified.add(key); queueMicrotask(() => opts?.onSuccess?.(ROLE_CONFIG)); }
      return { data: ROLE_CONFIG, isLoading: false, mutate };
    }
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
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));
const put = vi.fn(async () => ({}));
const putWithReauth = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])), putWithReauth: (...a: unknown[]) => putWithReauth(...(a as [])) } }));
const toastError = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: toastError } }) }));

const { PermissionsTab } = await import('../permissions-tab');
type Handle = { save: () => Promise<void> };

const ROLES = [{ name: 'OPERATOR', displayName: 'Operator', hierarchyLevel: 50, isActive: true, isSystem: false, permissions: [], description: '' }];

beforeEach(() => { notified.clear(); put.mockClear(); putWithReauth.mockClear(); toastError.mockClear(); mutate.mockClear(); executed.length = 0; withPassword.current = false; });

const renderTab = () => {
  const ref = createRef<Handle>();
  render(<PermissionsTab ref={ref} selectableRoles={ROLES as never} onStateChange={() => undefined} />);
  // The tab opens on ADMIN; pick the role under test.
  fireEvent.click(screen.getByText('Operator'));
  return ref;
};

describe('PermissionsTab — the reason and the re-auth', () => {
  it('a save with no reason sends nothing and says why', async () => {
    const ref = renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: /enable all/i })[0]);
    await ref.current!.save();
    expect(put).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Reason required', expect.any(String));
    expect(executed).toEqual([]);
  });

  it('with a reason the save sends { permissions, reason } under UPDATE_ROLE_CONFIG', async () => {
    const ref = renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: /enable all/i })[0]);
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'operators now acknowledge alarms' } });
    await ref.current!.save();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as unknown as [string, { permissions: Record<string, boolean>; reason: string }];
    expect(url).toBe('/api/config/roles/OPERATOR');
    expect(body.reason).toBe('operators now acknowledge alarms');
    expect(Object.values(body.permissions).some(Boolean)).toBe(true);
    expect(executed).toEqual(['UPDATE_ROLE_CONFIG']);
  });

  it('with a password the save goes through putWithReauth, reason included', async () => {
    withPassword.current = true;
    const ref = renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: /enable all/i })[0]);
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'granting the dashboard' } });
    await ref.current!.save();
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledTimes(1));
    const [, body, pw] = putWithReauth.mock.calls[0] as unknown as [string, { reason: string }, string];
    expect(body.reason).toBe('granting the dashboard');
    expect(pw).toBe('pw');
    expect(put).not.toHaveBeenCalled();
  });

  // 2026-10-24: the server derives the toggles from what the role HOLDS, so
  // after a save the tab re-reads them rather than keeping its own guess
  // (Settings Edit and Edit Instruments share one grant, for example).
  it('re-reads the role\'s toggles from the server after a save, and not before', async () => {
    const ref = renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: /enable all/i })[0]);
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'granting the dashboard' } });
    await ref.current!.save();
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledTimes(1);
  });
});
