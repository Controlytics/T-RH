import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The four Users pages had no render test before UI v3 (2026-09-21). These
 * pin the page SHAPE on the shared primitives — the hero band with the
 * screen's actions inside it, the StatCards, the shared table band — which is
 * the wiring a restyle can break while every unit test stays green.
 */
const user = {
  id: 'u-1', username: 'ada', fullName: 'Ada Lovelace', email: 'ada@example.com', role: 'OPERATOR',
  status: 'ACTIVE', isActive: true, isLocked: false, department: 'QA', createdAt: '2026-08-24T00:00:00.000Z',
  lastLoginAt: null, passwordExpiresAt: null, ldapDn: null, authSource: 'LOCAL',
};
const request = {
  id: 'r-1', userId: 'u-1', userFullName: 'Ada Lovelace', username: 'ada', status: 'APPROVED',
  requestedAt: '2026-09-20T10:00:00.000Z', processedAt: '2026-09-20T11:00:00.000Z', processedBy: 'superadmin', processedByName: 'Super Admin',
};

// STABLE responses — one object per key, never a fresh literal per call. A
// page effect keyed on `data` re-runs on every render when the identity
// changes, and with a fresh object each call that is an infinite loop that
// never throws (this file hung vitest for two minutes before this comment).
const mutate = vi.fn();
const roles = [{ name: 'OPERATOR', label: 'Operator', color: 'bg-sky-600' }];
const RESPONSES: Record<string, unknown> = {
  users: { data: [user], total: 1, page: 1, totalPages: 1 },
  '/api/users/stats': { total: 1, enabled: 1, disabled: 0, locked: 0, expired: 0 },
  '/api/users/reset-requests/pending': { count: 0 },
  '/api/users/reset-requests': { data: [request] },
  '/api/users/u-1': user,
  roles,
  '/api/config/password-policy/current': { minLength: 8 },
};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/users?')) return { data: RESPONSES.users, mutate };
    if (typeof key === 'string' && key.includes('/roles')) return { data: RESPONSES.roles, mutate };
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

describe('Users pages — UI v3 shape', () => {
  it('list opens with the hero band carrying Create User, and four StatCards', async () => {
    const { UserListPage } = await import('../list');
    at('/users', '/users', <UserListPage />);
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('link', { name: /create user/i }))).toBe(true);
    expect(screen.getAllByTestId('stat-card')).toHaveLength(4);
    expect(screen.getByText('Total users')).toBeInTheDocument();
  });

  it('create opens with the hero band carrying Back to Users', async () => {
    const { CreateUserPage } = await import('../create');
    at('/users/create', '/users/create', <CreateUserPage />);
    expect(screen.getByTestId('page-hero').contains(screen.getByRole('link', { name: /back to users/i }))).toBe(true);
  });

  it('reset requests opens with the hero band and its history on the shared table band', async () => {
    const { ResetRequestsPage } = await import('../reset-requests');
    at('/users/reset-requests', '/users/reset-requests', <ResetRequestsPage />);
    expect(screen.getByTestId('page-hero')).toBeInTheDocument();
    expect(document.querySelector('thead')).toHaveAttribute('data-band', 'gradient');
  });

  it('edit opens with the hero band headed by the person', async () => {
    const { EditUserPage } = await import('../edit');
    at('/users/u-1', '/users/:id', <EditUserPage />);
    expect(screen.getByTestId('page-hero').contains(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' }))).toBe(true);
  });
});
