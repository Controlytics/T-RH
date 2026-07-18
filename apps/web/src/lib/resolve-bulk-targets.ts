// Pure helper resolving which rows a bulk action actually operates on.
//
// A selection Set outlives the query that produced it. On the Filters page the
// Set survives changes to the search box / block / diagram filter, but the list
// only ever RENDERS the narrowed `blockFilters` — so acting on the raw Set let a
// bulk retire/replace/status-update hit filters the operator could not see: search
// "AHU-1", Select All, retype "AHU-2", confirm, and ten invisible AHU-1 filters
// were retired. The Audit Trail page has the same shape with a harsher blast
// radius (bulk redact / hash-chain-breaking hard delete) — there the Set survives
// a re-sort or a page-size change, which swap the rendered rows underneath it.
//
// Narrowing to the intersection is the least-surprise rule: a destructive action
// may only touch rows currently on screen. Callers derive their confirm-dialog
// list AND their count from this same value, so what the operator is told is
// exactly what happens.
export function resolveBulkTargets<T extends { id: string }>(
  selectedIds: Set<string>,
  visibleRows: T[],
): T[] {
  return visibleRows.filter(row => selectedIds.has(row.id));
}
