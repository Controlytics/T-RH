import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Audit 2026-10-12, finding 10. Cancelling the password dialog is not an error.
 * The REAL `useReauth` hook is used here (only SWR and the transport are
 * mocked): when a caller passes no `onCancel`, the hook falls back to `onError`
 * with a REAUTH_CANCELLED sentinel, and the Profile page and every dynamic
 * config page rendered that as a red "Cancelled — password confirmation was not
 * completed." banner. Both now pass `onCancel`, which only re-enables the form.
 */
const MY_ACTIONS = { actions: ['UPDATE_PROFILE', 'UPDATE_SESSION_CONFIG', 'CREATE_ROLE'] };
const MANIFEST = [{
  moduleKey: 'session', moduleName: 'Session', description: '', icon: '', category: 'Security',
  requiresReauth: true, hasCustomPage: false,
  settings: [{ key: 'idleMinutes', type: 'number', label: 'Idle minutes', default: 15 }],
}];
const SAVED = { idleMinutes: 15 };
const ROLES: unknown[] = [];
const mutate = vi.fn(async () => undefined);
vi.mock('swr', () => ({
  useSWRConfig: () => ({ mutate }),
  default: (key: string | null) => {
    if (key === '/api/config/action-reauth/my-actions') return { data: MY_ACTIONS, mutate };
    if (key === '/api/config/registry/manifest') return { data: MANIFEST, mutate };
    if (key === '/api/config/dynamic/session') return { data: SAVED, mutate };
    if (key === '/api/roles' || key === '/api/roles/active') return { data: ROLES, mutate };
    return { data: undefined, mutate };
  },
}));
const put = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => put(...(a as [])), putWithReauth: vi.fn(), get: vi.fn(async () => []) },
}));
const USER = {
  id: 'me', username: 'superadmin', fullName: 'Super Admin', email: 'a@b.c', department: '', photoUrl: '',
  role: 'SUPER_ADMIN', status: 'ENABLED', permissions: [], lastLogin: null, createdAt: null,
};
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: USER, mutate }) }));
vi.mock('@/hooks/use-branding', () => ({ useBranding: () => ({ branding: {} }) }));

beforeEach(() => { put.mockClear(); });

const cancelDialog = () => {
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
};

describe('Cancelling the password dialog is a no-op, not an error', () => {
  it('Profile: no error banner, and the form can be submitted again', async () => {
    const { ProfilePage } = await import('../../profile/index');
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    cancelDialog();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(/cancelled/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    expect(put).not.toHaveBeenCalled();
  });

  it('Dynamic config page: no error banner, and Save is offered again', async () => {
    const { DynamicConfigPage } = await import('../dynamic-config');
    render(
      <MemoryRouter initialEntries={['/config/session']}>
        <Routes><Route path="/config/:moduleKey" element={<DynamicConfigPage />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByDisplayValue('15'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    cancelDialog();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(/cancelled/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('Roles & Access — Save stays busy while the password is being asked for', () => {
  it('Create Role keeps its busy state until the dialog is answered, then cancel frees it', async () => {
    const { RoleAccessPage } = await import('../role-access');
    render(<MemoryRouter><RoleAccessPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /create role/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g., QUALITY_ASSURANCE'), { target: { value: 'QA' } });
    fireEvent.change(screen.getByPlaceholderText('e.g., Quality Assurance'), { target: { value: 'Quality' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^create role$/i }).at(-1)!);
    // The password dialog is open: the form's button must still read busy.
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /creating/i })).toBeInTheDocument();
    const reauthDialog = screen.getByLabelText(/password/i).closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(reauthDialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /creating/i })).not.toBeInTheDocument());
    expect(put).not.toHaveBeenCalled();
  });
});
