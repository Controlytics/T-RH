import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Application review 2026-10-12, finding 2 — the client half.
 *
 * The server now gates `POST /api/ldap/test-connection` with the
 * UPDATE_LDAP_CONFIG e-signature (the test binds with the service-account
 * credential). The page used to call a bare `apiClient.post`, so once that
 * re-auth was switched on Test Connection could only ever fail. It now goes
 * through `reauth.execute('UPDATE_LDAP_CONFIG', …)`, and with a password it
 * uses `postWithReauth`.
 */
const SAVED = {
  enabled: true, serverUrl: 'ldaps://ad.corp.local:636', bindDN: 'CN=svc,DC=corp,DC=local',
  bindPassword: '********', searchBase: 'DC=corp,DC=local', searchFilter: '(sAMAccountName={{username}})',
  usernameAttribute: 'sAMAccountName', emailAttribute: 'mail', fullNameAttribute: 'displayName',
  departmentAttribute: 'department', groupAttribute: 'memberOf', tlsRejectUnauthorized: true,
  connectionTimeout: 5000, roleMappings: [], defaultRole: 'OPERATOR', syncAttributes: true,
  requiredGroups: [], strictRoleMapping: false,
};
const ROLES = [{ name: 'OPERATOR', displayName: 'Operator' }];
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/ldap/config') return { data: SAVED, mutate };
    if (key === '/api/roles/active') return { data: ROLES, mutate };
    return { data: undefined, mutate };
  },
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', role: 'SUPER_ADMIN', permissions: [] } }),
}));

const executed: string[] = [];
const withPassword = { current: false };
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      executed.push(action);
      try { await cb(withPassword.current ? 'pw' : undefined); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    dialogProps: { open: false, onClose: () => {}, onConfirm: async () => {}, action: '' },
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));

const post = vi.fn(async () => ({ success: true, message: 'Successfully connected' }));
const postWithReauth = vi.fn(async () => ({ success: true, message: 'Successfully connected' }));
vi.mock('../../../lib/api-client', () => ({
  apiClient: { post: (...a: unknown[]) => post(...(a as [])), postWithReauth: (...a: unknown[]) => postWithReauth(...(a as [])), put: vi.fn(), putWithReauth: vi.fn() },
}));

import LdapConfigPage from '../ldap';

const renderPage = () => render(<MemoryRouter><LdapConfigPage /></MemoryRouter>);

describe('LDAP page — Test Connection signs like Save', () => {
  beforeEach(() => { executed.length = 0; post.mockClear(); postWithReauth.mockClear(); withPassword.current = false; });

  it('runs through reauth.execute with UPDATE_LDAP_CONFIG and shows the server\'s answer', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Test Connection/i }));
    await waitFor(() => expect(executed).toEqual(['UPDATE_LDAP_CONFIG']));
    expect(post).toHaveBeenCalledWith('/api/ldap/test-connection', expect.objectContaining({ serverUrl: SAVED.serverUrl }));
    expect(await screen.findByText(/Successfully connected/)).toBeTruthy();
  });

  it('with a password collected it posts with re-auth', async () => {
    withPassword.current = true;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Test Connection/i }));
    await waitFor(() => expect(postWithReauth).toHaveBeenCalledWith('/api/ldap/test-connection', expect.anything(), 'pw'));
    expect(post).not.toHaveBeenCalled();
  });
});
