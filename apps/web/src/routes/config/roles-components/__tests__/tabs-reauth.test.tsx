import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Audit 2026-10-12, finding 5. These saves hit routes the server re-authenticates
 * (`enforceReauth`) but went out as bare `apiClient.put`, so a role whose
 * action-reauth matrix asked for a password could never save them — it got a
 * bare 401 instead of the dialog:
 *
 *   Sidebar tab (role)          PUT /api/config/roles/:role          UPDATE_ROLE_CONFIG
 *   Sidebar tab (user, reset)   PUT /api/config/users/:id            UPDATE_USER_CONFIG
 *   Attribute Access tab        PUT /api/roles/attribute-access/:r   UPDATE_ROLE_CONFIG
 *   Panels tab (role / user)    PUT /api/roles/panel-access/...      UPDATE_ROLE_CONFIG
 *   Re-auth tab                 PUT /api/config/action-reauth        UPDATE_REAUTH_CONFIG
 *   User ID page                PUT /api/config/user-id              UPDATE_USERID_CONFIG
 *
 * Each now runs through `reauth.execute`, as the Permissions tab already did.
 */
const mutate = vi.fn(async () => undefined);
const ATTR = {
  roles: [{ role: 'OPERATOR', mode: null, keys: [], requireReauth: false, canUpdateInstruments: true }],
  availableKeys: ['Building'],
};
const PANELS_DATA = { roles: [{ role: 'OPERATOR', panels: null }], users: [] };
const ROLE_CONFIG = { sidebarItems: ['dashboard'] };
const USERS = { data: [{ id: 'u-9', username: 'bob', fullName: 'Bob Builder', role: 'ADMIN' }] };
const REAUTH_CONFIG = { DELETE_USER: ['ADMIN'] };
const USER_ID = {
  format: 'LETTERS_NUMBERS', length: 6, prefix: '', prefixSeparator: '-', letterCase: 'UPPERCASE',
  autoGenerate: false, startNumber: 1, customPattern: '', customPatternExample: '', customPatternDescription: '',
};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/roles/attribute-access') return { data: ATTR, mutate };
    if (key === '/api/roles/panel-access') return { data: PANELS_DATA, mutate };
    if (key === '/api/config/roles/ADMIN') return { data: ROLE_CONFIG, mutate, isLoading: false, isValidating: false };
    if (key === '/api/config/action-reauth') return { data: REAUTH_CONFIG, mutate, isLoading: false };
    if (key === '/api/config/user-id') return { data: USER_ID, mutate };
    if (key === '/api/users') return { data: USERS, mutate, isLoading: false };
    if (key === '/api/config/users/u-9') return { data: ROLE_CONFIG, mutate, isLoading: false, isValidating: false };
    return { data: undefined, mutate };
  },
  useSWRConfig: () => ({ mutate }),
}));

const executed: string[] = [];
const withPassword = { current: false };
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      executed.push(action);
      try { await cb(withPassword.current ? 'pw' : undefined); await opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
const put = vi.fn(async () => ({}));
const putWithReauth = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    put: (...a: unknown[]) => put(...(a as [])),
    putWithReauth: (...a: unknown[]) => putWithReauth(...(a as [])),
    post: vi.fn(async () => ({})),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-attribute-labels', () => ({ useAttributeLabels: () => ({ labelFor: (k: string) => k }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', role: 'SUPER_ADMIN', permissions: [] } }),
}));

beforeEach(() => {
  put.mockClear(); putWithReauth.mockClear(); executed.length = 0; withPassword.current = true;
});

describe('Roles & Access tabs — saves are re-authenticated', () => {
  it('Sidebar tab (role) signs as UPDATE_ROLE_CONFIG and sends the password', async () => {
    const { SidebarTab } = await import('../sidebar-tab');
    const ref = createRef<{ save: () => Promise<void> }>();
    render(<SidebarTab ref={ref} activeRoles={[{ name: 'ADMIN', displayName: 'Admin' } as never]} onStateChange={() => {}} />);
    await act(async () => { await ref.current!.save(); });
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith(
      '/api/config/roles/ADMIN', expect.objectContaining({ sidebarItems: expect.any(Array) }), 'pw',
    ));
    expect(executed).toEqual(['UPDATE_ROLE_CONFIG']);
    expect(put).not.toHaveBeenCalled();
  });

  it('Sidebar tab (user) save and reset sign as UPDATE_USER_CONFIG', async () => {
    const { SidebarTab } = await import('../sidebar-tab');
    const ref = createRef<{ save: () => Promise<void> }>();
    render(<SidebarTab ref={ref} activeRoles={[{ name: 'ADMIN', displayName: 'Admin' } as never]} onStateChange={() => {}} />);
    fireEvent.click(screen.getByText('Configure by User'));
    fireEvent.click(screen.getByText('Bob Builder'));
    await act(async () => { await ref.current!.save(); });
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith(
      '/api/config/users/u-9', expect.objectContaining({ sidebarItems: expect.any(Array) }), 'pw',
    ));
    fireEvent.click(screen.getByRole('button', { name: /reset to role default/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith('/api/config/users/u-9', { sidebarItems: [] }, 'pw'));
    expect(executed).toEqual(['UPDATE_USER_CONFIG', 'UPDATE_USER_CONFIG']);
    expect(put).not.toHaveBeenCalled();
  });

  it('Attribute Access tab signs as UPDATE_ROLE_CONFIG', async () => {
    const { AttributeAccessTab } = await import('../attribute-access-tab');
    render(<AttributeAccessTab />);
    fireEvent.click(screen.getAllByRole('radio')[1]);
    // A reason is required since 2026-10-24 — the server refuses a save without one.
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'operators edit limits' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith(
      '/api/roles/attribute-access/OPERATOR', expect.objectContaining({ reason: 'operators edit limits' }), 'pw',
    ));
    expect(executed).toEqual(['UPDATE_ROLE_CONFIG']);
  });

  it('Panels tab signs as UPDATE_ROLE_CONFIG', async () => {
    const { PanelAccessTab } = await import('../panel-access-tab');
    render(<PanelAccessTab />);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith(
      '/api/roles/panel-access/role/OPERATOR', { panels: null }, 'pw',
    ));
    expect(executed).toEqual(['UPDATE_ROLE_CONFIG']);
  });

  it('Re-auth tab signs as UPDATE_REAUTH_CONFIG', async () => {
    const { ReauthTab } = await import('../reauth-tab');
    const ref = createRef<{ save: () => Promise<void>; reset: () => void }>();
    render(<ReauthTab ref={ref} selectableRoles={[]} onStateChange={() => {}} />);
    await act(async () => { await ref.current!.save(); });
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith('/api/config/action-reauth', REAUTH_CONFIG, 'pw'));
    expect(executed).toEqual(['UPDATE_REAUTH_CONFIG']);
  });

  it('User ID page signs as UPDATE_USERID_CONFIG', async () => {
    const { UserIdConfigPage } = await import('../../user-id');
    render(<MemoryRouter><UserIdConfigPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith(
      '/api/config/user-id', expect.objectContaining({ format: 'LETTERS_NUMBERS' }), 'pw',
    ));
    expect(executed).toEqual(['UPDATE_USERID_CONFIG']);
  });
});
