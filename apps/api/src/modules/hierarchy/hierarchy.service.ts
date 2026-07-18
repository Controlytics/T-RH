/**
 * hierarchy.service.ts — Wave 2 of the asset-removal programme (2026-05-17).
 *
 * Read-only service over the new typed-hierarchy tables (`blocks`, `areas`,
 * `ahus`, `filters`). Wave 1 introduced the four Prisma models + the
 * `fn_mirror_asset_instance` trigger that keeps them in sync with every
 * `asset_instances` mutation, so writes still flow through the legacy
 * `instance.service.ts` and we just *read* the mirrored typed rows here.
 *
 * Why a service layer (when the routes are this thin):
 *   - Lets the route file stay declarative (schema + auth + handler glue).
 *   - Makes unit-testing the query shapes cheap — mock `prisma.block.*`
 *     and assert the `where` / `include` payloads without standing up a
 *     Fastify instance.
 *   - Gives us one place to grow visibility filters or pin-cycle joins
 *     later without re-templating route schemas.
 *
 * Pagination contract (matches the audit §1.8 fix landed earlier today on
 *   `queries/telemetry.routes.ts`):
 *   - default page = 1, default limit = 50
 *   - hard ceiling = 500 enforced both by the JSON-schema `maximum: 500`
 *     and by `Math.min(Math.max(limit ?? 50, 1), 500)` in `normalizeLimit`.
 *
 * Visibility: this read path does NOT apply EntityAssignment /
 * TemplateAssignment scoping. Wave 2 is just proving the read path; the
 * existing /api/assets/instances endpoints still serve the gated-list use
 * case. Wave 5 will revisit if the typed-hierarchy route becomes the FE's
 * primary feed.
 */

import { prisma } from '../../lib/prisma.js';
import { zipLastCleaned } from '../../lib/last-cleaned.js';
import { filterService } from '../assets/services/filter.service.js';
import type { FilterFieldInput } from '../assets/services/filter-fields.service.js';
import type { RequestContext } from '../../types/context.js';

// 2026-07-03: record lists are uncapped per user request. An OMITTED limit means
// "return ALL rows" (no Prisma `take`). MAX_LIMIT is only a sanity gate for an
// explicitly-provided value — the frontend now omits limit entirely.
const MAX_LIMIT = 1_000_000;

type ExpandLevel = 0 | 1 | 2 | 3;

export interface PageQuery {
  page?: number;
  limit?: number;
}

export interface BlockListQuery extends PageQuery {
  expand?: string;
}

export interface AreaListQuery extends PageQuery {
  blockId?: string;
  expand?: string;
}

export interface AhuListQuery extends PageQuery {
  areaId?: string;
  expand?: string;
}

export interface FilterListQuery extends PageQuery {
  ahuId?: string;
}

/**
 * Returns `undefined` when the client omits `limit` — the record list is
 * uncapped (2026-07-03), so an omitted limit returns ALL rows (no `take`).
 * A provided value is honored (min 1), clamped only by the huge sanity ceiling.
 */
export function normalizeLimit(raw?: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

export function normalizePage(raw?: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
  return Math.max(Math.trunc(n), 1);
}

/**
 * `?expand=areas` → 1
 * `?expand=areas.ahus` → 2
 * `?expand=areas.ahus.filters` → 3
 * (anything unrecognised → 0; no expansion)
 */
function parseExpandDepthFromBlock(expand?: string): ExpandLevel {
  switch (expand) {
    case 'areas': return 1;
    case 'areas.ahus': return 2;
    case 'areas.ahus.filters': return 3;
    default: return 0;
  }
}

/**
 * `?expand=ahus` → 1
 * `?expand=ahus.filters` → 2
 */
function parseExpandDepthFromArea(expand?: string): 0 | 1 | 2 {
  switch (expand) {
    case 'ahus': return 1;
    case 'ahus.filters': return 2;
    default: return 0;
  }
}

function parseExpandDepthFromAhu(expand?: string): 0 | 1 {
  return expand === 'filters' ? 1 : 0;
}

/**
 * Fetch FilterDetails rows for the given filter ids and flatten the
 * cycle-state fields onto each filter row. Single Prisma query, JS-side zip
 * via a Map. Returns rows in the same order as input. Filters with no
 * FilterDetails row (legacy / mid-migration) get explicit `null`s for the
 * four cycle-state fields so the FE consumer never sees `undefined`.
 */
async function zipFilterDetails<T extends { id: string }>(rows: T[]): Promise<Array<T & {
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterProfileId: string | null;
  filterSet: string | null;
}>> {
  if (rows.length === 0) return [] as any;
  const ids = rows.map((r) => r.id);
  const details = await prisma.filterDetails.findMany({
    where: { assetInstanceId: { in: ids } },
    select: {
      assetInstanceId: true,
      currentLifecycleState: true,
      currentCycleId: true,
      filterProfileId: true,
      filterSet: true,
    },
  });
  const byId = new Map(details.map((d) => [d.assetInstanceId, d]));
  return rows.map((r) => {
    const d = byId.get(r.id);
    return {
      ...r,
      currentLifecycleState: d?.currentLifecycleState ?? null,
      currentCycleId: d?.currentCycleId ?? null,
      filterProfileId: d?.filterProfileId ?? null,
      filterSet: (d?.filterSet as string | null | undefined) ?? null,
    };
  });
}

// Filter-event types that count as cleaning-stage activity. "Last Cleaned"
// tracks the latest of these — EVERY cleaning stage the filter has reached,
// whether from a real cleaning cycle (advance/bypass/completion) OR a manual
// "Edit Filter Status" change to a cleaning stage (which the operator uses to
// track cleaning). CYCLE_STARTED / checklist / terminate are excluded — not a
// cleaning stage landing.
//
// 2026-06-03 (operator): the Filters page must be coherent — if a filter shows a
// cleaning stage (Wash In / Dry In / Cleaning Cycle Completed / ...), Last
// Cleaned must show when it entered that stage. So manual STATE_TRANSITION events
// (cycleId=null) ARE counted here. A filter that was NEVER put into any cleaning
// stage has no such event, so it shows no date — unless an admin typed one at
// creation (the lastCleaningDate seed). (An earlier attempt to exclude manual
// events left "status shown but date empty" rows — the opposite complaint.)
// `zipLastCleaned` + `CLEANING_STAGE_EVENT_TYPES` moved to lib/last-cleaned.ts
// (2026-06-11) so the assets/instances list can attach the SAME lastCleanedAt
// the tablet reads — see that file's docblock. Imported at the top.

/** Flatten FilterDetails cycle-state AND the derived lastCleanedAt onto rows. */
async function enrichFilterRows<T extends { id: string; attributes?: any }>(rows: T[]) {
  return zipLastCleaned(await zipFilterDetails(rows));
}

/** Build a nested Prisma `include` for the blocks query. */
function buildBlockInclude(depth: ExpandLevel): Record<string, unknown> | undefined {
  if (depth === 0) return undefined;
  if (depth === 1) return { areas: { where: { isActive: true } } };
  if (depth === 2) {
    return {
      areas: {
        where: { isActive: true },
        include: { ahus: { where: { isActive: true } } },
      },
    };
  }
  // depth === 3
  return {
    areas: {
      where: { isActive: true },
      include: {
        ahus: {
          where: { isActive: true },
          include: { filters: { where: { isActive: true } } },
        },
      },
    },
  };
}

function buildAreaInclude(depth: 0 | 1 | 2): Record<string, unknown> | undefined {
  if (depth === 0) return undefined;
  if (depth === 1) return { ahus: { where: { isActive: true } } };
  return {
    ahus: {
      where: { isActive: true },
      include: { filters: { where: { isActive: true } } },
    },
  };
}

function buildAhuInclude(depth: 0 | 1): Record<string, unknown> | undefined {
  if (depth === 0) return undefined;
  return { filters: { where: { isActive: true } } };
}

interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

function paginateMeta(total: number, page: number, limit?: number) {
  return {
    total,
    page,
    // Uncapped list (limit omitted) → the whole set is returned on page 1.
    limit: limit ?? total,
    totalPages: !limit ? 1 : (total === 0 ? 0 : Math.ceil(total / limit)),
  };
}

export type CreateFilterInput = FilterFieldInput & {
  name: string;
  ahuId: string;
  filterSet?: 'A' | 'B';
  filterProfileId?: string;
};

export const hierarchyService = {
  // ─── BLOCKS ───────────────────────────────────────────────────────────
  async listBlocks(q: BlockListQuery): Promise<PaginatedResult<unknown>> {
    const page = normalizePage(q.page);
    const limit = normalizeLimit(q.limit);
    const depth = parseExpandDepthFromBlock(q.expand);
    const include = buildBlockInclude(depth);
    const where = { isActive: true };
    const [rows, total] = await Promise.all([
      prisma.block.findMany({
        where,
        ...(include ? { include } : {}),
        orderBy: { name: 'asc' },
        skip: limit ? (page - 1) * limit : 0,
        take: limit,
      } as any),
      prisma.block.count({ where }),
    ]);
    return { data: rows as unknown[], ...paginateMeta(total, page, limit) };
  },

  async getBlock(id: string, expand?: string) {
    const depth = parseExpandDepthFromBlock(expand);
    const include = buildBlockInclude(depth);
    return prisma.block.findFirst({
      where: { id, isActive: true },
      ...(include ? { include } : {}),
    } as any);
  },

  // ─── AREAS ────────────────────────────────────────────────────────────
  async listAreas(q: AreaListQuery): Promise<PaginatedResult<unknown>> {
    const page = normalizePage(q.page);
    const limit = normalizeLimit(q.limit);
    const depth = parseExpandDepthFromArea(q.expand);
    const include = buildAreaInclude(depth);
    const where: Record<string, unknown> = { isActive: true };
    if (q.blockId) where.blockId = q.blockId;
    const [rows, total] = await Promise.all([
      prisma.area.findMany({
        where,
        ...(include ? { include } : {}),
        orderBy: { name: 'asc' },
        skip: limit ? (page - 1) * limit : 0,
        take: limit,
      } as any),
      prisma.area.count({ where }),
    ]);
    return { data: rows as unknown[], ...paginateMeta(total, page, limit) };
  },

  async getArea(id: string, expand?: string) {
    const depth = parseExpandDepthFromArea(expand);
    const include = buildAreaInclude(depth);
    return prisma.area.findFirst({
      where: { id, isActive: true },
      ...(include ? { include } : {}),
    } as any);
  },

  // ─── AHUS ─────────────────────────────────────────────────────────────
  async listAhus(q: AhuListQuery): Promise<PaginatedResult<unknown>> {
    const page = normalizePage(q.page);
    const limit = normalizeLimit(q.limit);
    const depth = parseExpandDepthFromAhu(q.expand);
    const include = buildAhuInclude(depth);
    const where: Record<string, unknown> = { isActive: true };
    if (q.areaId) where.areaId = q.areaId;
    const [rows, total] = await Promise.all([
      prisma.ahu.findMany({
        where,
        ...(include ? { include } : {}),
        orderBy: { name: 'asc' },
        skip: limit ? (page - 1) * limit : 0,
        take: limit,
      } as any),
      prisma.ahu.count({ where }),
    ]);
    return { data: rows as unknown[], ...paginateMeta(total, page, limit) };
  },

  async getAhu(id: string, expand?: string) {
    const depth = parseExpandDepthFromAhu(expand);
    const include = buildAhuInclude(depth);
    return prisma.ahu.findFirst({
      where: { id, isActive: true },
      ...(include ? { include } : {}),
    } as any);
  },

  // ─── FILTERS ──────────────────────────────────────────────────────────
  //
  // Cycle-state fields (currentLifecycleState, currentCycleId, filterProfileId,
  // filterSet) live on `FilterDetails`, NOT on the typed `Filter` table
  // (schema.prisma:514-520 explains why — they were dropped 2026-05-25 as a
  // drift hazard pending A-01 FilterDetails-into-Filter merge). The frontend
  // operator UI in filter-operations.tsx reads those fields off every filter
  // row to drive the stage counter / status drilldown / Set A/B labels, so
  // this endpoint LEFT JOINs FilterDetails and flattens the cycle-state
  // fields onto each filter row. The join is by ID because the trigger
  // `fn_mirror_asset_instance` keeps `filters.id == asset_instances.id ==
  // filter_details.asset_instance_id`. Once A-01 Phase 2 lands and the
  // columns move home, drop the manual zip.
  async listFilters(q: FilterListQuery): Promise<PaginatedResult<unknown>> {
    const page = normalizePage(q.page);
    const limit = normalizeLimit(q.limit);
    const where: Record<string, unknown> = { isActive: true };
    if (q.ahuId) where.ahuId = q.ahuId;
    const [rows, total] = await Promise.all([
      prisma.filter.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: limit ? (page - 1) * limit : 0,
        take: limit,
      } as any),
      prisma.filter.count({ where }),
    ]);
    const enriched = await enrichFilterRows(rows as Array<{ id: string; attributes?: any }>);
    return { data: enriched as unknown[], ...paginateMeta(total, page, limit) };
  },

  async getFilter(id: string) {
    const row = await prisma.filter.findFirst({ where: { id, isActive: true } } as any);
    if (!row) return row;
    const [enriched] = await enrichFilterRows([row as { id: string; attributes?: any }]);
    return enriched;
  },

  // Typed filter create (A-01 Tier 2). Delegates to the standalone filterService,
  // which writes the typed `filters` table directly — no templateId, no
  // asset_relationships, no validateParent. The reverse-mirror trigger keeps a
  // legacy asset_instances row in sync for un-migrated readers.
  async createFilter(input: CreateFilterInput, ctx: RequestContext) {
    return filterService.create(input, ctx);
  },

  // Typed-direct filter update / soft-delete (A-01 T2.3).
  async updateFilter(id: string, input: FilterFieldInput & { name?: string; filterSet?: 'A' | 'B' }, ctx: RequestContext) {
    return filterService.update(id, input, ctx);
  },

  async deleteFilter(id: string, ctx: RequestContext) {
    return filterService.softDelete(id, ctx);
  },

  // ─── FULL TREE ────────────────────────────────────────────────────────
  /**
   * Full nested tree (blocks → areas → ahus → filters) for the FE preview
   * page. Unbounded — there are 4 blocks / ~6 filters in production today,
   * so the row count cannot blow up. If the dataset grows, switch to the
   * paginated listBlocks + ?expand=areas.ahus.filters path.
   */
  async getTree() {
    const filterInclude = {
      filters: { where: { isActive: true }, orderBy: { name: 'asc' } },
    } as const;
    const blocks = await prisma.block.findMany({
      where: { isActive: true },
      include: {
        areas: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          include: {
            ahus: { where: { isActive: true }, orderBy: { name: 'asc' }, include: filterInclude },
          },
        },
        // A-01 T2.2: AHUs parented directly by the block (no area level). Without
        // this the 1 direct-under-block AHU + its filters would vanish from the
        // page when it reads the typed tree.
        ahus: { where: { isActive: true, areaId: null }, orderBy: { name: 'asc' }, include: filterInclude },
      },
      orderBy: { name: 'asc' },
    } as any);

    // Zip FilterDetails (filterSet / currentLifecycleState / currentCycleId /
    // filterProfileId) onto every nested filter — the typed `filters` table
    // dropped those columns (they live in FilterDetails), and the filter table
    // UI needs the Set + lifecycle state.
    const allFilters: any[] = [];
    for (const b of blocks as any[]) {
      for (const a of b.areas ?? []) for (const h of a.ahus ?? []) for (const f of h.filters ?? []) allFilters.push(f);
      for (const h of b.ahus ?? []) for (const f of h.filters ?? []) allFilters.push(f);
    }
    const byId = new Map((await enrichFilterRows(allFilters)).map((z: any) => [z.id, z]));
    const remap = (h: any) => { h.filters = (h.filters ?? []).map((f: any) => byId.get(f.id) ?? f); };
    for (const b of blocks as any[]) {
      for (const a of b.areas ?? []) for (const h of a.ahus ?? []) remap(h);
      for (const h of b.ahus ?? []) remap(h);
    }
    return blocks;
  },
};
