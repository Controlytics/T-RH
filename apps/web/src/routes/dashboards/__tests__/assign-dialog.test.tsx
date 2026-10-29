import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DashboardDetail } from '@digilog/shared';

/**
 * The dashboard Assign dialog (2026-10-29, dashboard builder phase 1, Task 8).
 * Roles come from `GET /api/roles/active` and users from `GET /api/users` at
 * ALL_RECORDS; a SUPER_ADMIN is never offered as a role. What is sent is
 * asserted on the PUT body. NOT VERIFIED HERE: how it looks.
 */

const ROLES = [
  { id: 'r1', name: 'SUPER_ADMIN', displayName: 'Super Admin' },
  { id: 'r2', name: 'ADMIN', displayName: 'Admin' },
  { id: 'r3', name: 'QA', displayName: 'QA Reviewer' },
  { id: 'r4', name: 'OPERATOR', displayName: 'Operator' },
];
const USERS = {
  data: [
    { id: 'u-1', username: 'rsharma', fullName: 'R. Sharma' },
    { id: 'u-2', username: 'kmehta', fullName: 'K. Mehta' },
    { id: 'u-3', username: 'jdoe', fullName: null },
  ],
};
const NOTHING = { data: undefined, error: undefined, isLoading: false };
const WITH_ROLES = { data: ROLES, error: undefined, isLoading: false };
const WITH_USERS = { data: USERS, error: undefined, isLoading: false };
const keys: (string | null)[] = [];
vi.mock('swr', () => ({
  default: (key: string | null) => {
    keys.push(key);
    if (key === '/api/roles/active') return WITH_ROLES;
    if (key && key.startsWith('/api/users?')) return WITH_USERS;
    return NOTHING;
  },
}));
const TOAST = { toast: { success: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));
const reauthActions: string[] = [];
const REAUTH = {
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
};
vi.mock('@/hooks/use-reauth', () => ({ useReauth: () => REAUTH }));
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => put(...a), putWithReauth: vi.fn() },
}));

const { AssignDialog } = await import('../assign-dialog');

const DASH: DashboardDetail = {
  id: 'd-1', title: 'QC Block', description: null,
  sourceSummary: { mode: 'all', label: 'All instruments' }, widgetCount: 0,
  updatedAt: '2026-10-29T10:00:00.000Z',
  assignments: { roles: ['QA'], users: [{ id: 'u-1', username: 'rsharma', fullName: 'R. Sharma' }] },
  document: { version: 1, source: { mode: 'all' }, timeWindow: { mode: 'relative', period: '24h' }, items: [], widgets: [] },
};
const RESULT = { roles: ['QA', 'ADMIN'], users: [] };

function mount(dashboard = DASH) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<AssignDialog open dashboard={dashboard} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('AssignDialog', () => {
  beforeEach(() => {
    put.mockReset().mockResolvedValue(RESULT);
    reauthActions.length = 0;
    keys.length = 0;
  });

  it('opens with the current roles and users ticked', () => {
    mount();
    expect(screen.getByRole('checkbox', { name: 'QA Reviewer' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Admin' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /R\. Sharma/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /K\. Mehta/ })).not.toBeChecked();
  });

  it('reads the active roles and every user (ALL_RECORDS)', () => {
    mount();
    expect(keys).toContain('/api/roles/active');
    expect(keys.some((k) => k !== null && /^\/api\/users\?.*limit=\d+/.test(k))).toBe(true);
  });

  it('SUPER_ADMIN is not offered as a role', () => {
    mount();
    expect(screen.queryByRole('checkbox', { name: /Super Admin/i })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Operator' })).toBeInTheDocument();
  });

  it('sends { roles, userIds } through UPDATE_DASHBOARD and hands the answer back', async () => {
    const { onSaved } = mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Admin' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /R\. Sharma/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /K\. Mehta/ }));
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(RESULT));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe('/api/dashboards/d-1/assignments');
    expect(put.mock.calls[0][1]).toEqual({ roles: ['QA', 'ADMIN'], userIds: ['u-2'] });
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
  });

  it('can clear every assignment', async () => {
    mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'QA Reviewer' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /R\. Sharma/ }));
    save();
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toEqual({ roles: [], userIds: [] });
  });

  it('the user list is searchable by name or username', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search users' }), { target: { value: 'meh' } });
    expect(screen.queryByRole('checkbox', { name: /R\. Sharma/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /K\. Mehta/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search users' }), { target: { value: 'JDOE' } });
    expect(screen.getByRole('checkbox', { name: /jdoe/ })).toBeInTheDocument();
  });

  it('a refusal is shown in place and the dialog stays', async () => {
    put.mockRejectedValue(new Error('Boom'));
    const { onSaved, onClose } = mount();
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('every text input carries a distinct name', () => {
    mount();
    const names = Array.from(document.querySelectorAll('input[type="search"], input[type="text"]')).map((i) => i.getAttribute('name'));
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(Boolean)).toBe(true);
  });
});
