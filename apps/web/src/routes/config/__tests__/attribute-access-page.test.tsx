import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Configuration → Attribute Edit Access (2026-10-24, operator: "who can edit
 * which attributes … configurable role wise or user wise"). The Roles tab is
 * the editor moved from Roles & Access; the Users tab edits one user's own
 * rule and shows — as the SERVER computed them — their role's rule, the
 * combined result, and a warning when their role lacks Edit Instruments. The
 * swr mock returns MODULE-LEVEL constants (a fresh object per call loops).
 */
const ROLES = { roles: [{ role: 'QA', mode: 'ALL_VIEW', keys: [], requireReauth: false, canUpdateInstruments: false }], availableKeys: ['Room', 'Area'] };
const USERS = { users: [
  { userId: 'u1', username: '333333', fullName: 'Q A', role: 'QA', status: 'ENABLED', mode: null, keys: [], requireReauth: false,
    effective: { mode: 'ALL_VIEW', keys: [], requireReauth: false }, roleHasUpdate: false },
  { userId: 'u2', username: '444444', fullName: 'Lead', role: 'QA', status: 'LOCKED', mode: 'SELECTED', keys: ['Room'], requireReauth: true,
    effective: { mode: 'SELECTED', keys: ['Room'], requireReauth: true }, roleHasUpdate: true },
] };
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: key === '/api/roles/attribute-access' ? ROLES : key === '/api/roles/attribute-access/users' ? USERS : undefined,
    mutate: vi.fn(async () => undefined),
  }),
}));
const put = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])), putWithReauth: vi.fn() } }));
const executed: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void }) => {
      executed.push(action);
      await cb(undefined);
      opts?.onSuccess?.();
    },
    isOpen: false, password: '', error: '', isVerifying: false, setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));
const toastError = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn() } }) }));
vi.mock('@/hooks/use-attribute-labels', () => ({ useAttributeLabels: () => ({ labelFor: (k: string) => k }) }));

const { AttributeAccessConfigPage } = await import('../attribute-access');
const mount = () => render(<MemoryRouter><AttributeAccessConfigPage /></MemoryRouter>);
const openUser = async (who = /333333/) => {
  fireEvent.click(screen.getByRole('tab', { name: 'Users' }));
  fireEvent.click(screen.getByRole('button', { name: /select a user/i }));
  fireEvent.click(await screen.findByText(who));
};

beforeEach(() => { put.mockClear(); toastError.mockClear(); executed.length = 0; });

describe('Configuration → Attribute Edit Access', () => {
  it('opens on the Roles tab with the role editor', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Attribute Edit Access');
    expect(screen.getByText('QA')).toBeInTheDocument();
  });

  it("Users tab: a chosen user shows their role's rule, the combined result, and the Edit Instruments warning", async () => {
    mount();
    await openUser();
    expect(screen.getByTestId('user-role-rule')).toHaveTextContent('All view-only');
    expect(screen.getByTestId('user-effective-rule')).toHaveTextContent('All view-only');
    expect(screen.getByTestId('user-rule-no-update')).toBeInTheDocument();
  });

  it('a user save needs a reason, then PUTs the user route under UPDATE_ROLE_CONFIG with it', async () => {
    mount();
    await openUser();
    fireEvent.click(screen.getByLabelText('All editable'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(put).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Reason required', expect.any(String));
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'QA lead edits limits' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/api/roles/attribute-access/user/u1', { mode: 'ALL_EDIT', keys: [], requireReauth: false, reason: 'QA lead edits limits' });
    expect(executed).toEqual(['UPDATE_ROLE_CONFIG']);
  });

  // Review fixes (2026-10-24).
  it('offers no "All view-only" for a user — under "combine" it would restrict nothing', async () => {
    mount();
    await openUser();
    expect(screen.queryByLabelText('All view-only')).toBeNull();
    expect(screen.getByLabelText('All editable')).toBeInTheDocument();
  });

  it('a locked user is listed with their status; what applies says when a password is required; the role-change warning shows', async () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }));
    fireEvent.click(screen.getByRole('button', { name: /select a user/i }));
    expect(await screen.findByText(/444444.*LOCKED/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/444444.*LOCKED/));
    expect(screen.getByTestId('user-effective-rule')).toHaveTextContent('password required');
    expect(screen.getByTestId('user-rule-survives-role')).toBeInTheDocument();
  });

  it('no role-change warning for a user with no rule of their own', async () => {
    mount();
    await openUser();
    expect(screen.queryByTestId('user-rule-survives-role')).toBeNull();
  });
});
