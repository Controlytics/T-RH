import { describe, it, expect } from 'vitest';
import {
  canRoleSeeModule,
  rolesForStep,
  rolesForGate,
  viewerCanSeeModule,
  type RoleAccess,
  type ViewerCtx,
} from '../viewer-access';
import type { FlowStep } from '../types';

const SA: RoleAccess = { name: 'SUPER_ADMIN', displayName: 'Super Admin', hierarchyLevel: 6, color: 'bg-red-500', permissions: [], sidebarItems: [] };
const OPERATOR: RoleAccess = { name: 'OPERATOR', displayName: 'Operator', hierarchyLevel: 2, color: 'bg-emerald-500', permissions: ['DASHBOARD_VIEW', 'FILTER_OPERATE'], sidebarItems: [] };
const CUSTOM: RoleAccess = { name: 'APPROVER', displayName: 'Approver', hierarchyLevel: 3, color: '#6366f1', permissions: ['DASHBOARD_VIEW', 'PM_APPROVE'], sidebarItems: [] };

describe('canRoleSeeModule', () => {
  it('SUPER_ADMIN sees every module (even with no permissions)', () => {
    expect(canRoleSeeModule('users', SA)).toBe(true);
    expect(canRoleSeeModule('audit', SA)).toBe(true);
  });

  it('a role with no permissions cannot see a module (isSidebarItemVisible → false)', () => {
    const empty: RoleAccess = { ...OPERATOR, permissions: [], sidebarItems: [] };
    expect(canRoleSeeModule('dashboard', empty)).toBe(false);
  });

  it('an explicit sidebar override hides a module not in it', () => {
    // 'system-health' has empty visibility ids → permission-visible for any role
    // with a perm, so this isolates the override rule (not tree coupling).
    const pinned: RoleAccess = { ...OPERATOR, sidebarItems: ['system-health'] };
    expect(canRoleSeeModule('dashboard', pinned)).toBe(false);     // permission-visible but pinned out
    expect(canRoleSeeModule('system-health', pinned)).toBe(true);  // permission-visible AND in the pin
  });
});

describe('rolesForStep', () => {
  const roles = [SA, OPERATOR, CUSTOM];

  it('gate-based step returns SUPER_ADMIN (always) + every role holding the gate', () => {
    const step: FlowStep = { label: 'Advance', gate: ['FILTER_OPERATE'], kind: 'action' };
    const out = rolesForStep(step, 'dashboard', roles)!.map((r) => r.name);
    expect(out).toEqual(['SUPER_ADMIN', 'OPERATOR']); // CUSTOM lacks FILTER_OPERATE
  });

  it('picks up a CUSTOM role that holds the operation permission (e.g. PM_APPROVE)', () => {
    const step: FlowStep = { label: 'Approve', gate: ['PM_APPROVE'], kind: 'decision' };
    const out = rolesForStep(step, 'dashboard', roles)!.map((r) => r.name);
    expect(out).toEqual(['SUPER_ADMIN', 'APPROVER']);
  });

  it('gate no default/custom role holds → only SUPER_ADMIN (bypass)', () => {
    const step: FlowStep = { label: 'Bypass', gate: ['FILTER_BYPASS'], kind: 'decision' };
    const out = rolesForStep(step, 'dashboard', roles)!.map((r) => r.name);
    expect(out).toEqual(['SUPER_ADMIN']);
  });

  it('gateRoles step returns SA + listed roles that can see the module', () => {
    const step: FlowStep = { label: 'Delete', gate: [], gateRoles: ['SUPER_ADMIN'], kind: 'decision' };
    const out = rolesForStep(step, 'dashboard', roles)!.map((r) => r.name);
    expect(out).toEqual(['SUPER_ADMIN']);
  });

  it('tolerates an undefined roles list without throwing (transient/loading state)', () => {
    const step: FlowStep = { label: 'Advance', gate: ['FILTER_OPERATE'], kind: 'action' };
    expect(() => rolesForStep(step, 'dashboard', undefined as unknown as RoleAccess[])).not.toThrow();
    expect(rolesForStep(step, 'dashboard', undefined as unknown as RoleAccess[])).toEqual([]);
    expect(rolesForGate(['FILTER_OPERATE'], 'dashboard', undefined as unknown as RoleAccess[])).toEqual([]);
  });

  it('automatic/public/configured steps return null (chip, not roles)', () => {
    expect(rolesForStep({ label: 'x', gate: [], access: 'automatic', kind: 'system' }, 'dashboard', roles)).toBeNull();
    expect(rolesForStep({ label: 'x', gate: [], access: 'public', kind: 'action' }, 'dashboard', roles)).toBeNull();
    expect(rolesForStep({ label: 'x', gate: [], access: 'configured', kind: 'system' }, 'dashboard', roles)).toBeNull();
  });

  it('excludes a role that holds the gate but cannot SEE the module', () => {
    const pinnedOperator: RoleAccess = { ...OPERATOR, sidebarItems: ['filter-operations'] };
    const step: FlowStep = { label: 'Advance', gate: ['FILTER_OPERATE'], kind: 'action' };
    // On 'dashboard' the pinned operator can't see it → excluded (SA remains).
    const out = rolesForStep(step, 'dashboard', [SA, pinnedOperator])!.map((r) => r.name);
    expect(out).toEqual(['SUPER_ADMIN']);
  });

  it('audit mode (ignoreSidebar) includes a gate-holder even if its sidebar hides the module', () => {
    const pinnedOperator: RoleAccess = { ...OPERATOR, sidebarItems: ['filter-operations'] };
    const step: FlowStep = { label: 'Advance', gate: ['FILTER_OPERATE'], kind: 'action' };
    const out = rolesForStep(step, 'dashboard', [SA, pinnedOperator], true)!.map((r) => r.name);
    expect(out).toEqual(['SUPER_ADMIN', 'OPERATOR']);
  });
});

describe('rolesForGate (branches)', () => {
  it('returns SA + roles holding the branch gate', () => {
    const out = rolesForGate(['PM_APPROVE'], 'dashboard', [SA, OPERATOR, CUSTOM]).map((r) => r.name);
    expect(out).toEqual(['SUPER_ADMIN', 'APPROVER']);
  });
});

describe('viewerCanSeeModule', () => {
  const base: ViewerCtx = { role: 'OPERATOR', permissions: ['DASHBOARD_VIEW'], sidebarItems: [], qnnVisible: false };

  it('SUPER_ADMIN sees all modules', () => {
    expect(viewerCanSeeModule('users', { ...base, role: 'SUPER_ADMIN' })).toBe(true);
  });

  it('quality-notifications hidden unless qnnVisible', () => {
    expect(viewerCanSeeModule('quality-notifications', base)).toBe(false);
    expect(viewerCanSeeModule('quality-notifications', { ...base, qnnVisible: true })).toBe(true);
  });

  it('honours the viewer sidebar override', () => {
    expect(viewerCanSeeModule('dashboard', { ...base, sidebarItems: ['system-health'] })).toBe(false);
    expect(viewerCanSeeModule('system-health', { ...base, sidebarItems: ['system-health'] })).toBe(true);
  });
});
