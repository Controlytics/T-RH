export const ALL = 'all';

export interface FilterAncestry {
  ahuId: string | null;
  areaId: string | null;
  blockId: string | null;
}

export interface CascadeSelection {
  blockId: string;
  areaId: string;
  ahuId: string;
  filterId: string;
}

/**
 * Narrow a filter list to the Block/Area/AHU/Filter cascade selection.
 * `ALL` at any level means "don't constrain on this level".
 *
 * A filter with no known ancestry is dropped rather than passed through: it
 * cannot be shown to belong to the selected scope, and leaking it would put a
 * filter from another block in front of an operator.
 */
export function scopeFiltersToCascade<T extends { id: string }>(
  filters: T[],
  ancestors: Map<string, FilterAncestry>,
  selection: CascadeSelection,
): T[] {
  return filters.filter((filter) => {
    const ancestry = ancestors.get(filter.id);
    if (!ancestry) return false;
    if (selection.blockId !== ALL && ancestry.blockId !== selection.blockId) return false;
    if (selection.areaId !== ALL && ancestry.areaId !== selection.areaId) return false;
    if (selection.ahuId !== ALL && ancestry.ahuId !== selection.ahuId) return false;
    if (selection.filterId !== ALL && filter.id !== selection.filterId) return false;
    return true;
  });
}

/**
 * Tally filters by lifecycle state.
 *
 * Callers MUST pass the same scoped array they render, so the tile counts and
 * the list below them can never disagree — that disagreement was the bug this
 * function exists to prevent.
 */
export function countByStage(
  filters: { currentLifecycleState?: string | null }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const filter of filters) {
    const state = filter.currentLifecycleState;
    if (state) counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}
