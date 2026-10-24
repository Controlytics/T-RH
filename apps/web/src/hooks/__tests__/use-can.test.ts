/**
 * Tests for useCan() — the Phase 5A authorization hook.
 *
 * useCan() returns a function (nodeId: string) => boolean that tells the
 * caller whether the current user is allowed to perform that tree-node
 * action, using the DISCRIMINATING backend gate (not the grant-expansion
 * permissions[] set).
 *
 * Critical regression this test pins:
 *   A user with USER_READ can see the Users page (permissions=[USER_READ]),
 *   but must NOT be allowed to delete users — users.delete has gate:[],
 *   meaning it is SUPER_ADMIN-only regardless of what permissions[] says.
 *   The Phase-1 bug (before 5A) could have used permissions[] to grant the
 *   delete button to any USER_READ holder.
 *
 * gateRoles is tested via system_health.view (gate:[], gateRoles:['ADMIN']).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCan } from '../use-can';

// -- Mock useAuth so we control the user without React Router / SWR --
vi.mock('../use-auth', () => ({
  useAuth: vi.fn(),
}));

/**
 * The real PERMISSION_TREE is used for every test below EXCEPT the OR-gate pair, which
 * needs a node whose gate holds two permissions. No such node survives the Phase 0
 * domain strip (`cleaning_profiles.toggle`, the old subject, went with it), so those two
 * tests stub the resolver for one synthetic node id instead of asserting against
 * whichever real node happens to have an OR gate today. That coupling is what made them
 * fail: the hook's OR semantics never changed, its example did.
 */
vi.mock('@digilog/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@digilog/shared')>();
  return {
    ...actual,
    resolveNodeGate: (id: string) =>
      id === '__test__.or_gated' ? ['FIRST_PERM', 'SECOND_PERM'] : actual.resolveNodeGate(id),
    resolveNodeGateRoles: (id: string) =>
      id === '__test__.or_gated' ? [] : actual.resolveNodeGateRoles(id),
  };
});

import { useAuth } from '../use-auth';

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

function setupUser(role: string, permissions: string[]) {
  mockUseAuth.mockReturnValue({ user: { role, permissions } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useCan()', () => {
  // ── Phase-1 regression ──────────────────────────────────────────────────
  it('DENIES users.delete to a user who only has USER_READ (Phase-1 regression fix)', () => {
    setupUser('OPERATOR', ['USER_READ']);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.delete')).toBe(false);
  });

  // ── SUPER_ADMIN bypasses ─────────────────────────────────────────────────
  it('SUPER_ADMIN can perform SA-only action (users.delete, gate:[])', () => {
    setupUser('SUPER_ADMIN', []);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.delete')).toBe(true);
  });

  it('SUPER_ADMIN can perform any normal action', () => {
    setupUser('SUPER_ADMIN', []);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.view')).toBe(true);
    expect(result.current('pm.delete')).toBe(true);
  });

  // ── OR-gate: holding ANY ONE of the gate's permissions is enough ──────────
  // Against a stubbed two-permission gate (see the vi.mock above) rather than a real
  // node: this asserts the HOOK's semantics, which is what it was always meant to do.
  it('grants an OR-gated action when the user holds the first perm', () => {
    setupUser('QA', ['FIRST_PERM']);
    const { result } = renderHook(() => useCan());
    expect(result.current('__test__.or_gated')).toBe(true);
  });

  it('grants an OR-gated action when the user holds the second perm', () => {
    setupUser('QA', ['SECOND_PERM']);
    const { result } = renderHook(() => useCan());
    expect(result.current('__test__.or_gated')).toBe(true);
  });

  it('denies an OR-gated action when the user holds neither perm', () => {
    setupUser('OPERATOR', ['SOMETHING_ELSE']);
    const { result } = renderHook(() => useCan());
    expect(result.current('__test__.or_gated')).toBe(false);
  });

  // ── SA-only: holding the GRANT-SET perm does NOT grant the action ──────────
  it('denies users.delete even if user holds USER_DELETE from the grant-set', () => {
    // USER_DELETE is in users.delete.permissions[] (grant-expansion),
    // but gate is [] so only SUPER_ADMIN can pass.
    setupUser('ADMIN', ['USER_DELETE', 'USER_READ']);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.delete')).toBe(false);
  });

  // ── gateRoles ───────────────────────────────────────────────────────────
  it('grants system_health.view to ADMIN role (gateRoles bypass, gate:[])', () => {
    setupUser('ADMIN', []);
    const { result } = renderHook(() => useCan());
    expect(result.current('system_health.view')).toBe(true);
  });

  it('denies system_health.view to OPERATOR role (not in gateRoles)', () => {
    setupUser('OPERATOR', []);
    const { result } = renderHook(() => useCan());
    expect(result.current('system_health.view')).toBe(false);
  });

  // ── Unknown nodes ─────────────────────────────────────────────────────────
  it('denies an unknown node id (resolveNodeGate returns [])', () => {
    setupUser('ADMIN', ['USER_READ', 'INSTRUMENT_READ']);
    const { result } = renderHook(() => useCan());
    expect(result.current('nope.nope')).toBe(false);
  });

  // ── Normal node: user lacks the required perm ────────────────────────────
  it('denies users.view when user has no permissions', () => {
    setupUser('OPERATOR', []);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.view')).toBe(false);
  });

  it('grants users.view when user has USER_READ', () => {
    setupUser('OPERATOR', ['USER_READ']);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.view')).toBe(true);
  });

  // ── null / loading user ──────────────────────────────────────────────────
  it('denies everything when user is null (loading / not logged in)', () => {
    mockUseAuth.mockReturnValue({ user: null });
    const { result } = renderHook(() => useCan());
    expect(result.current('users.view')).toBe(false);
    expect(result.current('users.delete')).toBe(false);
  });

  // 2026-10-24: a button shows exactly when the route would allow the click —
  // the SERVER's rule (`hasEffectivePermission`), where X_MANAGE covers
  // X_DELETE. Until then a role holding NOTIFICATION_MANAGE could delete a
  // notification through the API and was never shown the button.
  it("applies the server's rule: X_MANAGE covers X_DELETE, but not RESTORE", () => {
    setupUser('OPERATOR', ['NOTIFICATION_MANAGE', 'BACKUP_MANAGE']);
    const { result } = renderHook(() => useCan());
    expect(result.current('notifications.delete')).toBe(true);
    expect(result.current('backup.export')).toBe(true);
    expect(result.current('backup.restore')).toBe(false);
  });
});
