import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PERMISSION_TREE, privilegeTogglesFromPermissions } from '@digilog/shared';

/**
 * Performance audit 2026-11-17, G4-01 — found while gating the Permissions tab.
 *
 * The toggles used to be seeded in SWR's `onSuccess`, which fires only when a
 * FETCH completes. Switching to a role whose config SWR already had cached
 * returned that role's data at once — but the toggles still held the PREVIOUS
 * role's values until the revalidation landed, under the new role's name. A tick
 * + Save in that window wrote role A's permissions to role B.
 *
 * Modelled exactly: ADMIN's fetch completes (onSuccess fires); OPERATOR's data
 * is cached and its revalidation has NOT landed (onSuccess never fires). The
 * toggles shown for OPERATOR must be OPERATOR's.
 */
const mutate = vi.fn(async () => undefined);
const ADMIN = { permissions: privilegeTogglesFromPermissions(['USER_UPDATE', 'USER_READ']), sidebarItems: [], permissionsHeld: ['USER_UPDATE', 'USER_READ'] };
const OPERATOR = { permissions: privilegeTogglesFromPermissions([]), sidebarItems: [], permissionsHeld: [] };
let adminNotified = false;
vi.mock('swr', () => ({
  default: (key: string, opts?: { onSuccess?: (d: unknown) => void }) => {
    if (key === '/api/config/roles/ADMIN') {
      if (!adminNotified) { adminNotified = true; queueMicrotask(() => opts?.onSuccess?.(ADMIN)); }
      return { data: ADMIN, isLoading: false, mutate };
    }
    if (key === '/api/config/roles/OPERATOR') return { data: OPERATOR, isLoading: false, mutate };
    return { data: undefined, mutate };
  },
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: vi.fn(), isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: vi.fn(), putWithReauth: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const { PermissionsTab } = await import('../permissions-tab');

const ROLES = [
  { name: 'ADMIN', displayName: 'Administrator', hierarchyLevel: 80, isActive: true, isSystem: true, permissions: [], description: '' },
  { name: 'OPERATOR', displayName: 'Operator', hierarchyLevel: 50, isActive: true, isSystem: false, permissions: [], description: '' },
];
const LABEL = (id: string) => PERMISSION_TREE.flatMap((g) => g.nodes).find((n) => n.id === id)!.label;
const box = (id: string) =>
  (screen.getByText(LABEL(id), { selector: 'span' }).closest('label') as HTMLLabelElement).querySelector('input[type="checkbox"]') as HTMLInputElement;

describe('PermissionsTab — switching role shows the NEW role\'s toggles', () => {
  it('a cached role whose revalidation has not landed shows its own toggles, never the previous role\'s', async () => {
    render(<PermissionsTab selectableRoles={ROLES as never} onStateChange={() => undefined} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(box('users.edit').checked).toBe(true)); // ADMIN holds Edit Users

    fireEvent.click(screen.getByText('Operator'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(box('users.edit').checked).toBe(false); // OPERATOR does not
  });
});
