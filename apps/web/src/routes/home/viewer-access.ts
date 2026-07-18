import { isSidebarItemVisible } from '../../components/layout/sidebar-visibility';
import type { FlowStep } from './types';

/** One active role as returned by GET /api/roles/access-matrix. */
export interface RoleAccess {
  name: string;
  displayName: string;
  hierarchyLevel: number;
  /** Tailwind class (default roles) OR a raw #hex/rgb() (custom roles). */
  color: string;
  permissions: string[];
  /** Per-role sidebar override (role_configs.sidebarItems). [] = no override. */
  sidebarItems: string[];
}

/**
 * Can a role SEE a module's sidebar item? Mirrors the sidebar's own rule
 * (components/layout/sidebar.tsx): SUPER_ADMIN sees everything; otherwise the
 * item must be permission-visible AND, if the role pins an explicit sidebar
 * list, be in it. Module ids equal sidebar item ids by construction.
 */
export function canRoleSeeModule(moduleId: string, role: RoleAccess): boolean {
  if (role.name === 'SUPER_ADMIN') return true;
  if (!isSidebarItemVisible(moduleId, role.permissions)) return false;
  if (role.sidebarItems.length > 0) return role.sidebarItems.includes(moduleId);
  return true;
}

/**
 * The roles configured to perform a step's operation within a module: roles
 * that can SEE the module AND satisfy the step's gate. SUPER_ADMIN is always
 * included (it bypasses every gate — apps/api/src/plugins/rbac.ts). Returns
 * `null` for steps that aren't permission/role-gated (automatic/public/
 * configured) so the caller renders a neutral chip instead of role badges.
 */
export function rolesForStep(
  step: FlowStep,
  moduleId: string,
  roles: RoleAccess[],
  ignoreSidebar = false,
): RoleAccess[] | null {
  if (step.access === 'automatic' || step.access === 'public' || step.access === 'configured') return null;
  const all = roles ?? [];
  // Audit view (`ignoreSidebar`): every role permitted by the backend gate,
  // regardless of whether its sidebar hides the module — the true "who can
  // perform this operation". Default view keeps the sidebar+permission gate.
  const visible = ignoreSidebar ? all : all.filter((r) => canRoleSeeModule(moduleId, r));
  if (step.access === 'authenticated') return visible;
  if (step.gate.length > 0) {
    return visible.filter((r) => r.name === 'SUPER_ADMIN' || step.gate.some((g) => r.permissions.includes(g)));
  }
  if (step.gateRoles && step.gateRoles.length > 0) {
    return visible.filter((r) => r.name === 'SUPER_ADMIN' || step.gateRoles!.includes(r.name));
  }
  return visible;
}

/** Roles configured for a branch's gate within a module (SUPER_ADMIN always). */
export function rolesForGate(
  gate: string[],
  moduleId: string,
  roles: RoleAccess[],
  ignoreSidebar = false,
): RoleAccess[] {
  const all = roles ?? [];
  const visible = ignoreSidebar ? all : all.filter((r) => canRoleSeeModule(moduleId, r));
  return visible.filter((r) => r.name === 'SUPER_ADMIN' || gate.some((g) => r.permissions.includes(g)));
}

/** The current viewer's own access context, for filtering which modules show. */
export interface ViewerCtx {
  role: string;
  permissions: string[];
  /** From /api/config/my-config (role+user merged). [] = no override. */
  sidebarItems: string[];
  qnnVisible: boolean;
}

/**
 * Which module flowcharts the current viewer sees — the same rule the viewer's
 * own sidebar uses, so the guide mirrors what they can actually reach.
 */
export function viewerCanSeeModule(moduleId: string, v: ViewerCtx): boolean {
  if (v.role === 'SUPER_ADMIN') return true;
  // Quality Notifications visibility is config-gated per role, not permission-mapped.
  if (moduleId === 'quality-notifications' && !v.qnnVisible) return false;
  if (!isSidebarItemVisible(moduleId, v.permissions)) return false;
  if (v.sidebarItems.length > 0) return v.sidebarItems.includes(moduleId);
  return true;
}
