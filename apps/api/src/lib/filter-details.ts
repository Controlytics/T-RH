/**
 * FilterDetails — 1:1 sidecar accessors (Step 6 — 2026-05-01)
 *
 * Filter-specific cycle state (filterProfileId, currentLifecycleState,
 * currentCycleId, filterSet) was split off AssetInstance into its own
 * 1:1 table because those fields are meaningless for non-filter rows.
 *
 * This module provides:
 *   - upsertFilterDetails(filterId, patch): write helper
 *   - flattenFilterFields(instance): adapter for instance objects already
 *     loaded with `include: { filterDetails: true }` so API response shapes
 *     stay flat (frontend stays unchanged)
 */
import { prisma } from './prisma.js';

export type FilterSetLabel = 'SET_A' | 'SET_B';

export type FilterDetailsPatch = Partial<{
  filterProfileId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterSet: FilterSetLabel | null;
}>;

/** Upsert FilterDetails for a filter. Creates the row if missing.
 *  Pass an explicit `null` to clear a field; omit a key to leave it unchanged. */
export async function upsertFilterDetails(
  filterId: string,
  patch: FilterDetailsPatch,
  tx?: Parameters<typeof prisma.$transaction>[0] extends (t: infer T) => any ? T : never,
): Promise<void> {
  const client = (tx ?? prisma) as typeof prisma;
  await client.filterDetails.upsert({
    where: { assetInstanceId: filterId },
    update: patch as any,
    create: { assetInstanceId: filterId, ...(patch as any) },
  });
}

/** Flatten an AssetInstance loaded with `include: { filterDetails: true }` so
 *  API responses keep the legacy shape (the 4 fields appear on the instance,
 *  not nested under `filterDetails`). Idempotent. */
export function flattenFilterFields<T extends { filterDetails?: any | null }>(
  instance: T,
): T & {
  filterProfileId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterSet: FilterSetLabel | null;
} {
  const fd = (instance as any).filterDetails ?? null;
  const out: any = { ...instance };
  out.filterProfileId = fd?.filterProfileId ?? null;
  out.currentLifecycleState = fd?.currentLifecycleState ?? null;
  out.currentCycleId = fd?.currentCycleId ?? null;
  out.filterSet = fd?.filterSet ?? null;
  // Drop the nested object from the response so consumers don't see two copies
  delete out.filterDetails;
  return out;
}

/** Same as flattenFilterFields but accepts an array. */
export function flattenFilterFieldsAll<T extends { filterDetails?: any | null }>(
  instances: T[],
): Array<T & {
  filterProfileId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterSet: FilterSetLabel | null;
}> {
  return instances.map(flattenFilterFields);
}
