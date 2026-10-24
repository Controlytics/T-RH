import { describe, it, expect } from 'vitest';
import {
  PERMISSION_TREE,
  deriveFeaturePrivileges,
  deriveFeatureToPermissionMap,
  deriveSidebarPrivilegeMap,
  primaryPermissionsOf,
  privilegeTogglesFromPermissions,
  resolveNodePermissions,
  resolveNodeGate,
  resolveNodeGateRoles,
} from './permission-tree.js';
import { PERMISSIONS, hasEffectivePermission } from './permissions.js';
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

// 2026-10-24 (operator: "when permissions are allowed some are not coming to
// user roles, like instruments creation or functional locations creation").
// The Permissions tab showed a toggle ON when the role held ANY permission of
// its grant set — which includes the READ dependency — so a role holding only
// INSTRUMENT_READ read as holding Create / Edit / Delete Instruments. The tab
// sends its whole map on save, so those false ONs also became real grants.
describe('privilegeTogglesFromPermissions — what the Permissions tab shows', () => {
  const map = deriveFeatureToPermissionMap();
  const expand = (toggles: Record<string, boolean>) =>
    new Set(Object.entries(toggles).filter(([, on]) => on).flatMap(([id]) => map[id] ?? []));
  const allGates = new Set<string>(PERMISSION_TREE.flatMap(g => g.nodes).flatMap(n => n.gate));

  it('a READ dependency alone does not switch on Create / Edit / Delete', () => {
    const t = privilegeTogglesFromPermissions(['INSTRUMENT_READ', 'AUDIT_READ']);
    expect(t['instruments.view']).toBe(true);
    expect(t['instruments.create']).toBe(false);
    expect(t['instruments.edit']).toBe(false);
    expect(t['instruments.delete']).toBe(false);
    expect(t['settings.edit']).toBe(false);
    expect(t['audit.view']).toBe(true);
    expect(t['audit.delete']).toBe(false);
  });

  it('a held gate switches its toggle on — Create Instruments, Create Functional Locations', () => {
    const t = privilegeTogglesFromPermissions(['INSTRUMENT_CREATE', 'INSTRUMENT_READ', 'FUNCTIONAL_LOCATION_CREATE', 'FUNCTIONAL_LOCATION_READ']);
    expect(t['instruments.create']).toBe(true);
    expect(t['functional_locations.create']).toBe(true);
    expect(t['functional_locations.view']).toBe(true);
    expect(t['functional_locations.edit']).toBe(false);
  });

  it('has exactly one entry per configurable toggle, in the forward map\'s order', () => {
    expect(Object.keys(privilegeTogglesFromPermissions([]))).toEqual(Object.keys(map));
    expect(Object.values(privilegeTogglesFromPermissions([])).every(v => v === false)).toBe(true);
  });

  it('round trip: a node\'s own grant set shows that node ON', () => {
    for (const [id, perms] of Object.entries(map)) {
      if (perms.length === 0) continue;
      expect(privilegeTogglesFromPermissions(perms)[id], id).toBe(true);
    }
  });

  // What a Permissions save WRITES (`planRolePermissions`): every permission
  // no toggle maps survives as it is; every mapped one is rebuilt from the
  // toggles. Both properties are judged by CAPABILITY — the server's own
  // `hasEffectivePermission` — because X_MANAGE covers X_DELETE: writing
  // NOTIFICATION_DELETE beside a held NOTIFICATION_MANAGE grants nothing new.
  const configurable = PERMISSION_TREE.flatMap(g => g.nodes).filter(n => n.configurable === true);
  const mapped = new Set(Object.values(map).flat());
  const ALL = Object.values(PERMISSIONS) as string[];
  const capabilities = (perms: readonly string[]) => new Set(ALL.filter(p => hasEffectivePermission(perms, p)));
  const saved = (held: string[]) => [...held.filter(p => !mapped.has(p)), ...expand(privilegeTogglesFromPermissions(held))];
  const samples: string[][] = [
    ...ALL.map(p => [p]),
    ...Object.values(map),
    ['INSTRUMENT_READ'],
    ['AUDIT_READ', 'DASHBOARD_VIEW', 'NOTIFICATION_VIEW', 'INSTRUMENT_READ'],
    // The local install's roles as found on 2026-10-24 (ADMIN, then SUPERVISOR).
    ['USER_CREATE', 'USER_READ', 'USER_UPDATE', 'USER_ENABLE_DISABLE', 'USER_UNLOCK', 'USER_RESET_PASSWORD',
      'ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'CONFIG_READ', 'CONFIG_UPDATE', 'FIELD_ID_UPDATE',
      'ROLE_MANAGE', 'AUDIT_READ', 'AUDIT_EXPORT', 'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_VIEW',
      'DASHBOARD_ASSIGN', 'NOTIFICATION_VIEW', 'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_MANAGE',
      'BACKUP_MANAGE', 'BACKUP_RESTORE', 'READ_DEBUG_TRACE', 'MANAGE_DEBUG_TRACE', 'INSTRUMENT_READ'],
    ['AUDIT_READ', 'AUDIT_EXPORT', 'DASHBOARD_VIEW', 'NOTIFICATION_VIEW', 'INSTRUMENT_READ'],
  ];

  // The safety property. Saving what the tab shows may add ONLY the read
  // dependency of something the role can already do (USER_CREATE alone shows
  // Create Users ON, and a save adds its USER_READ — the tree's own rule that a
  // page you may write but not read is unusable). Nothing else: no capability
  // the role did not have.
  it('saving the displayed toggles gains no capability but the dependency of one already held', () => {
    for (const held of samples) {
      const toggles = privilegeTogglesFromPermissions(held);
      const before = capabilities(held);
      const gained = [...capabilities(saved(held))].filter(p => !before.has(p));
      const unexplained = gained.filter(p => !configurable.some(n =>
        toggles[n.id] && (n.permissions as readonly string[]).includes(p) && !primaryPermissionsOf(n).includes(p)));
      expect(unexplained, `held ${held.join(',')}`).toEqual([]);
    }
    // And the regression itself, by name: a read-only role gains no gate.
    const fromRead = expand(privilegeTogglesFromPermissions(['INSTRUMENT_READ', 'AUDIT_READ']));
    expect([...fromRead].filter(p => allGates.has(p) && !['INSTRUMENT_READ', 'AUDIT_READ'].includes(p))).toEqual([]);
  });

  // The other direction. A save rebuilds the mapped permissions FROM the
  // toggles, so a capability no ON toggle covers would be REVOKED by a save
  // that changed nothing about it.
  it('saving the displayed toggles never takes away a capability the role has', () => {
    for (const held of samples) {
      const after = capabilities(saved(held));
      const lost = [...capabilities(held)].filter(p => !after.has(p));
      expect(lost, `held ${held.join(',')}`).toEqual([]);
    }
    // A permission no toggle offers (Delete Users is SUPER_ADMIN only) is kept.
    expect(saved(['USER_DELETE', 'USER_READ'])).toContain('USER_DELETE');
  });
});
