/**
 * Resolve each AHU to its owning Block.
 *
 * The typed hierarchy is Block → (Area →)? AHU → Filter: an AHU sits either
 * DIRECTLY under a block (`ahu.blockId` set, no area) or under an area
 * (`ahu.areaId` set, block reached via `area.blockId`). Filter rows only carry
 * `ahuId`, so to scope a filter to a block we first need this AHU→block map.
 */
export interface AhuRow {
  id: string;
  blockId?: string | null;
  areaId?: string | null;
}
export interface AreaRow {
  id: string;
  blockId?: string | null;
}

/** ahuId → blockId, resolving area-nested AHUs through their area's block. */
export function buildAhuBlockMap(ahus: AhuRow[], areas: AreaRow[]): Record<string, string> {
  const areaToBlock: Record<string, string> = {};
  for (const a of areas) {
    if (a.blockId) areaToBlock[a.id] = a.blockId;
  }
  const map: Record<string, string> = {};
  for (const ahu of ahus) {
    const blockId = ahu.blockId ?? (ahu.areaId ? areaToBlock[ahu.areaId] : undefined);
    if (blockId) map[ahu.id] = blockId;
  }
  return map;
}

/**
 * Scope a list of filter rows to a block using the AHU→block map.
 *
 * - No block selected  → `[]` (caller should only render once a block is
 *   chosen; this guards the case anyway).
 * - Map not loaded yet / offline (but a block IS selected) → the list unchanged,
 *   so offline operators aren't left blind — it just isn't scoped until the map
 *   is available.
 * - Otherwise → only rows whose AHU maps to the selected block.
 */
export function filtersInBlock<T extends { ahuId?: string | null }>(
  rows: T[],
  blockId: string | null | undefined,
  ahuBlockMap: Record<string, string>,
): T[] {
  if (!blockId) return [];
  if (Object.keys(ahuBlockMap).length === 0) return rows;
  return rows.filter((r) => r.ahuId != null && ahuBlockMap[r.ahuId] === blockId);
}
