import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Audit 2026-10-03, DATA-11: the Users page sends the operator's REASON with a
 * delete and a disable. The server refuses both without one, so the page
 * must never send `{}` for them — this is the client half of the mutation
 * check (the server half is `users.test.ts`: `{}` → 400 REASON_REQUIRED).
 */
const user = {
  id: 'u-1', username: 'ada', fullName: 'Ada Lovelace', email: 'ada@example.com', role: 'OPERATOR',
  status: 'ENABLED', isActive: true, isLocked: false, department: 'QA', createdAt: '2026-08-24T00:00:00.000Z',
  lastLoginAt: null, passwordExpiresAt: null, ldapDn: null, authSource: 'local',
};
// STABLE responses — see pages-render.test.tsx for why a fresh object per
// call hangs vitest.
const mutate = vi.fn();
const roles = [{ name: 'OPERATOR', label: 'Operator', color: 'bg-sky-600' }];
const RESPONSES: Record<string, unknown> = {
  users: { data: [user], total: 1, page: 1, totalPages: 1 },
  '/api/users/stats': { total: 1, enabled: 1, disabled: 0, locked: 0, expired: 0 },
  '/api/users/reset-requests/pending': { count: 0 },
  '/api/config/password-policy': { minLength: 8 },
};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/users?')) return { data: RESPONSES.users, mutate };
    if (typeof key === 'string' && key.includes('/roles')) return { data: roles, mutate };
    if (typeof key === 'string' && key in RESPONSES) return { data: RESPONSES[key], mutate };
    return { data: undefined, mutate };
  },
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-field-labels', () => ({
  useFieldLabels: () => ({
    labels: {}, getLabel: (_id: string, fallback?: string) => fallback ?? _id, isLoading: false,
    userLabels: { userId: 'User ID', fullName: 'Full Name', email: 'Email', department: 'Department', role: 'Role' },
  }),
}));
vi.mock('@/hooks/use-role-colors', () => ({
  useRoleColors: () => ({ roleColors: { OPERATOR: 'bg-sky-600 text-white' }, rolesData: [{ name: 'OPERATOR', label: 'Operator', color: 'bg-sky-600' }] }),
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d }),
}));
vi.mock('@/hooks/use-pagination-config', () => ({
  usePaginationConfig: () => [25, 50, 100],
  usePaginationDefaults: () => ({ defaultLimit: 25, pageSizeOptions: [25, 50, 100] }),
}));
// `withPassword` flips the hook between the "no re-auth needed" path (cb()) and
// the dialog path (cb(password)), so both API client branches are seen.
const withPassword = { current: false };
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(withPassword.current ? 'pw' : undefined); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
const api = {
  get: vi.fn(), post: vi.fn(async () => ({})), put: vi.fn(), delete: vi.fn(async () => ({})),
  postWithReauth: vi.fn(async () => ({})), putWithReauth: vi.fn(), deleteWithReauth: vi.fn(async () => ({})),
};
vi.mock('@/lib/api-client', () => ({ apiClient: api }));

const { UserListPage } = await import('../list');
const mount = () => render(<MemoryRouter initialEntries={['/users']}><UserListPage /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); withPassword.current = false; });

describe('Users page — delete and disable carry the reason', () => {
  it('delete: the dialog will not confirm without a reason, then DELETEs with { reason }', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirm = screen.getByRole('button', { name: /delete user/i });
    expect(confirm).toBeDisabled();
    expect(api.delete).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'left the company' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/users/u-1', { reason: 'left the company' }));
    // Never `{}` — the server refuses it.
    expect(api.delete).not.toHaveBeenCalledWith('/api/users/u-1', {});
  });

  it('delete through the re-auth dialog carries the reason in the body beside the password', async () => {
    withPassword.current = true;
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'duplicate account' } });
    fireEvent.click(screen.getByRole('button', { name: /delete user/i }));
    await waitFor(() => expect(api.deleteWithReauth).toHaveBeenCalledWith('/api/users/u-1', 'pw', { reason: 'duplicate account' }));
  });

  it('disable: POSTs { reason }, never {}', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^disable$/i }));
    const confirm = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'on leave' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/users/u-1/disable', { reason: 'on leave' }));
    expect(api.post).not.toHaveBeenCalledWith('/api/users/u-1/disable', {});
  });
});
