/**
 * Coverage invariant test for the Roles & Access Permissions tab tree grouping.
 *
 * Asserts that groupFeaturePrivilegesByTree() produces a grouped structure
 * whose union equals FEATURE_PRIVILEGES ids exactly — no missing, no extras,
 * no duplicates. This is the purity guarantee that the admin can always
 * toggle every feature privilege from the tree UI.
 *
 * Pure test — no React, no SWR, no DOM. Runs in vitest node/jsdom environment.
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_PRIVILEGES } from '@digilog/shared';
import { groupFeaturePrivilegesByTree } from '../permission-tree-grouping';

describe('groupFeaturePrivilegesByTree — coverage invariant', () => {
  const { groups, other } = groupFeaturePrivilegesByTree();

  // ── Collect every id produced by the grouping function ───────────────────
  const allPlacedIds: string[] = [];
  for (const group of groups) {
    for (const pageGroup of group.pageGroups) {
      for (const node of pageGroup.nodes) {
        allPlacedIds.push(node.id);
      }
    }
  }
  // Also include catch-all ids
  for (const node of other) {
    allPlacedIds.push(node.id);
  }

  const fpIds = FEATURE_PRIVILEGES.map(fp => fp.id);
  const fpIdSet = new Set(fpIds);

  it('covers every FEATURE_PRIVILEGES id (no missing)', () => {
    for (const fpId of fpIdSet) {
      expect(allPlacedIds, `FP id '${fpId}' is missing from the grouped tree`).toContain(fpId);
    }
  });

  it('produces no extra ids not in FEATURE_PRIVILEGES', () => {
    for (const id of allPlacedIds) {
      expect(
        fpIdSet.has(id),
        `Extra id '${id}' in grouped tree that is not in FEATURE_PRIVILEGES`,
      ).toBe(true);
    }
  });

  it('produces no duplicate ids', () => {
    const seen = new Set<string>();
    for (const id of allPlacedIds) {
      expect(seen.has(id), `Duplicate id '${id}' in grouped tree`).toBe(false);
      seen.add(id);
    }
  });

  it('total count equals FEATURE_PRIVILEGES.length', () => {
    expect(allPlacedIds).toHaveLength(FEATURE_PRIVILEGES.length);
  });

  it('other (catch-all) is empty — all FP ids are covered by the tree', () => {
    if (other.length > 0) {
      const uncovered = other.map(n => n.id).join(', ');
      // Fail with helpful message showing which ids need tree entries
      expect(other, `These FP ids are not in PERMISSION_TREE and fell into the catch-all: ${uncovered}`).toHaveLength(0);
    }
  });

  // ── Per-group structural checks ───────────────────────────────────────────
  it('every group has at least one page group and at least one node', () => {
    for (const group of groups) {
      expect(group.pageGroups.length, `Group '${group.label}' has no page groups`).toBeGreaterThan(0);
      expect(group.fpNodeIds.length, `Group '${group.label}' has no FP node ids`).toBeGreaterThan(0);
    }
  });

  it('fpNodeIds are consistent with pageGroup nodes', () => {
    for (const group of groups) {
      const nodeIdsFromPages = group.pageGroups.flatMap(pg => pg.nodes.map(n => n.id));
      expect(group.fpNodeIds.sort()).toEqual(nodeIdsFromPages.sort());
    }
  });

  it('every node with reauthAction has a string reauthAction', () => {
    for (const group of groups) {
      for (const pg of group.pageGroups) {
        for (const node of pg.nodes) {
          if (node.reauthAction !== undefined) {
            expect(typeof node.reauthAction).toBe('string');
            expect(node.reauthAction.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
