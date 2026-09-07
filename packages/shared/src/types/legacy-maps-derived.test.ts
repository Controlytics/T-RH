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
  it('FEATURE_PRIVILEGES (38 entries) matches snapshot exactly — order-sensitive', () => {
    expect(FEATURE_PRIVILEGES).toEqual(FEATURE_PRIVILEGES_SNAPSHOT);
  });

  it('FEATURE_TO_PERMISSION_MAP (38 keys) matches snapshot exactly — per-key array equality', () => {
    expect(FEATURE_TO_PERMISSION_MAP).toEqual(FEATURE_TO_PERMISSION_MAP_SNAPSHOT);
  });

  it('SIDEBAR_PRIVILEGE_MAP (11 sections): sidebarIds match snapshot in order', () => {
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

  it('configurable node count is exactly 40', () => {
    // Post domain-strip: the 8 core sidebar groups (dashboard, users,
    // admin-requests, configuration, notifications, audit, system-health,
    // debug-traces) contribute 26 configurable nodes. The old version-history
    // group was removed with its page — all four versioned entities it browsed
    // went in the Phase 0 strip. 2026-08-05 added the 9th group, instruments,
    // with 4 configurable nodes (view / create / edit / delete) → 30. 2026-08-13
    // added the 10th group, functional-locations, with 4 more → 34.
    // 2026-08-13 (C3) added the 11th group, alarms, with 2 configurable nodes
    // (view / acknowledge) plus 2 alarm-rule nodes under the CONFIGURATION group,
    // since Alarm Rules is a config page rather than its own sidebar item → 38.
    // 2026-08-27 added 2 alarm_webhooks nodes (view / manage) under the same
    // CONFIGURATION group, for the same reason as alarm_rules → 40.
    // 2026-09-07 added the 12th group, data-report (the Instrument History
    // widget moved off the dashboard onto its own sidebar page), with 1
    // configurable node (view) → 41.
    // 2026-09-07 (later) added the 13th group, reports (the report review
    // workflow: every PDF download is a request an approver signs), with 2
    // configurable nodes (view / approve) → 43.
    const count = PERMISSION_TREE.flatMap(g => g.nodes).filter(n => n.configurable === true).length;
    expect(count).toBe(43);
  });

  it('FEATURE_PRIVILEGES has exactly 43 entries', () => {
    expect(FEATURE_PRIVILEGES).toHaveLength(43);
  });

  it('FEATURE_TO_PERMISSION_MAP has exactly 43 keys', () => {
    expect(Object.keys(FEATURE_TO_PERMISSION_MAP)).toHaveLength(43);
  });

  it('SIDEBAR_PRIVILEGE_MAP has exactly 13 sections', () => {
    expect(SIDEBAR_PRIVILEGE_MAP).toHaveLength(13);
  });
});
