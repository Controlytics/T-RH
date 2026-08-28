import type { FlType } from './validation.js';

/**
 * Tree shaping for functional locations. Pure, so every rule below is testable
 * without a database.
 *
 * Depth is capped at 2 (BLOCK > AREA), which is why `resolveLocationIds` needs no
 * recursion. If the cap is ever raised, this file is the first thing that must
 * change — a one-level lookup would then silently omit grandchildren, and the
 * symptom would be "the Block view is missing instruments", not an error.
 */

export interface FlNode {
  id: string;
  name: string;
  type: FlType;
  parentId: string | null;
}

export interface FlTreeNode extends FlNode {
  /** Instruments linked to THIS location. */
  ownCount: number;
  /** This location's instruments plus every descendant's. */
  totalCount: number;
  children: FlTreeNode[];
}

/**
 * Every location id whose instruments belong to `id`'s view: itself, plus its
 * Areas when it is a Block.
 *
 * This is the ONE place that expansion happens. Every read path that filters by
 * location must go through it — a Block view that queries `functionalLocationId =
 * :id` directly shows only the instruments pinned to the Block itself and quietly
 * drops everything in its Areas.
 *
 * An unknown id returns `[]`, NOT every id: a caller that asked for one location
 * must never be handed the whole estate because the id was stale.
 */
export function resolveLocationIds(id: string, all: FlNode[]): string[] {
  const self = all.find((n) => n.id === id);
  if (!self) return [];
  if (self.type === 'AREA') return [self.id];
  return [self.id, ...all.filter((n) => n.parentId === self.id).map((n) => n.id)];
}

/**
 * The INVERSE of `resolveLocationIds`: for each location id, every location that
 * would grant it if selected. An Area maps to itself plus its Block; a Block maps
 * to itself.
 *
 * Built BY CALLING `resolveLocationIds` over every location rather than by walking
 * `parentId` upward, so the two answers cannot drift. A hand-written upward walk
 * would be a second copy of the containment rule, and the day the BLOCK > AREA
 * depth cap changes, one of the two copies gets updated and the other quietly
 * disagrees — with the symptom being a UI that says an instrument is not covered
 * while the query happily returns it.
 *
 * Used to tell the scope editor which instruments a selected location already
 * covers. That is a POLICY question ("what does this grant?"), so it is answered
 * here and shipped to the client, never re-derived in the browser.
 */
export function buildCoveringIndex(all: FlNode[]): Map<string, string[]> {
  const covering = new Map<string, string[]>();
  for (const location of all) {
    for (const covered of resolveLocationIds(location.id, all)) {
      const list = covering.get(covered);
      if (list) list.push(location.id);
      else covering.set(covered, [location.id]);
    }
  }
  return covering;
}

const byName = (a: FlNode, b: FlNode) => a.name.localeCompare(b.name);

/**
 * Blocks with their Areas nested, both sorted by name, with instrument counts
 * rolled up. `counts` maps location id → instruments linked directly to it.
 *
 * An Area whose parent is absent is DROPPED rather than promoted to the top level:
 * the FK is RESTRICT so it cannot happen, but rendering an orphan as a Block would
 * misrepresent the hierarchy to whoever is reading it.
 */
export function buildTree(all: FlNode[], counts: Map<string, number>): FlTreeNode[] {
  const blocks = all.filter((n) => n.type === 'BLOCK').sort(byName);

  // Only BLOCKs become roots, so an AREA whose parent is missing is simply never
  // emitted — dropped rather than promoted to the top level, where it would
  // misrepresent the hierarchy. The FK is RESTRICT so it cannot arise anyway.
  return blocks.map((block) => {
    const children: FlTreeNode[] = all
      .filter((n) => n.type === 'AREA' && n.parentId === block.id)
      .sort(byName)
      .map((area) => ({
        ...area,
        ownCount: counts.get(area.id) ?? 0,
        totalCount: counts.get(area.id) ?? 0,
        children: [],
      }));

    const ownCount = counts.get(block.id) ?? 0;
    return {
      ...block,
      ownCount,
      totalCount: ownCount + children.reduce((sum, c) => sum + c.totalCount, 0),
      children,
    };
  });
}

/** `"CWH > Module-E"` for an Area, `"CWH"` for a Block, null if unknown. */
export function locationPath(id: string | null | undefined, all: FlNode[]): string | null {
  if (!id) return null;
  const node = all.find((n) => n.id === id);
  if (!node) return null;
  if (node.type === 'BLOCK' || !node.parentId) return node.name;
  const parent = all.find((n) => n.id === node.parentId);
  return parent ? `${parent.name} > ${node.name}` : node.name;
}
