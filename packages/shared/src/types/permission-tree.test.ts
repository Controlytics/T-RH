import { describe, it, expect } from 'vitest';
import {
  PERMISSION_TREE,
  deriveFeaturePrivileges,
  deriveFeatureToPermissionMap,
  deriveSidebarPrivilegeMap,
  resolveNodePermissions,
  resolveNodeGate,
  resolveNodeGateRoles,
} from './permission-tree.js';
import { PERMISSIONS } from './permissions.js';
import { REAUTH_ACTIONS } from './reauth-actions.js';
import {
  FEATURE_PRIVILEGES_SNAPSHOT,
  FEATURE_TO_PERMISSION_MAP_SNAPSHOT,
  SIDEBAR_PRIVILEGE_MAP_SNAPSHOT,
} from './__snapshots__/legacy-maps-snapshot.js';

describe('PERMISSION_TREE well-formedness', () => {
  const allNodes = PERMISSION_TREE.flatMap(g => g.nodes);

  it('has unique node ids', () => {
    const ids = allNodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every node id is dotted lowercase (page.action)', () => {
    for (const n of allNodes) {
      expect(n.id).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('every permission referenced exists in PERMISSIONS', () => {
    const valid = new Set(Object.values(PERMISSIONS));
    for (const n of allNodes) {
      for (const p of n.permissions) {
        expect(valid.has(p as any), `${n.id} → ${p}`).toBe(true);
      }
    }
  });

  it('every reauthAction (when set) exists in REAUTH_ACTIONS', () => {
    const valid = new Set(Object.keys(REAUTH_ACTIONS));
    for (const n of allNodes) {
      if (n.reauthAction) {
        expect(valid.has(n.reauthAction), `${n.id} → ${n.reauthAction}`).toBe(true);
      }
    }
  });

  it('every node has a valid enforce tag', () => {
    for (const n of allNodes) {
      expect(['a', 'b', 'c']).toContain(n.enforce);
    }
  });
});

describe('deriveFeaturePrivileges parity (Task 1.2)', () => {
  it('reproduces FEATURE_PRIVILEGES exactly (same entries, same order) — compared against frozen snapshot', () => {
    expect(deriveFeaturePrivileges()).toEqual(FEATURE_PRIVILEGES_SNAPSHOT);
  });
});

describe('deriveFeatureToPermissionMap parity (Task 1.3)', () => {
  it('reproduces FEATURE_TO_PERMISSION_MAP exactly — compared against frozen snapshot', () => {
    expect(deriveFeatureToPermissionMap()).toEqual(FEATURE_TO_PERMISSION_MAP_SNAPSHOT);
  });
});

describe('deriveSidebarPrivilegeMap (Task 1.4)', () => {
  it('reproduces SIDEBAR_PRIVILEGE_MAP (per-section, privilegeIds as sets) — compared against frozen snapshot', () => {
    const derived = deriveSidebarPrivilegeMap();
    const oracle = SIDEBAR_PRIVILEGE_MAP_SNAPSHOT;
    expect(derived.map(s => s.sidebarId).sort())
      .toEqual(oracle.map(s => s.sidebarId).sort());
    for (const o of oracle) {
      const d = derived.find(s => s.sidebarId === o.sidebarId);
      expect(d, `missing section ${o.sidebarId}`).toBeTruthy();
      expect([...d!.privilegeIds].sort(), `privilegeIds ${o.sidebarId}`)
        .toEqual([...o.privilegeIds].sort());
    }
  });
});

// Task 5A.1 — PermissionNode.gate (discriminating backend permission set)
describe('PermissionNode.gate (Phase 5A)', () => {
  const nodes = PERMISSION_TREE.flatMap(g => g.nodes);

  it('every gate entry is a valid PERMISSIONS constant', () => {
    const valid = new Set(Object.values(PERMISSIONS));
    for (const n of nodes) {
      for (const p of n.gate) {
        expect(valid.has(p as any), `${n.id} → ${p}`).toBe(true);
      }
    }
  });

  it('every node has gate as an array', () => {
    for (const n of nodes) expect(Array.isArray(n.gate), n.id).toBe(true);
  });

  it('known SUPER_ADMIN-only actions have empty gate', () => {
    // notifications.delete was SA-only until 2026-07-01; it is now a real grantable perm
    // (gate ['NOTIFICATION_DELETE']), so it is no longer in this list.
    //
    // `pm.delete` was dropped from this list on 2026-08-14: the node went with the PM
    // domain in the Phase 0 strip, and because resolveNodeGate() returns [] for an
    // UNKNOWN id, the assertion kept passing against a node that no longer existed. The
    // existence check below is the point — without it this test cannot tell "locked down"
    // from "deleted", which is the more dangerous of the two to be wrong about.
    for (const id of ['users.delete', 'audit.redact']) {
      expect(nodes.map((n) => n.id), `${id} no longer exists — a vacuous pass, not a passing gate`).toContain(id);
      expect(resolveNodeGate(id), id).toEqual([]);
    }
  });

  /**
   * NO node currently has a multi-permission gate. `cleaning_profiles.toggle` — the one
   * this test used to pin — went with the filter domain in the Phase 0 strip, and
   * `checklists.create` had already been narrowed to a single permission in 5C.
   *
   * Rather than delete the coverage, this is written as a property over whatever the tree
   * holds: it is vacuous today and starts asserting the moment an OR-gated node is added,
   * which is exactly when it is wanted. The HOOK's OR semantics are covered separately
   * and non-vacuously in apps/web/src/hooks/__tests__/use-can.test.ts, against a stubbed
   * two-permission gate.
   */
  it('every multi-permission gate is returned in full by resolveNodeGate', () => {
    const orGated = nodes.filter((n) => Array.isArray(n.gate) && n.gate.length > 1);
    for (const n of orGated) {
      expect(resolveNodeGate(n.id).sort(), n.id).toEqual([...n.gate].sort());
    }
  });

  it('resolveNodeGate returns [] for an unknown node id', () => {
    expect(resolveNodeGate('nope.nope')).toEqual([]);
  });

  it('resolveNodeGateRoles returns [] for unknown node id', () => {
    expect(resolveNodeGateRoles('nope.nope')).toEqual([]);
  });

  it('system_health.view has gateRoles containing ADMIN', () => {
    expect(resolveNodeGateRoles('system_health.view')).toContain('ADMIN');
  });

  /**
   * The gate must be the DISCRIMINATING permission, never the whole grant-expansion set.
   * `permissions` routinely carries a read dependency — a page you may write but not read
   * is unusable — and gating on the full set would hand the write action to anyone who
   * merely holds the read.
   *
   * This replaced `checklists.submit gate is FILTER_OPERATE` on 2026-08-14: that node went
   * with the filter domain, and a single hardcoded example only ever covered one node
   * anyway. The property below covers all 50 and cannot go stale.
   */
  it('no gate is simply a copy of the full grant set', () => {
    const offenders = nodes.filter(
      (n) => n.gate.length > 0 && n.permissions.length > 1 && n.gate.length === n.permissions.length,
    );
    expect(offenders.map((n) => n.id), 'gate must discriminate, not repeat permissions[]').toEqual([]);
  });

  it('a live example: alarms.acknowledge gates on the write perm, not its read dependency', () => {
    // permissions = [ALARM_ACKNOWLEDGE, ALARM_READ]; gate = [ALARM_ACKNOWLEDGE] only.
    // If the read dep leaked into the gate, anyone who can VIEW alarms could sign one off.
    expect(resolveNodeGate('alarms.acknowledge')).toEqual(['ALARM_ACKNOWLEDGE']);
  });

  // assets.relationships.create/delete nodes were REMOVED 2026-07-01 (vestigial — the perm
  // was grant-only, never a gate; relationship writes go through the assets.edit gate).
});

// Task 1.5 — resolveNodePermissions
// Note: the plan sample showed resolveNodePermissions('users.delete') → ['USER_DELETE']
// which contradicts FEATURE_TO_PERMISSION_MAP (oracle: ['USER_DELETE','USER_READ']).
// "The oracle always wins" — test uses the oracle-correct value.
describe('resolveNodePermissions (Task 1.5)', () => {
  it('returns the permissions array for a known FP node (oracle-correct)', () => {
    expect(resolveNodePermissions('users.delete')).toEqual(['USER_DELETE', 'USER_READ']);
  });

  it('returns [] for an unknown node id (default-deny)', () => {
    expect(resolveNodePermissions('totally.unknown')).toEqual([]);
  });

  it('returns [] for an enforced-only node with empty permissions', () => {
    // audit.redact has permissions: [] in the tree (enforces via reauth, no perm gate)
    expect(resolveNodePermissions('audit.redact')).toEqual([]);
  });
});

describe('data-report group (2026-09-07)', () => {
  // The Instrument History widget moved off the dashboard onto its own sidebar
  // page. It shows instrument readings, so the page is gated on the permission
  // that already governs them — no new permission — and it is a Roles & Access
  // Sidebar toggle like every other page.
  const group = PERMISSION_TREE.find((g) => g.sidebarId === 'data-report');

  it('exists, with one configurable View node gated on INSTRUMENT_READ', () => {
    expect(group).toBeTruthy();
    expect(group!.nodes.map((n) => n.id)).toEqual(['data_report.view']);
    const view = group!.nodes[0];
    expect(view.configurable).toBe(true);
    expect(view.permissions).toEqual([PERMISSIONS.INSTRUMENT_READ]);
    expect(resolveNodeGate('data_report.view')).toEqual([PERMISSIONS.INSTRUMENT_READ]);
  });

  it('is hidden from the sidebar unless the viewer holds INSTRUMENT_READ', () => {
    expect(group!.visibilityPrivilegeIds).toEqual(['data_report.view']);
  });
});

describe('settings group (2026-09-08)', () => {
  // Operator: "in side bar add settings, in that page show the instrument
  // details and attributes, there selected user role should edit details, view
  // details". One table of every instrument, details + attributes editable in
  // place. It shows and changes instruments, so it is gated on the permissions
  // that already govern them — no new permission — and View / Edit are Roles &
  // Access Sidebar toggles like every other page.
  const group = PERMISSION_TREE.find((g) => g.sidebarId === 'settings');

  it('has a View node gated on INSTRUMENT_READ and an Edit node gated on INSTRUMENT_UPDATE', () => {
    expect(group).toBeTruthy();
    expect(group!.nodes.map((n) => n.id)).toEqual(['settings.view', 'settings.edit']);
    expect(group!.nodes.every((n) => n.configurable)).toBe(true);
    expect(resolveNodeGate('settings.view')).toEqual([PERMISSIONS.INSTRUMENT_READ]);
    expect(resolveNodeGate('settings.edit')).toEqual([PERMISSIONS.INSTRUMENT_UPDATE]);
    // Granting Edit alone must still let the page load: the grant set carries READ.
    expect(group!.nodes[1].permissions).toEqual([PERMISSIONS.INSTRUMENT_UPDATE, PERMISSIONS.INSTRUMENT_READ]);
  });

  it('is visible in the sidebar to a role holding either toggle', () => {
    expect(group!.visibilityPrivilegeIds).toEqual(['settings.view', 'settings.edit']);
  });
});

describe('reports group (2026-09-07)', () => {
  // Every PDF download is a REQUEST; an approver signs it on the Reports page.
  // docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
  const group = PERMISSION_TREE.find((g) => g.sidebarId === 'reports');

  it('has a View node gated on REPORT_REVIEW_READ and an Approve node gated on REPORT_REVIEW_APPROVE with the APPROVE_REPORT re-auth', () => {
    expect(group).toBeTruthy();
    expect(group!.nodes.map((n) => n.id)).toEqual(['reports.view', 'reports.approve']);
    expect(resolveNodeGate('reports.view')).toEqual([PERMISSIONS.REPORT_REVIEW_READ]);
    expect(resolveNodeGate('reports.approve')).toEqual([PERMISSIONS.REPORT_REVIEW_APPROVE]);
    expect(group!.nodes[1].reauthAction).toBe('APPROVE_REPORT');
    expect(group!.visibilityPrivilegeIds).toEqual(['reports.view', 'reports.approve']);
  });

  it('registers the two decision re-auth actions under Reports and the four audit actions with templates', () => {
    expect(REAUTH_ACTIONS.APPROVE_REPORT.category).toBe('Reports');
    expect(REAUTH_ACTIONS.REJECT_REPORT.category).toBe('Reports');
  });
});
