/**
 * Phase 5E — Snapshot invariant tests.
 *
 * These tests assert that the derived outputs (from PERMISSION_TREE) are
 * EXACTLY equal to the frozen literal snapshots taken from the original
 * hand-maintained files. If any test fails, the derived values diverge from
 * the originals and the refactor is broken — do NOT proceed, report the diff.
 */

import { describe, it, expect } from 'vitest';
import { FEATURE_PRIVILEGES, FEATURE_TO_PERMISSION_MAP } from './feature-privileges.js';
import { SIDEBAR_PRIVILEGE_MAP } from './sidebar-privilege-map.js';
import { PERMISSION_TREE } from './permission-tree.js';
import {
  FEATURE_PRIVILEGES_SNAPSHOT,
  FEATURE_TO_PERMISSION_MAP_SNAPSHOT,
  SIDEBAR_PRIVILEGE_MAP_SNAPSHOT,
} from './__snapshots__/legacy-maps-snapshot.js';

describe('Phase 5E: derived maps === original snapshots', () => {
  it('FEATURE_PRIVILEGES (37 entries) matches snapshot exactly — order-sensitive', () => {
    expect(FEATURE_PRIVILEGES).toEqual(FEATURE_PRIVILEGES_SNAPSHOT);
  });

  it('FEATURE_TO_PERMISSION_MAP (37 keys) matches snapshot exactly — per-key array equality', () => {
    expect(FEATURE_TO_PERMISSION_MAP).toEqual(FEATURE_TO_PERMISSION_MAP_SNAPSHOT);
  });

  it('SIDEBAR_PRIVILEGE_MAP (9 sections): sidebarIds match snapshot in order', () => {
    expect(SIDEBAR_PRIVILEGE_MAP.map(s => s.sidebarId))
      .toEqual(SIDEBAR_PRIVILEGE_MAP_SNAPSHOT.map(s => s.sidebarId));
  });

  it('SIDEBAR_PRIVILEGE_MAP: each section privilegeIds matches snapshot (order-sensitive)', () => {
    for (const oracle of SIDEBAR_PRIVILEGE_MAP_SNAPSHOT) {
      const derived = SIDEBAR_PRIVILEGE_MAP.find(s => s.sidebarId === oracle.sidebarId);
      expect(derived, `section ${oracle.sidebarId} missing from derived`).toBeTruthy();
      expect(derived!.privilegeIds, `privilegeIds for ${oracle.sidebarId}`)
        .toEqual(oracle.privilegeIds);
    }
  });

  it('configurable node count is exactly 37', () => {
    // Post domain-strip: the 8 core sidebar groups (dashboard, users,
    // admin-requests, configuration, notifications, audit, system-health,
    // debug-traces) carried 26 configurable nodes. 2026-08-01 added the 9th
    // group, data-injection (hierarchy/gateways/instruments/comm_profiles),
    // contributing 16 more configurable nodes — 26 + 16 = 42.
    // 2026-08-01 (finding I4, final branch review): 8 of those 16 data-
    // injection nodes (gateways.create/edit/delete, instruments.edit/delete,
    // comm_profiles.create/edit/delete) have no UI yet — gateways.tsx,
    // profiles.tsx and instruments.tsx are read-only tables — so they were
    // marked `configurable: false`. 42 - 8 = 34. 2026-08-03 (P3 Task 12) added
    // 3 configurable alarm nodes (alarms.view/acknowledge/thresholds), which
    // DO ship with UI in Task 13 — 34 + 3 = 37.
    const count = PERMISSION_TREE.flatMap(g => g.nodes).filter(n => n.configurable === true).length;
    expect(count).toBe(37);
  });

  it('FEATURE_PRIVILEGES has exactly 37 entries', () => {
    expect(FEATURE_PRIVILEGES).toHaveLength(37);
  });

  it('FEATURE_TO_PERMISSION_MAP has exactly 37 keys', () => {
    expect(Object.keys(FEATURE_TO_PERMISSION_MAP)).toHaveLength(37);
  });

  it('SIDEBAR_PRIVILEGE_MAP has exactly 9 sections', () => {
    expect(SIDEBAR_PRIVILEGE_MAP).toHaveLength(9);
  });
});
