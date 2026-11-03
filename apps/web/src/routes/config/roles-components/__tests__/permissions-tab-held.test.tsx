import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { createRef } from 'react';
import { PERMISSION_TREE, privilegeTogglesFromPermissions } from '@digilog/shared';

/**
 * 2026-11-03, operator: "for some permissions, after un-selecting them and
 * saving, those are not updating".
 *
 * The SERVER is right: a Permissions save rebuilds the role's permissions from
 * the toggles and re-adds the primary permission of every enabled sidebar
 * item, then the tab re-reads the toggles from what the role holds. So a toggle
 * whose permission another ON toggle grants (View Users under Edit Users), an
 * implication covers (Edit Settings under Edit Instruments) or a sidebar item
 * grants (View Users under the Users menu) came straight back ON, with no word.
 * The tab now shows that the moment the toggle is un-selected: checked,
 * disabled, and a caption naming what holds it. The PUT is unchanged.
 */
const mutate = vi.fn(async () => undefined);
type RoleConfig = { permissions: Record<string, boolean>; sidebarItems: string[] };
// What GET /api/config/roles/:role answers for a role holding these
// permissions: the toggles the server DERIVES. Module constants on purpose —
// a fresh object per SWR call re-runs every effect keyed on it, forever.
const EDIT_USERS: RoleConfig = { permissions: privilegeTogglesFromPermissions(['USER_UPDATE', 'USER_READ']), sidebarItems: [] };
const USERS_MENU: RoleConfig = { permissions: privilegeTogglesFromPermissions(['USER_READ']), sidebarItems: ['users'] };
const EDIT_INSTRUMENTS: RoleConfig = { permissions: privilegeTogglesFromPermissions(['INSTRUMENT_UPDATE', 'INSTRUMENT_READ']), sidebarItems: [] };
const NOTHING: RoleConfig = { permissions: privilegeTogglesFromPermissions([]), sidebarItems: [] };
const fixture = { current: EDIT_USERS };
const notified = new Set<string>();
vi.mock('swr', () => ({
  default: (key: string, opts?: { onSuccess?: (d: unknown) => void }) => {
    if (typeof key === 'string' && key.startsWith('/api/config/roles/')) {
      // SWR fires onSuccess AFTER the fetch, never during render. Once per key, deferred.
      if (!notified.has(key)) { notified.add(key); queueMicrotask(() => opts?.onSuccess?.(fixture.current)); }
      return { data: fixture.current, isLoading: false, mutate };
    }
    return { data: undefined, mutate };
  },
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void }) => {
      await cb(undefined);
      opts?.onSuccess?.();
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));
const put = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])), putWithReauth: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const { PermissionsTab } = await import('../permissions-tab');
type Handle = { save: () => Promise<void> };

const ROLES = [{ name: 'OPERATOR', displayName: 'Operator', hierarchyLevel: 50, isActive: true, isSystem: false, permissions: [], description: '' }];
const LABEL = (id: string) => PERMISSION_TREE.flatMap(g => g.nodes).find(n => n.id === id)!.label;

/** The row of a toggle, found by the label the operator reads. */
const row = (id: string) => screen.getByText(LABEL(id), { selector: 'span' }).closest('label') as HTMLLabelElement;
const box = (id: string) => row(id).querySelector('input[type="checkbox"]') as HTMLInputElement;
/** "N of M enabled" under a group's heading. */
const counter = (group: string) => screen.getByText(group, { selector: 'h3' }).nextElementSibling?.textContent;

beforeEach(() => { notified.clear(); put.mockClear(); mutate.mockClear(); fixture.current = EDIT_USERS; });

/** Render on OPERATOR and let the deferred load land; `settled` is a toggle the fixture has ON. */
const renderTab = async (config: RoleConfig, settled?: string) => {
  fixture.current = config;
  const ref = createRef<Handle>();
  render(<PermissionsTab ref={ref} selectableRoles={ROLES as never} onStateChange={() => undefined} />);
  fireEvent.click(screen.getByText('Operator'));
  await waitFor(() => expect(notified.has('/api/config/roles/OPERATOR')).toBe(true));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  if (settled) await waitFor(() => expect(box(settled).checked).toBe(true));
  return ref;
};

describe('PermissionsTab — a toggle another toggle or a sidebar item holds', () => {
  it('un-selecting View Users while Edit Users is on shows it held — checked, disabled, named — and the save still sends it OFF', async () => {
    const ref = await renderTab(EDIT_USERS, 'users.edit');
    expect(box('users.view').checked).toBe(true);
    expect(box('users.view').disabled).toBe(false);

    fireEvent.click(box('users.view'));

    const view = box('users.view');
    expect(view.checked).toBe(true);
    expect(view.disabled).toBe(true);
    expect(view.getAttribute('aria-disabled')).toBe('true');
    expect(view.getAttribute('data-held')).toBe('true');
    expect(within(row('users.view')).getByText(/^Held by/).textContent).toBe(`Held by ${LABEL('users.edit')}`);
    // The caption is the checkbox's description, not loose text.
    expect(document.getElementById(view.getAttribute('aria-describedby')!)?.textContent).toBe(`Held by ${LABEL('users.edit')}`);
    // The group counts what the role will hold.
    expect(counter('Users')).toBe('2 of 6 enabled');

    // A held toggle cannot be clicked back and forth.
    fireEvent.click(box('users.view'));
    expect(box('users.view').checked).toBe(true);
    expect(box('users.view').getAttribute('data-held')).toBe('true');

    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'operators no longer read users' } });
    await act(async () => { await ref.current!.save(); });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [, body] = put.mock.calls[0] as unknown as [string, { permissions: Record<string, boolean> }];
    // The PUT is the user's OWN toggles — the server decides.
    expect(body.permissions['users.view']).toBe(false);
    expect(body.permissions['users.edit']).toBe(true);
  });

  it('un-selecting Edit Users as well frees View Users: enabled, unchecked, no caption', async () => {
    await renderTab(EDIT_USERS, 'users.edit');
    fireEvent.click(box('users.view'));
    expect(box('users.view').disabled).toBe(true);

    fireEvent.click(box('users.edit'));

    const view = box('users.view');
    expect(view.checked).toBe(false);
    expect(view.disabled).toBe(false);
    expect(view.getAttribute('data-held')).toBeNull();
    expect(view.getAttribute('aria-disabled')).toBeNull();
    expect(within(row('users.view')).queryByText(/^Held by/)).toBeNull();
    expect(counter('Users')).toBe('0 of 6 enabled');
  });

  it('an enabled sidebar item holds its View toggle — named as the sidebar item; Disable All has nothing of the role\'s own to turn off', async () => {
    await renderTab(USERS_MENU, 'users.view');
    fireEvent.click(box('users.view'));

    const view = box('users.view');
    expect(view.checked).toBe(true);
    expect(view.disabled).toBe(true);
    expect(view.getAttribute('data-held')).toBe('true');
    expect(within(row('users.view')).getByText(/^Held by/).textContent).toBe('Held by the Users sidebar item');
    expect(counter('Users')).toBe('1 of 6 enabled');
    const group = screen.getByTestId('perm-group-users');
    expect(within(group).getByRole('button', { name: /disable all/i })).toBeDisabled();
    expect(within(group).getByRole('button', { name: /enable all/i })).not.toBeDisabled();
  });

  it('Edit Settings is held by Edit Instruments — INSTRUMENT_UPDATE implies INSTRUMENT_ATTRIBUTE_UPDATE', async () => {
    await renderTab(EDIT_INSTRUMENTS, 'instruments.edit');
    expect(box('settings.edit').checked).toBe(true);

    fireEvent.click(box('settings.edit'));

    const edit = box('settings.edit');
    expect(edit.checked).toBe(true);
    expect(edit.disabled).toBe(true);
    expect(within(row('settings.edit')).getByText(/^Held by/).textContent).toBe(`Held by ${LABEL('instruments.edit')}`);
  });

  it('a toggle nothing else holds turns on and off as before', async () => {
    await renderTab(NOTHING);
    expect(box('notifications.view').checked).toBe(false);

    fireEvent.click(box('notifications.view'));
    expect(box('notifications.view').checked).toBe(true);
    expect(box('notifications.view').disabled).toBe(false);
    expect(box('notifications.view').getAttribute('data-held')).toBeNull();

    fireEvent.click(box('notifications.view'));
    expect(box('notifications.view').checked).toBe(false);
    expect(box('notifications.view').disabled).toBe(false);
    expect(within(row('notifications.view')).queryByText(/^Held by/)).toBeNull();
  });
});
