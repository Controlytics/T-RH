import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Audit 2026-10-03, API-18: the export-options and report-page-titles PUTs
 * are re-authenticated as UPDATE_CONFIG_PAGE on the server. Both pages used to
 * call `apiClient.put` bare, so a role whose matrix asked for a password got a
 * bare 401 and "Save failed". Their saves now run through the shared re-auth
 * hook, like every other configuration page.
 */
const mutate = vi.fn(async () => undefined);
const MATRIX = { OPERATOR: { audit: 'PDF' } };
const ROLES = [{ name: 'OPERATOR', displayName: 'Operator' }, { name: 'SUPER_ADMIN', displayName: 'Super Admin' }];
const TITLES = { companyName: 'Old Co', appName: 'App' };
vi.mock('swr', () => ({
  default: (key: string) => {
    if (key === '/api/config/export-options') return { data: MATRIX, mutate };
    if (key === '/api/roles/active') return { data: ROLES, mutate };
    if (key === '/api/config/report-page-titles') return { data: TITLES, mutate };
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
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-branding', () => ({ useBranding: () => ({ branding: { companyName: 'Brand Co', appName: 'Brand App' } }) }));

beforeEach(() => { put.mockClear(); putWithReauth.mockClear(); executed.length = 0; withPassword.current = false; });

describe('Export Options — save is re-authenticated as UPDATE_CONFIG_PAGE', () => {
  it('runs the PUT through reauth.execute', async () => {
    const { ExportOptionsPage } = await import('../export-options');
    render(<MemoryRouter><ExportOptionsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/config/export-options', MATRIX));
    expect(executed).toEqual(['UPDATE_CONFIG_PAGE']);
  });

  it('with a password, sends it with the body', async () => {
    withPassword.current = true;
    const { ExportOptionsPage } = await import('../export-options');
    render(<MemoryRouter><ExportOptionsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith('/api/config/export-options', MATRIX, 'pw'));
    expect(put).not.toHaveBeenCalled();
  });
});

describe('Report Page Titles — save is re-authenticated as UPDATE_CONFIG_PAGE', () => {
  it('runs the PUT through reauth.execute once the form is dirty', async () => {
    const { ReportPageTitlesPage } = await import('../report-page-titles');
    render(<MemoryRouter><ReportPageTitlesPage /></MemoryRouter>);
    const [companyInput] = screen.getAllByRole('textbox');
    fireEvent.change(companyInput, { target: { value: 'New Co' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/config/report-page-titles', { companyName: 'New Co', appName: 'App' }));
    expect(executed).toEqual(['UPDATE_CONFIG_PAGE']);
  });

  it('with a password, sends it with the body', async () => {
    withPassword.current = true;
    const { ReportPageTitlesPage } = await import('../report-page-titles');
    render(<MemoryRouter><ReportPageTitlesPage /></MemoryRouter>);
    const [companyInput] = screen.getAllByRole('textbox');
    fireEvent.change(companyInput, { target: { value: 'New Co' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith('/api/config/report-page-titles', { companyName: 'New Co', appName: 'App' }, 'pw'));
  });
});
