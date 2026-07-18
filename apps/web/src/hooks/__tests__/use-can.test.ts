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

  // ── OR-gate: user holds ONE of the required perms ─────────────────────────
  // cleaning_profiles.toggle has a real OR-gate ['FCP_UPDATE','CP_PAGE_EDIT'] (the toggle
  // theater-fix). (checklists.create was narrowed to single-perm [CHECKLIST_CREATE] in 5C.)
  it('grants an OR-gated action when user holds the first perm (FCP_UPDATE)', () => {
    setupUser('QA', ['FCP_UPDATE']);
    const { result } = renderHook(() => useCan());
    expect(result.current('cleaning_profiles.toggle')).toBe(true);
  });

  it('grants an OR-gated action when user holds the second perm (CP_PAGE_EDIT)', () => {
    setupUser('QA', ['CP_PAGE_EDIT']);
    const { result } = renderHook(() => useCan());
    expect(result.current('cleaning_profiles.toggle')).toBe(true);
  });

  it('denies an OR-gated action when user holds neither perm', () => {
    setupUser('OPERATOR', ['FILTER_OPERATE', 'CYCLE_READ']);
    const { result } = renderHook(() => useCan());
    expect(result.current('cleaning_profiles.toggle')).toBe(false);
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
    setupUser('ADMIN', ['USER_READ', 'ASSET_VIEW']);
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
});
