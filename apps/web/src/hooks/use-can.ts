/**
 * useCan() — Phase 5A authorization hook.
 *
 * Returns a stable callback `(nodeId: string) => boolean` that answers
 * "can the current user perform this tree-node action?" using the
 * DISCRIMINATING backend gate (node.gate), not the grant-expansion set
 * (node.permissions).
 *
 * Decision logic:
 *   1. SUPER_ADMIN → always true.
 *   2. gateRoles present → true if user.role is in the list.
 *   3. gate is empty → false (SA-only or unknown node — deny by default).
 *   4. gate non-empty → true if user holds ANY of the gate permissions.
 *
 * This corrects the Phase-1 bug where UI code could check the grant-expansion
 * permissions[] set (which includes read dependencies) and incorrectly permit
 * destructive actions to non-SA users.
 */

import { useCallback } from 'react';
import { resolveNodeGate, resolveNodeGateRoles } from '@digilog/shared';
import { useAuth } from './use-auth';

export function useCan(): (nodeId: string) => boolean {
  const { user } = useAuth();
  const role = user?.role ?? null;
  const perms: string[] = user?.permissions ?? [];

  return useCallback(
    (nodeId: string): boolean => {
      // 1. SUPER_ADMIN bypasses all gates.
      if (role === 'SUPER_ADMIN') return true;

      const gate = resolveNodeGate(nodeId);
      const gateRoles = resolveNodeGateRoles(nodeId);

      // 2. Role-level bypass (e.g. ADMIN for system_health.view).
      if (role && gateRoles.includes(role)) return true;

      // 3. Empty gate → SA-only or unknown node → deny.
      if (gate.length === 0) return false;

      // 4. OR over gate vs user permissions.
      return gate.some((p) => perms.includes(p));
    },
    [role, perms],
  );
}
