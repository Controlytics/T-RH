/**
 * The selection model behind the Instruments page's history widget
 * (2026-09-05): a Block, an Area inside it, and the instruments in scope —
 * either ALL of them or a hand-picked subset.
 *
 * Pure, so the rules can be pinned without mounting the widget:
 *  - the SCOPE is the Area if one is chosen, else the Block, else everything —
 *    and the scope id is sent to `/api/instruments?functionalLocationId=`,
 *    which expands a Block to its Areas SERVER-side (`resolveLocationIds`).
 *    The browser never re-derives that expansion.
 *  - `selected === null` means "every instrument in scope" — the operator's
 *    "Area wise" download. A Set means exactly those ids. Ticking narrows;
 *    a Set that names everything in scope collapses back to null, so
 *    "all" and "every one ticked" are one state, not two.
 *  - an id that has left the scope (the Area changed) is dropped from the
 *    Set: a hidden tick that still drives a download is a decoy.
 */

export interface LocationNode { id: string; name: string; children?: LocationNode[] }
export interface ScopedInstrument { id: string; code: string; name: string; functionalLocationId?: string | null }

/** Which functional location id the instrument list is asked for, or null for all. */
export function scopeIdFor(blockId: string, areaId: string): string | null {
  return areaId || blockId || null;
}

/** The Areas of the chosen Block, or none when no Block is chosen. */
export function areasOf(tree: readonly LocationNode[], blockId: string): LocationNode[] {
  return tree.find((b) => b.id === blockId)?.children ?? [];
}

/**
 * The ids a download covers: everything in scope, or the ticked subset
 * intersected with what is in scope.
 */
export function effectiveSelection(
  inScope: readonly ScopedInstrument[],
  selected: ReadonlySet<string> | null,
): ScopedInstrument[] {
  if (selected === null) return [...inScope];
  return inScope.filter((i) => selected.has(i.id));
}

/** Toggle one id; collapse to null when every instrument in scope is ticked. */
export function toggleSelection(
  inScope: readonly ScopedInstrument[],
  selected: ReadonlySet<string> | null,
  id: string,
): Set<string> | null {
  const next = new Set(selected ?? inScope.map((i) => i.id));
  if (next.has(id)) next.delete(id); else next.add(id);
  const scopeIds = new Set(inScope.map((i) => i.id));
  for (const s of next) if (!scopeIds.has(s)) next.delete(s);
  return next.size === scopeIds.size && scopeIds.size > 0 ? null : next;
}

/** The Block and Area NAMES the report's cover prints for a scope. */
export function scopeNames(tree: readonly LocationNode[], blockId: string, areaId: string): { blockName: string; areaName: string } {
  const block = tree.find((b) => b.id === blockId);
  const area = block?.children?.find((a) => a.id === areaId);
  return { blockName: block?.name ?? '', areaName: area?.name ?? '' };
}
