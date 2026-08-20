// Pure helper resolving which rows a bulk action actually operates on.
//
// A selection Set outlives the query that produced it. On the Audit Trail page
// the Set survives changes to the search box, the date range and the sort, but
// the list only ever RENDERS the narrowed rows — so acting on the raw Set let a
// bulk delete/redact hit records the operator could not see: filter to one day,
// Select All, widen the range, confirm, and rows never displayed
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
