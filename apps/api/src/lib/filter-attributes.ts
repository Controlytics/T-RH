/**
 * filter-attributes.ts — merge the typed `filters.attributes` (micronSize /
 * filterSize / filterType / ahuType / lastCleaningDate) onto asset-instance rows.
 *
 * Since the A-01 typed-table migration, the authoritative filter attributes live
 * in the typed `filters` table; `asset_instances.custom_attributes` stays EMPTY
 * ({}) for filters. So any consumer reading `instance.attributes.micronSize`
 * (e.g. the tablet replacement-task pick-list, which matches AHU filters against
 * a task's micron + size) saw nothing and could never match. This zips the typed
 * values back onto each row's `attributes`. Non-filter rows are unchanged.
 *
 * One indexed findMany per call. Typed values win over the (empty) instance ones.
 */
import { prisma } from './prisma.js';

export async function zipFilterAttributes<T extends { id: string; attributes?: any }>(
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const filters = await prisma.filter.findMany({
    where: { id: { in: ids } },
    select: { id: true, attributes: true },
  });
  const byId = new Map<string, Record<string, unknown>>(
    filters.map((f) => [f.id, (f.attributes ?? {}) as Record<string, unknown>]),
  );
  return rows.map((r) => {
    const typed = byId.get(r.id);
    if (!typed) return r; // non-filter row (block / area / AHU) — leave as-is
    return { ...r, attributes: { ...(r.attributes ?? {}), ...typed } };
  });
}
