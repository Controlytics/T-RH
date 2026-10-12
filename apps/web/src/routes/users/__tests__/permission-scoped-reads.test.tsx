import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Audit 2026-10-12, findings 8 and 9 — the Users pages must only READ what the
 * caller is allowed to read.
 *
 * 8. They read the password policy from `GET /api/config/password-policy`,
 *    which is CONFIG_READ-only (`configEndpoint` in config/routes.ts). A user
 *    administrator without CONFIG_READ got a 403 there and the forms fell back
 *    to the DEFAULT policy, so the hints and client checks described a policy
 *    the server was not applying. `/api/config/password-policy/current` serves
 *    the same object to every authenticated user.
 * 9. The list page fetched `/api/users/reset-requests/pending`
 *    (USER_RESET_PASSWORD) for every USER_READ caller; it is fetched only when
 *    `users.reset_password` is granted, which is also the only time its count
 *    is shown.
 */
const user = {
  id: 'u-1', username: 'ada', fullName: 'Ada Lovelace', email: 'ada@example.com', role: 'OPERATOR',
  status: 'ACTIVE', isActive: true, isLocked: false, department: 'QA', createdAt: '2026-08-24T00:00:00.000Z',
  lastLoginAt: null, passwordExpiresAt: null, ldapDn: null, authSource: 'LOCAL',
};
const mutate = vi.fn();
const POLICY = { minLength: 12 };
const USERS = { data: [user], total: 1, page: 1, totalPages: 1 };
const STATS = { total: 1, enabled: 1, disabled: 0, locked: 0, expired: 0 };
const ROLES = [{ name: 'OPERATOR', label: 'Operator', color: 'bg-sky-600' }];
const REQUESTS = { data: [] };
const requested: string[] = [];
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string') requested.push(key);
    if (typeof key === 'string' && key.startsWith('/api/users?')) return { data: USERS, mutate };
    if (key === '/api/users/stats') return { data: STATS, mutate };
    if (key === '/api/users/u-1') return { data: user, mutate };
    if (key === '/api/users/reset-requests') return { data: REQUESTS, mutate };
    if (typeof key === 'string' && key.includes('/roles')) return { data: ROLES, mutate };
    if (key === '/api/config/password-policy/current') return { data: POLICY, mutate };
    return { data: undefined, mutate };
  },
}));
let grants = new Set<string>();
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => grants.has(node) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'admin', fullName: 'User Admin', role: 'ADMIN', permissions: ['USER_READ'] } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-field-labels', () => ({
  useFieldLabels: () => ({
    labels: {}, getLabel: (_id: string, fallback?: string) => fallback ?? _id, isLoading: false,
    userLabels: { userId: 'User ID', fullName: 'Full Name', email: 'Email', department: 'Department', role: 'Role' },
  }),
}));
vi.mock('@/hooks/use-role-colors', () => ({
  useRoleColors: () => ({ roleColors: { OPERATOR: 'bg-sky-600 text-white' }, rolesData: ROLES }),
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d }),
}));
vi.mock('@/hooks/use-pagination-config', () => ({
  usePaginationConfig: () => [25, 50, 100],
  usePaginationDefaults: () => ({ defaultLimit: 25, pageSizeOptions: [25, 50, 100], options: [25, 50, 100] }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(), deleteWithReauth: vi.fn() },
}));

const at = (path: string, routePath: string, el: React.ReactElement) => render(
  <MemoryRouter initialEntries={[path]}><Routes><Route path={routePath} element={el} /></Routes></MemoryRouter>,
);

beforeEach(() => { requested.length = 0; grants = new Set(); });

describe('Users pages read the all-users password policy', () => {
  it.each([
    ['list', '/users', '/users', async () => (await import('../list')).UserListPage],
    ['create', '/users/new', '/users/new', async () => (await import('../create')).CreateUserPage],
    ['edit', '/users/u-1/edit', '/users/:id/edit', async () => (await import('../edit')).EditUserPage],
    ['reset requests', '/users/reset-requests', '/users/reset-requests', async () => (await import('../reset-requests')).ResetRequestsPage],
  ])('%s page', async (_name, path, routePath, load) => {
    const Page = await load();
    at(path, routePath, <Page />);
    expect(requested).toContain('/api/config/password-policy/current');
    expect(requested).not.toContain('/api/config/password-policy');
  });
});

describe('Users list — the pending reset count is read only when it may be', () => {
  it('without users.reset_password, /reset-requests/pending is not requested', async () => {
    const { UserListPage } = await import('../list');
    at('/users', '/users', <UserListPage />);
    expect(requested).not.toContain('/api/users/reset-requests/pending');
  });

  it('with users.reset_password, it is', async () => {
    grants = new Set(['users.reset_password']);
    const { UserListPage } = await import('../list');
    at('/users', '/users', <UserListPage />);
    expect(requested).toContain('/api/users/reset-requests/pending');
  });
});
