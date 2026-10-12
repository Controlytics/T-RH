import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * 2026-10-12: the dynamic config page asks for the password UP FRONT for the
 * action the SERVER names in the manifest (`reauthAction`), never one it builds
 * itself. It used to derive `UPDATE_<MODULE_KEY>`, so a def whose PUT enforces
 * a shared action — sensor-offsets, report-downloads, report-approvers and
 * telemetry-retention all enforce UPDATE_CONFIG_PAGE — sent the PUT bare and
 * only opened the dialog after the 401. The REAL `useReauth` hook is used.
 */
vi.setConfig({ testTimeout: 20_000 });
const MY_ACTIONS = { actions: ['UPDATE_CONFIG_PAGE'] };
const MANIFEST = [{
  moduleKey: 'sensor-offsets', moduleName: 'Sensor Offsets', description: '', icon: '', category: 'system',
  requiresReauth: false, hasCustomPage: false, reauthAction: 'UPDATE_CONFIG_PAGE',
  settings: [{ key: 'enabled', type: 'boolean', label: 'Apply sensor offsets', default: true }],
}];
const SAVED = { enabled: true };
const mutate = vi.fn(async () => undefined);
vi.mock('swr', () => ({
  mutate,
  useSWRConfig: () => ({ mutate }),
  default: (key: string | null) => {
    if (key === '/api/config/action-reauth/my-actions') return { data: MY_ACTIONS, mutate };
    if (key === '/api/config/registry/manifest') return { data: MANIFEST, mutate };
    if (key === '/api/config/dynamic/sensor-offsets') return { data: SAVED, mutate };
    return { data: undefined, mutate };
  },
}));
const put = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])), get: vi.fn(async () => []) } }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'me', username: 'superadmin', role: 'SUPER_ADMIN', permissions: [] } }) }));

describe('Dynamic config page — the server names the re-auth action', () => {
  it('opens the password dialog before sending anything, for the manifest\'s action', async () => {
    const { DynamicConfigPage } = await import('../dynamic-config');
    render(
      <MemoryRouter initialEntries={['/config/sensor-offsets']}>
        <Routes><Route path="/config/:moduleKey" element={<DynamicConfigPage />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    const dialog = await screen.findByRole('dialog');
    expect(put).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByPlaceholderText('Enter your password'), { target: { value: 'Secret@123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /verify/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('/api/config/dynamic/sensor-offsets');
    expect(body._currentPassword).toBe('Secret@123');
  });
});
