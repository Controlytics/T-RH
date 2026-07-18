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
  it('FEATURE_PRIVILEGES (27 entries) matches snapshot exactly — order-sensitive', () => {
    expect(FEATURE_PRIVILEGES).toEqual(FEATURE_PRIVILEGES_SNAPSHOT);
  });

  it('FEATURE_TO_PERMISSION_MAP (27 keys) matches snapshot exactly — per-key array equality', () => {
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

  it('configurable node count is exactly 27', () => {
    // Post domain-strip (2026-07-18): only the 9 core sidebar groups remain
    // (dashboard, users, admin-requests, configuration, notifications, audit,
    // system-health, debug-traces, version-history); 27 of their nodes are
    // configurable feature privileges.
    const count = PERMISSION_TREE.flatMap(g => g.nodes).filter(n => n.configurable === true).length;
    expect(count).toBe(27);
  });

  it('FEATURE_PRIVILEGES has exactly 27 entries', () => {
    expect(FEATURE_PRIVILEGES).toHaveLength(27);
  });

  it('FEATURE_TO_PERMISSION_MAP has exactly 27 keys', () => {
    expect(Object.keys(FEATURE_TO_PERMISSION_MAP)).toHaveLength(27);
  });

  it('SIDEBAR_PRIVILEGE_MAP has exactly 9 sections', () => {
    expect(SIDEBAR_PRIVILEGE_MAP).toHaveLength(9);
  });
});
