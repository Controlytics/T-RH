/**
 * Pure helper — groups FEATURE_PRIVILEGES by the PERMISSION_TREE sidebar structure.
 *
 * Used by the Roles & Access → Permissions tab to render a Sidebar → Page → Action
 * hierarchy instead of the old flat category list.
 *
 * Intentionally a plain .ts (not .tsx) so the coverage test can import it without
 * pulling React or SWR through the vitest transform.
 */
import { PERMISSION_TREE, FEATURE_PRIVILEGES } from '@digilog/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single FP-backed permission node (one role-configurable toggle). */
export interface TreePermissionNode {
  id: string;
  label: string;
  page: string;
  action: string;
  icon: string;
  /** Cross-linked step-up action (informational display only — does not affect save map). */
  reauthAction?: string;
}

/** Nodes within a sidebar group, sub-grouped by their page label. */
export interface TreePageGroup {
  page: string;
  nodes: TreePermissionNode[];
}

/** A sidebar group in the tree, containing only FP-backed nodes. */
export interface TreeSidebarGroup {
  sidebarId: string;
  label: string;
  /** Emoji / icon token from PERMISSION_TREE (e.g. '👥', '⚙️'). */
  icon: string;
  /** All FP ids in this sidebar group — used for per-group Enable All / Disable All. */
  fpNodeIds: string[];
  pageGroups: TreePageGroup[];
}

export interface GroupedPermissionTree {
  /** Sidebar groups in PERMISSION_TREE order. Each may have multiple page sub-groups. */
  groups: TreeSidebarGroup[];
  /**
   * FP ids not covered by any tree node.
   * SHOULD be empty when PERMISSION_TREE is in sync with FEATURE_PRIVILEGES.
   * Rendered as a trailing "Other Permissions" catch-all to guarantee
   * the COVERAGE INVARIANT: every FP id appears exactly once in the UI.
   */
  other: TreePermissionNode[];
}

// ─── Core grouping function ───────────────────────────────────────────────────

/**
 * Groups every FEATURE_PRIVILEGES id into the PERMISSION_TREE sidebar structure.
 *
 * COVERAGE INVARIANT:
 *   Set(groups[*].fpNodeIds) ∪ Set(other[*].id)  ===  Set(FEATURE_PRIVILEGES[*].id)
 *   — no missing, no extras, no duplicates.
 *
 * Algorithm:
 *   1. Build a Set of all FP ids for O(1) membership tests.
 *   2. Walk PERMISSION_TREE in order; for each node whose id is an FP id (and not
 *      already placed), collect it under the sidebar group + page.
 *   3. Any FP id not reached by the tree walk goes into `other` (the catch-all).
 */
export function groupFeaturePrivilegesByTree(): GroupedPermissionTree {
  const fpIdSet = new Set(FEATURE_PRIVILEGES.map(fp => fp.id));
  const fpById = new Map(FEATURE_PRIVILEGES.map(fp => [fp.id, fp]));
  const placed = new Set<string>();
  const groups: TreeSidebarGroup[] = [];

  for (const sidebarGroup of PERMISSION_TREE) {
    const fpNodesInGroup: TreePermissionNode[] = [];

    for (const node of sidebarGroup.nodes) {
      // Skip enforced-only nodes (not in FEATURE_PRIVILEGES) and any duplicate
      if (!fpIdSet.has(node.id) || placed.has(node.id)) continue;

      fpNodesInGroup.push({
        id: node.id,
        label: node.label,
        page: node.page,
        action: node.action,
        icon: node.icon,
        reauthAction: node.reauthAction,
      });
      placed.add(node.id);
    }

    if (fpNodesInGroup.length === 0) continue; // skip sidebar groups with no FP nodes

    // Sub-group by page, preserving PERMISSION_TREE order
    const pageOrder: string[] = [];
    const pageMap = new Map<string, TreePermissionNode[]>();
    for (const node of fpNodesInGroup) {
      if (!pageMap.has(node.page)) {
        pageOrder.push(node.page);
        pageMap.set(node.page, []);
      }
      pageMap.get(node.page)!.push(node);
    }

    groups.push({
      sidebarId: sidebarGroup.sidebarId,
      label: sidebarGroup.label,
      icon: sidebarGroup.icon,
      fpNodeIds: fpNodesInGroup.map(n => n.id),
      pageGroups: pageOrder.map(page => ({ page, nodes: pageMap.get(page)! })),
    });
  }

  // Catch-all: FP ids not covered by any node in PERMISSION_TREE
  const other: TreePermissionNode[] = FEATURE_PRIVILEGES
    .filter(fp => !placed.has(fp.id))
    .map(fp => ({
      id: fp.id,
      label: fp.label,
      page: 'Other Permissions',
      action: fp.label,
      icon: fp.icon,
      reauthAction: undefined,
    }));

  return { groups, other };
}
