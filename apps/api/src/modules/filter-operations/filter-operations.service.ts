/**
 * Filter Operations Service — Core operations: cycle management, stage advancement, bypass.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import {
  getFilter,
  getFilterHomeBlock,
  validateBlockChange,
  getProfilePipeline,
  getCleaningReasons,
} from './filter-resolver.js';
import { getProfileOrderedStages, getFilterStageRules } from './stage-rules.js';
import { terminateCycleImpl } from './cycle-write/terminate-cycle.js';
import { bypassImpl } from './cycle-write/bypass.js';
import { submitChecklistImpl } from './cycle-write/submit-checklist.js';
import { advanceImpl } from './cycle-write/advance.js';
import { advanceWithChecklistImpl } from './cycle-write/advance-with-checklist.js';
import { startCycleImpl } from './cycle-write/start-cycle.js';
import { getCurrentStateImpl, getBatchStatesImpl } from './current-state.js';
import type { BatchReadCache } from './batch-cache.js';
import { bulkOperate, type BulkOpItem } from './cycle-write/bulk-operate.js';

// Note: the legacy local `assertTapeVersionFresh` was removed in Phase 8.5
// Commit 4. All four write methods now go through the shared
// `executor.assertTapeVersionFresh(ctx, submitted)` guard. The legacy local
// `computeChecksum`, `prettyStageLabel`, `collectChecklistsAfterStage`, and
// `resolveChecklistQuestions` helpers (plus the small per-cycle helpers
// `getFilter` / `getNextStageKeys` / `extractBlocks` / `resolveFilterProfile`)
// were extracted into ./helpers.ts and ./filter-resolver.ts. The 4 write
// methods + getCurrentState + getBatchStates were extracted into
// ./cycle-write/*.ts and ./current-state.ts. This file is now the
// orchestrator class — public surface preserved for routes + tests.

export class FilterOperationsService {
  // Public surface preserved: routes call service.getFilterHomeBlock(),
  // service.validateBlockChange(), service.getCleaningReasons(). The
  // implementations live in ./filter-resolver.ts; class methods are thin
  // forwards.
  async getFilterHomeBlock(filterId: string) {
    return getFilterHomeBlock(filterId);
  }

  async validateBlockChange(filterId: string, cleaningAreaId: string | undefined, ctx: RequestContext) {
    return validateBlockChange(filterId, cleaningAreaId, ctx);
  }

  // NOTE: kept as a class method (rather than calling the free function from
  // ./filter-resolver.ts directly) because get-current-state.test.ts monkey-
  // patches it via `(service as any).getProfilePipeline = vi.fn(...)` to
  // verify the L2 cycle-pinned-profile invariant. Removing the indirection
  // would silently bypass the spy.
  protected async getProfilePipeline(profileId: string, requireActive: boolean = false) {
    return getProfilePipeline(profileId, requireActive);
  }

  /**
   * Batch: get current-state for all active filters in the user's org.
   * Returns { states: { [filterId]: stateObject } } for offline caching.
   */
  async getBatchStates(ctx: RequestContext, cleaningAreaId?: string) {
    return getBatchStatesImpl(this, ctx, cleaningAreaId);
  }

  // `cache` (M39) is passed ONLY by getBatchStates, which shares one batch-scoped
  // read memo across its fan-out. Route handlers call this with 3 args and get the
  // unmemoised path, identical to pre-M39 behaviour.
  async getCurrentState(ctx: RequestContext, filterId: string, cleaningAreaId?: string, cache?: BatchReadCache) {
    return getCurrentStateImpl(this, ctx, filterId, cleaningAreaId, cache);
  }


  /** @param data - Validated by Fastify JSON schema before reaching this method */
  async submitChecklist(ctx: RequestContext, filterId: string, data: any) {
    return submitChecklistImpl(this, ctx, filterId, data);
  }

  /** @param data - Validated by Fastify JSON schema before reaching this method */
  async startCycle(ctx: RequestContext, filterId: string, data: any) {
    return startCycleImpl(this, ctx, filterId, data);
  }

  /** @param data - Validated by Fastify JSON schema before reaching this method */
  async advance(ctx: RequestContext, filterId: string, data: any) {
    return advanceImpl(this, ctx, filterId, data);
  }

  /**
   * Atomic advance + post-stage checklist in ONE transaction.
   *
   * The bare advance persists the transition before the operator can answer the
   * stage's mandatory checklist, leaving an orphaned §11 record when they close
   * the dialog. This op writes both or neither. See advance-with-checklist.ts.
   *
   * @param data - Validated by Fastify JSON schema before reaching this method
   */
  async advanceWithChecklist(ctx: RequestContext, filterId: string, data: any) {
    return advanceWithChecklistImpl(this, ctx, filterId, data);
  }

  /** @param data - Validated by Fastify JSON schema before reaching this method */
  async bypass(ctx: RequestContext, filterId: string, data: any) {
    return bypassImpl(this, ctx, filterId, data);
  }

  /**
   * Batch: dispatch a list of advance / start-and-advance / submit-checklist
   * ops, one per filter. Each item runs via its own single-op method (own
   * transaction, own audit row, all gates) — a failed item does not affect
   * the others (partial success).
   */
  async bulkOperate(ctx: RequestContext, items: BulkOpItem[]) {
    return bulkOperate(this, ctx, items);
  }

  /** @param query - Validated by Fastify JSON schema before reaching this method */
  async getEvents(ctx: RequestContext, query: any) {
    // Verify filterId belongs to user's org if provided
    if (query.filterId) {
      await getFilter(query.filterId, ctx);
    }

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: any = {};
    if (query.filterId) where.filterId = query.filterId;
    if (query.cycleId) where.cycleId = query.cycleId;
    if (query.eventType) where.eventType = query.eventType;
    if (query.from || query.to) {
      where.performedAt = {};
      if (query.from) where.performedAt.gte = new Date(query.from);
      if (query.to) where.performedAt.lte = new Date(query.to);
    }

    const [data, total] = await Promise.all([
      prisma.filterEvent.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { performedAt: 'desc' },
      }),
      prisma.filterEvent.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Manual status-change log for the "Manual Status Updates" tab on the
   * Cleaning Cycles page. Returns STATE_TRANSITION events that were recorded by
   * a manual "Edit Filter Status" action (cycleId IS NULL + attributes.manual =
   * true), enriched with filter + performer names. These are NOT cleaning
   * cycles — per the 21 CFR decision we never fabricate a cycle row — but they
   * carry the exact who/when/from→to so the change is visible alongside cycles.
   */
  async getManualStatusChanges(ctx: RequestContext, query: any) {
    if (query.filterId) {
      await getFilter(query.filterId, ctx);
    }
    const mIds: string[] | undefined = Array.isArray(query.ids) ? query.ids : undefined;
    const page = mIds ? 1 : (query.page ?? 1);
    const limit = mIds ? Math.max(mIds.length, 1) : Math.min(query.limit ?? 20, 100);
    const where: any = {
      eventType: 'STATE_TRANSITION',
      cycleId: null,
      attributes: { path: ['manual'], equals: true },
    };
    if (mIds) where.id = { in: mIds };
    if (query.filterId) where.filterId = query.filterId;
    if (query.from || query.to) {
      where.performedAt = {};
      if (query.from) where.performedAt.gte = new Date(query.from);
      if (query.to) where.performedAt.lte = new Date(query.to);
    }

    const [data, total] = await Promise.all([
      prisma.filterEvent.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { performedAt: 'desc' } }),
      prisma.filterEvent.count({ where }),
    ]);

    const filterIds = [...new Set(data.map((e) => e.filterId))];
    const performerIds = [...new Set(data.map((e) => e.performedBy).filter(Boolean))] as string[];
    const [filters, performers] = await Promise.all([
      filterIds.length ? prisma.assetInstance.findMany({ where: { id: { in: filterIds } }, select: { id: true, name: true } }) : [],
      performerIds.length ? prisma.user.findMany({ where: { id: { in: performerIds } }, select: { id: true, username: true, fullName: true } }) : [],
    ]);
    const fmap = new Map(filters.map((f) => [f.id, f.name]));
    const umap = new Map(performers.map((u) => [u.id, { fullName: u.fullName || u.username, username: u.username }]));

    // 2026-06-10: the cleaning-record view renders manual updates as cycle-style
    // rows, so attach each filter's profile stage order. The client uses it to
    // show "Skipped" for stages the manual from->to jump bypassed (same as a
    // real cycle). Resolved once per unique filter.
    const stagesByFilter = new Map<string, string[]>();
    await Promise.all(filterIds.map(async (fid) => {
      try { const r = await getFilterStageRules(fid); stagesByFilter.set(fid, r.orderedStages ?? []); }
      catch { stagesByFilter.set(fid, []); }
    }));

    const enriched = data.map((e) => {
      const u = e.performedBy ? umap.get(e.performedBy) : null;
      return {
        ...e,
        filterName: fmap.get(e.filterId) ?? null,
        // Show the user ID (login/employee username) as the performer, not the
        // full name (per 2026-06-10 request — username is the unique identifier
        // of record). performedByUsername kept for back-compat consumers.
        performedByName: u?.username ?? null,
        performedByUsername: u?.username ?? null,
        profileStages: stagesByFilter.get(e.filterId) ?? [],
      };
    });
    return { data: enriched, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Unified Filter Cleaning Record: cleaning cycles + manual status updates in a
   * single date-sorted, paginated list (each row tagged `_kind: 'cycle' | 'manual'`).
   * A status/reason filter applies only to cycles (manual edits have neither), so
   * the result is cycles-only in that case. Reuses getCycles / getManualStatusChanges
   * (via their `ids` mode) for enrichment of just the current page.
   */
  /**
   * Resolve the cleaning-record hierarchy/search filters into a set of FILTER
   * asset ids. Returns null when no scope filter is active (caller does not
   * constrain by filterId). Returns [] when a scope is active but matches no
   * filters (caller should short-circuit to an empty result).
   *
   * - block/area/ahu: the most-specific selected node, expanded to ALL of its
   *   descendant FILTER instances via a recursive walk (handles 2- or 3-level
   *   hierarchies — Block→Area→AHU→Filter or Block→AHU→Filter). Not restricted to
   *   active filters, so historical cycles of retired filters still appear.
   * - search: filter name contains (case-insensitive). Intersected with the
   *   hierarchy set when both are present.
   */
  async resolveScopeFilterIds(query: any): Promise<string[] | null> {
    const node: string | null = query.ahuId || query.areaId || query.blockId || null;
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (!node && !search) return null;

    let scopeIds: string[] | null = null;
    if (node) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE descendants AS (
          SELECT id, parent_id, template_id FROM asset_instances WHERE parent_id = ${node}::uuid
          UNION ALL
          SELECT ai.id, ai.parent_id, ai.template_id FROM asset_instances ai
          JOIN descendants d ON ai.parent_id = d.id
        )
        SELECT d.id::text AS id FROM descendants d
        JOIN asset_templates t ON t.id = d.template_id
        WHERE t.template_kind = 'FILTER'`;
      scopeIds = rows.map((r) => r.id);
    }
    if (search) {
      const like = `%${search}%`;
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT ai.id::text AS id FROM asset_instances ai
        JOIN asset_templates t ON t.id = ai.template_id
        WHERE t.template_kind = 'FILTER' AND ai.name ILIKE ${like}`;
      const nameIds = rows.map((r) => r.id);
      scopeIds = scopeIds === null ? nameIds : scopeIds.filter((id) => nameIds.includes(id));
    }
    return scopeIds ?? [];
  }

  async getCleaningRecord(ctx: RequestContext, query: any) {
    if (query.filterId) await getFilter(query.filterId, ctx);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const fromD = query.from ? new Date(query.from) : null;
    const toD = query.to ? new Date(query.to) : null;

    // Hierarchy/search scope → set of descendant FILTER ids (null = no scope).
    // Folds block/area/ahu + name search into ONE filterId constraint applied to
    // BOTH cycles and manual rows. A single `filterId` (specific-filter dropdown) wins.
    const scopeFilterIds = await this.resolveScopeFilterIds(query);
    if (scopeFilterIds !== null && scopeFilterIds.length === 0) {
      return { data: [], total: 0, page, limit, totalPages: 0 };
    }
    const filterIdConstraint: any = query.filterId
      ? query.filterId
      : (scopeFilterIds !== null ? { in: scopeFilterIds } : undefined);

    if (query.status || query.cleaningReasonKey) {
      // Hierarchy scope (block/area/ahu) is already folded into scopeFilterIds,
      // applied below as the filterIds constraint — getCycles filters on filterId.
      // includeEvents: the cleaning-record table renders per-stage timestamps
      // from each cycle's events (getStageInfo). The "All" path already requests
      // events (line ~287); this status/reason-filtered branch must too, or every
      // stage cell falls through to "Pending" even for COMPLETED cycles.
      const r = await this.getCycles(ctx, { ...query, filterIds: scopeFilterIds ?? undefined, includeEvents: 'true' });
      return { ...r, data: r.data.map((c: any) => ({ ...c, _kind: 'cycle' })) };
    }

    const cycleWhere: any = {};
    if (filterIdConstraint) cycleWhere.filterId = filterIdConstraint;
    if (fromD || toD) { cycleWhere.startedAt = {}; if (fromD) cycleWhere.startedAt.gte = fromD; if (toD) cycleWhere.startedAt.lte = toD; }

    const manualWhere: any = { eventType: 'STATE_TRANSITION', cycleId: null, attributes: { path: ['manual'], equals: true } };
    if (filterIdConstraint) manualWhere.filterId = filterIdConstraint;
    if (fromD || toD) { manualWhere.performedAt = {}; if (fromD) manualWhere.performedAt.gte = fromD; if (toD) manualWhere.performedAt.lte = toD; }

    const CAP = 5000; // safety cap on the lightweight merge index
    const [cyclesLite, manualLite] = await Promise.all([
      prisma.cleaningCycle.findMany({ where: cycleWhere, select: { id: true, startedAt: true }, orderBy: { startedAt: 'desc' }, take: CAP }),
      prisma.filterEvent.findMany({ where: manualWhere, select: { id: true, performedAt: true }, orderBy: { performedAt: 'desc' }, take: CAP }),
    ]);
    const merged = [
      ...cyclesLite.map((c) => ({ id: c.id, kind: 'cycle' as const, date: c.startedAt ? new Date(c.startedAt).getTime() : 0 })),
      ...manualLite.map((m) => ({ id: m.id, kind: 'manual' as const, date: m.performedAt ? new Date(m.performedAt).getTime() : 0 })),
    ].sort((a, b) => b.date - a.date);

    const total = merged.length;
    const pageSlice = merged.slice((page - 1) * limit, page * limit);
    const cycleIds = pageSlice.filter((r) => r.kind === 'cycle').map((r) => r.id);
    const manualIds = pageSlice.filter((r) => r.kind === 'manual').map((r) => r.id);

    const [cyclesRes, manualRes] = await Promise.all([
      cycleIds.length ? this.getCycles(ctx, { ids: cycleIds, includeEvents: 'true' }) : Promise.resolve({ data: [] as any[] }),
      manualIds.length ? this.getManualStatusChanges(ctx, { ids: manualIds }) : Promise.resolve({ data: [] as any[] }),
    ]);
    const cycleById = new Map((cyclesRes.data as any[]).map((c) => [c.id, c]));
    const manualById = new Map((manualRes.data as any[]).map((m) => [m.id, m]));

    const data = pageSlice
      .map((r) => {
        const row = r.kind === 'cycle' ? cycleById.get(r.id) : manualById.get(r.id);
        return row ? { ...row, _kind: r.kind } : null;
      })
      .filter(Boolean);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getDashboardStats(_ctx: RequestContext) {
    // May 16 H20 fix (2026-05-20): 7 independent queries now run in parallel
    // via Promise.all instead of sequentially. Dashboard load drops from
    // ~7× single-query time to ~1× (limited by the slowest of the seven).
    // Each query is independent — no shared state, no ordering dependency.
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const twelveMonthsAgo = new Date(); twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const startOfToday = new Date(new Date().toISOString().slice(0, 10));

    const [
      stageCountsRaw, statusCountsRaw, dailyRaw, monthlyRaw, totalFilters, activeCycles, completedToday,
      // 2026-06-11: extra filter analytics for the dashboard.
      filterSetRaw, filterStatusRaw, reasonsRaw, deviations30, completed30, avgDurRaw, typeRaw, micronRaw,
    ] = await Promise.all([
        prisma.filterDetails.groupBy({
          by: ['currentLifecycleState'],
          where: { currentLifecycleState: { not: null }, assetInstance: { isActive: true } },
          _count: true,
        }),
        prisma.cleaningCycle.groupBy({ by: ['status'], _count: true }),
        prisma.$queryRawUnsafe<any[]>(`
          SELECT DATE(started_at) as day, COUNT(*)::int as count
          FROM cleaning_cycles
          WHERE started_at >= $1
          GROUP BY DATE(started_at) ORDER BY day
        `, thirtyDaysAgo),
        prisma.$queryRawUnsafe<any[]>(`
          SELECT TO_CHAR(started_at, 'YYYY-MM') as month, COUNT(*)::int as count
          FROM cleaning_cycles
          WHERE started_at >= $1
          GROUP BY TO_CHAR(started_at, 'YYYY-MM') ORDER BY month
        `, twelveMonthsAgo),
        prisma.assetInstance.count({
          where: { isActive: true, template: { templateKind: 'FILTER' } },
        }),
        prisma.cleaningCycle.count({ where: { status: 'IN_PROGRESS' } }),
        prisma.cleaningCycle.count({
          where: { status: 'COMPLETED', completedAt: { gte: startOfToday } },
        }),
        // Filters by Set (A / B / unset)
        prisma.filterDetails.groupBy({
          by: ['filterSet'], where: { assetInstance: { isActive: true } }, _count: true,
        }),
        // Filters by lifecycle status (Active / Retired / Replaced)
        prisma.assetInstance.groupBy({
          by: ['status'], where: { isActive: true, template: { templateKind: 'FILTER' } }, _count: true,
        }),
        // Top cleaning reasons (all-time)
        prisma.$queryRawUnsafe<any[]>(`
          SELECT cleaning_reason_label as label, COUNT(*)::int as count
          FROM cleaning_cycles
          WHERE COALESCE(cleaning_reason_label, '') <> ''
          GROUP BY cleaning_reason_label ORDER BY count DESC LIMIT 8
        `),
        // Deviations (bypassed stages) in the last 30 days
        prisma.filterEvent.count({ where: { eventType: 'BYPASS_DEVIATION', performedAt: { gte: thirtyDaysAgo } } }),
        // Cycles completed in the last 30 days
        prisma.cleaningCycle.count({ where: { status: 'COMPLETED', completedAt: { gte: thirtyDaysAgo } } }),
        // Average completed-cycle duration (hours)
        prisma.$queryRawUnsafe<any[]>(`
          SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 3600.0), 0)::float as hours
          FROM cleaning_cycles
          WHERE status = 'COMPLETED' AND completed_at IS NOT NULL AND started_at IS NOT NULL
        `),
        // Filters by Filter Type
        prisma.$queryRawUnsafe<any[]>(`
          SELECT ai.attributes->>'filterType' as label, COUNT(*)::int as count
          FROM asset_instances ai JOIN asset_templates at ON at.id = ai.template_id
          WHERE ai.is_active = true AND at.template_kind = 'FILTER' AND COALESCE(ai.attributes->>'filterType', '') <> ''
          GROUP BY 1 ORDER BY count DESC LIMIT 8
        `),
        // Filters by Micron Size
        prisma.$queryRawUnsafe<any[]>(`
          SELECT ai.attributes->>'micronSize' as label, COUNT(*)::int as count
          FROM asset_instances ai JOIN asset_templates at ON at.id = ai.template_id
          WHERE ai.is_active = true AND at.template_kind = 'FILTER' AND COALESCE(ai.attributes->>'micronSize', '') <> ''
          GROUP BY 1 ORDER BY count DESC LIMIT 8
        `),
      ]);

    const stageCounts: Record<string, number> = {};
    for (const row of stageCountsRaw) {
      if (row.currentLifecycleState) stageCounts[row.currentLifecycleState] = row._count;
    }
    const statusCounts: Record<string, number> = {};
    for (const row of statusCountsRaw) statusCounts[row.status] = row._count;
    const dailyCycles = dailyRaw.map((r: any) => ({ day: r.day, count: r.count }));
    const monthlyCycles = monthlyRaw.map((r: any) => ({ month: r.month, count: r.count }));

    // New breakdowns
    const filterSetCounts: Record<string, number> = {};
    for (const row of filterSetRaw) filterSetCounts[row.filterSet ?? 'UNSET'] = (row as any)._count;
    const filterStatusCounts: Record<string, number> = {};
    for (const row of filterStatusRaw) filterStatusCounts[row.status ?? 'Unknown'] = (row as any)._count;
    const cleaningReasons = reasonsRaw.map((r: any) => ({ label: r.label, count: r.count }));
    const filterTypeCounts = typeRaw.map((r: any) => ({ label: r.label, count: r.count }));
    const micronCounts = micronRaw.map((r: any) => ({ label: r.label, count: r.count }));
    const avgCycleHours = Math.round(((avgDurRaw?.[0]?.hours ?? 0) as number) * 10) / 10;

    return {
      stageCounts, statusCounts, dailyCycles, monthlyCycles, totalFilters, activeCycles, completedToday,
      filterSetCounts, filterStatusCounts, cleaningReasons, filterTypeCounts, micronCounts,
      deviations30, completed30, avgCycleHours,
    };
  }

  /** @param query - Validated by Fastify JSON schema before reaching this method */
  async getCycles(ctx: RequestContext, query: any) {
    // Verify filterId belongs to user's org if provided
    if (query.filterId) {
      await getFilter(query.filterId, ctx);
    }

    // `ids` fetch mode (used by getCleaningRecord): return exactly these cycle
    // rows, enriched, without pagination — caller has already paged the merged set.
    const ids: string[] | undefined = Array.isArray(query.ids) ? query.ids : undefined;
    const page = ids ? 1 : (query.page ?? 1);
    const limit = ids ? Math.max(ids.length, 1) : Math.min(query.limit ?? 20, 100);
    const where: any = {};
    if (ids) where.id = { in: ids };
    if (query.filterId) where.filterId = query.filterId;
    else if (Array.isArray(query.filterIds)) where.filterId = { in: query.filterIds };
    // Effective-status mapping: RETIRED/REPLACED are TERMINATED cycles carrying a
    // terminationReason of that value; plain TERMINATED excludes those (the pills
    // are separate). SQL NOT IN drops NULL rows, so OR-in the null/free-text
    // terminationReasons explicitly.
    if (query.status === 'RETIRED') { where.status = 'TERMINATED'; where.terminationReason = 'RETIRED'; }
    else if (query.status === 'REPLACED') { where.status = 'TERMINATED'; where.terminationReason = 'REPLACED'; }
    else if (query.status === 'TERMINATED') {
      where.status = 'TERMINATED';
      where.OR = [{ terminationReason: null }, { terminationReason: { notIn: ['RETIRED', 'REPLACED'] } }];
    }
    else if (query.status) { where.status = query.status; }
    if (query.cleaningReasonKey) where.cleaningReasonKey = query.cleaningReasonKey;
    if (query.from || query.to) {
      where.startedAt = {};
      if (query.from) where.startedAt.gte = new Date(query.from);
      if (query.to) where.startedAt.lte = new Date(query.to);
    }

    const includeEvents = query.includeEvents === 'true' || query.includeEvents === true;
    const [data, total] = await Promise.all([
      prisma.cleaningCycle.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { startedAt: 'desc' },
        ...(includeEvents ? { include: { events: { orderBy: { performedAt: 'asc' as const } } } } : {}),
      }),
      prisma.cleaningCycle.count({ where }),
    ]);

    // Enrich with filter + cleaning area names in a single query
    const allAssetIds = [...new Set([
      ...data.map((c: any) => c.filterId),
      ...data.map((c: any) => c.cleaningAreaId).filter(Boolean) as string[],
    ])];

    // filterSet moved to FilterDetails (Step 6) — include + flatten via the helper.
    const allAssetsRaw = allAssetIds.length > 0 ? await prisma.assetInstance.findMany({
      where: { id: { in: allAssetIds } },
      select: { id: true, name: true, filterDetails: { select: { filterSet: true } } },
    }) : [];
    const allAssets = allAssetsRaw.map(a => ({ id: a.id, name: a.name, filterSet: a.filterDetails?.filterSet ?? null }));
    const assetMap = new Map(allAssets.map(a => [a.id, a]));

    // Resolve each cycle's terminal-event performer (CYCLE_COMPLETED /
    // CYCLE_TERMINATED) so the lifecycle report can show "completed by whom"
    // without having to include every event in the payload.
    const cycleIds = data.map((c: any) => c.id);
    const terminalEvents = cycleIds.length > 0 ? await prisma.filterEvent.findMany({
      where: { cycleId: { in: cycleIds }, eventType: { in: ['CYCLE_COMPLETED', 'CYCLE_TERMINATED'] } },
      select: { cycleId: true, performedBy: true, performedAt: true },
      orderBy: { performedAt: 'asc' },
    }) : [];
    const terminalPerformerByCycle = new Map<string, string>();
    for (const ev of terminalEvents) {
      if (ev.cycleId && ev.performedBy) terminalPerformerByCycle.set(ev.cycleId, ev.performedBy); // last terminal wins
    }

    // Resolve performedBy UUIDs to user display names (event performers when
    // includeEvents, plus every cycle's terminal-event performer).
    const allPerformerIds = [...new Set([
      ...data.flatMap((c: any) => (c.events ?? []).map((e: any) => e.performedBy).filter(Boolean)),
      ...terminalPerformerByCycle.values(),
    ])] as string[];
    const performers = allPerformerIds.length > 0 ? await prisma.user.findMany({
      where: { id: { in: allPerformerIds } },
      select: { id: true, username: true, fullName: true },
    }) : [];
    // 2026-05-21: expose both fullName and username so the FE can choose which
    // to render. Mobile cycle view uses the username (operator login id) per
    // operator request; desktop continues to show fullName.
    const userMap = new Map(performers.map(u => [u.id, { fullName: u.fullName || u.username, username: u.username }]));

    // P2 (2026-06-03): resolve each cycle's profile stage set so the Cleaning
    // Cycles view can show "NA" for stages the profile doesn't configure (vs "-"
    // for an in-profile stage not yet reached). Batched by distinct profileId.
    const distinctProfileIds = [...new Set(data.map((c: any) => c.profileId).filter(Boolean))] as string[];
    const profileStageMap = new Map<string, string[]>();
    await Promise.all(distinctProfileIds.map(async (pid) => {
      profileStageMap.set(pid, await getProfileOrderedStages(pid));
    }));

    const enriched = data.map(c => ({
      ...c,
      filterName: assetMap.get(c.filterId)?.name ?? null,
      filterSet: assetMap.get(c.filterId)?.filterSet ?? null,
      cleaningAreaName: c.cleaningAreaId ? (assetMap.get(c.cleaningAreaId)?.name ?? null) : null,
      profileStages: c.profileId ? (profileStageMap.get(c.profileId) ?? []) : [],
      // Who closed the cycle (fullName for desktop, username for mobile). Null
      // for still-IN_PROGRESS cycles (no terminal event yet).
      completedByName: (() => { const p = terminalPerformerByCycle.get(c.id); return p ? (userMap.get(p)?.fullName ?? null) : null; })(),
      completedByUsername: (() => { const p = terminalPerformerByCycle.get(c.id); return p ? (userMap.get(p)?.username ?? null) : null; })(),
      ...((c as any).events ? {
        events: (c as any).events.map((e: any) => {
          const u = e.performedBy ? userMap.get(e.performedBy) : null;
          return {
            ...e,
            performedByName: u?.username ?? null,
            performedByUsername: u?.username ?? null,
          };
        }),
      } : {}),
    }));

    return { data: enriched, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getCycleById(ctx: RequestContext, id: string) {
    const cycle = await prisma.cleaningCycle.findUnique({
      where: { id },
      include: { events: { orderBy: { performedAt: 'asc' } } },
    });
    if (!cycle) throw new AppError(404, 'NOT_FOUND', 'Cleaning cycle not found');

    // Verify the cycle's filter belongs to user's org
    if (cycle.filterId) {
      await getFilter(cycle.filterId, ctx);
    }

    // Enrich with filter name and AHU (parent) name (filterSet on FilterDetails — Step 6).
    const filterRaw = await prisma.assetInstance.findUnique({
      where: { id: cycle.filterId },
      select: { id: true, name: true, parentId: true, filterDetails: { select: { filterSet: true } } },
    });
    const filter = filterRaw ? { id: filterRaw.id, name: filterRaw.name, parentId: filterRaw.parentId, filterSet: filterRaw.filterDetails?.filterSet ?? null } : null;
    const ahu = filter?.parentId ? await prisma.assetInstance.findUnique({
      where: { id: filter.parentId },
      select: { name: true },
    }) : null;

    // Resolve performedBy UUIDs to user names
    // 2026-05-21: also expose username (operator login id) — mobile cycle view
    // renders that instead of fullName per operator request.
    const performerIds = [...new Set(cycle.events.map(e => e.performedBy).filter(Boolean) as string[])];
    const users = performerIds.length > 0 ? await prisma.user.findMany({
      where: { id: { in: performerIds } },
      select: { id: true, username: true, fullName: true },
    }) : [];
    const userMap = Object.fromEntries(users.map(u => [u.id, { fullName: u.fullName || u.username, username: u.username }]));

    // Resolve checklist question IDs to question text.
    // Phase A.1: prefer the per-event questionsSnapshot (frozen at submit time)
    // when present; fall back to ChecklistProfileVersion lookup via the cycle's
    // pinned versions; last resort fall back to live ChecklistQuestion (for
    // legacy events written before snapshots existed).
    const questionMap = new Map<string, string>();
    const cyclePins = (cycle.checklistVersionPins ?? null) as Record<string, number> | null;

    // First pass: harvest text from per-event snapshots.
    for (const e of cycle.events) {
      if (e.eventType !== 'CHECKLIST_COMPLETED') continue;
      const attrs = (e.attributes as any) ?? {};
      const checklists = Array.isArray(attrs.checklists) ? attrs.checklists : null;
      if (checklists) {
        for (const cl of checklists) {
          for (const q of (cl.questionsSnapshot ?? [])) {
            if (q?.id && q?.question) questionMap.set(q.id, q.question);
          }
        }
      }
    }

    // Second pass: anything still unresolved, try the ChecklistProfileVersion
    // table via the cycle's pinned versions.
    const allAnswerKeys = cycle.events
      .filter(e => e.eventType === 'CHECKLIST_COMPLETED' && (e.attributes as any)?.answers)
      .flatMap(e => Object.keys((e.attributes as any).answers));
    const unresolvedQuestionIds = [...new Set(allAnswerKeys)].filter(qId => !questionMap.has(qId));
    if (unresolvedQuestionIds.length > 0 && cyclePins && Object.keys(cyclePins).length > 0) {
      const versionRows = await prisma.checklistProfileVersion.findMany({
        where: { OR: Object.entries(cyclePins).map(([profileId, versionNumber]) => ({ profileId, versionNumber })) },
      });
      for (const v of versionRows) {
        const snap = (v.snapshot as any) ?? {};
        for (const q of (snap.questions ?? [])) {
          if (q?.id && q?.question) questionMap.set(q.id, q.question);
        }
      }
    }

    // Third pass: live fallback for fully-legacy cycles.
    const stillUnresolved = [...new Set(allAnswerKeys)].filter(qId => !questionMap.has(qId));
    if (stillUnresolved.length > 0) {
      const liveQs = await prisma.checklistQuestion.findMany({
        where: { id: { in: stillUnresolved } },
        select: { id: true, question: true },
      });
      for (const q of liveQs) questionMap.set(q.id, q.question);
    }

    const enrichedEvents = cycle.events.map(e => {
      const u = e.performedBy ? userMap[e.performedBy] : null;
      const enriched: any = {
        ...e,
        // Show the user ID (login/employee username) as the performer, not the
        // full name (per 2026-06-10 request — username is the unique identifier
        // of record). performedByUsername kept for back-compat consumers.
        performedByName: u?.username ?? null,
        performedByUsername: u?.username ?? null,
      };
      if (e.eventType === 'CHECKLIST_COMPLETED' && (e.attributes as any)?.answers) {
        const answers = (e.attributes as any).answers;
        enriched.enrichedAnswers = Object.entries(answers).map(([qId, answer]) => ({
          questionId: qId,
          question: questionMap.get(qId) ?? qId,
          answer,
        }));
      }
      return enriched;
    });

    // Resolve cleaning area name
    const area = cycle.cleaningAreaId ? await prisma.assetInstance.findUnique({
      where: { id: cycle.cleaningAreaId },
      select: { name: true },
    }) : null;

    // Ordered stage set of this cycle's profile, so the detail view can render
    // stages NOT in the profile as "NA" (matches the Cleaning Record list).
    const profileStages = cycle.profileId ? await getProfileOrderedStages(cycle.profileId) : [];

    return {
      ...cycle,
      events: enrichedEvents,
      filterName: filter?.name ?? null,
      filterSet: filter?.filterSet ?? null,
      ahuName: ahu?.name ?? null,
      cleaningAreaName: area?.name ?? null,
      profileStages,
    };
  }

  async terminateCycle(ctx: RequestContext, filterId: string, data: { justification: string; clientOpId?: string; tapeVersion?: number }) {
    return terminateCycleImpl(this, ctx, filterId, data);
  }

  /**
   * Retire a filter — sets status to Retired, terminates active cycle, creates audit log.
   */
  async retire(ctx: RequestContext, filterId: string, remarks: string, terminationReason: string = 'RETIRED') {
    const filter = await getFilter(filterId, ctx);

    // Already retired?
    if (filter.currentLifecycleState === 'RETIRED') {
      throw new AppError(400, 'ALREADY_RETIRED', 'Filter is already retired');
    }

    // Retire the filter, terminate cycle, and remove from tree — all in one transaction
    await prisma.$transaction(async (tx) => {
      // Terminate active cycle if any. Stamp WHY (RETIRED / REPLACED — replace()
      // calls this with 'REPLACED') so the cleaning + lifecycle reports can show
      // the cycle as Retired/Replaced instead of a generic Terminated.
      if (filter.currentCycleId) {
        await tx.cleaningCycle.updateMany({
          where: { id: filter.currentCycleId, status: 'IN_PROGRESS' },
          data: { status: 'TERMINATED', completedAt: new Date(), terminatedAt: new Date(), terminationReason },
        });
      }

      // Save original parentId in customAttributes so unretire can restore it.
      // currentLifecycleState + currentCycleId moved to FilterDetails (Step 6).
      const existingCustom = (filter as any).customAttributes ?? {};
      await tx.assetInstance.update({
        where: { id: filterId },
        data: {
          status: 'Retired',
          isActive: false,
          parentId: null,
          customAttributes: { ...existingCustom, _preRetireParentId: filter.parentId },
        },
      });
      await tx.filterDetails.upsert({
        where: { assetInstanceId: filterId },
        update: { currentLifecycleState: 'RETIRED', currentCycleId: null },
        create: { assetInstanceId: filterId, currentLifecycleState: 'RETIRED', currentCycleId: null },
      });

      // Remove all relationships (CONTAINS/CONTAINED_IN) so retired filter disappears from tree
      await tx.assetRelationship.deleteMany({
        where: { OR: [{ sourceAssetId: filterId }, { targetAssetId: filterId }] },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FILTER_RETIRED',
      targetType: 'filter', targetId: filterId,
      afterValue: { remarks, filterName: filter.name },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true };
  }

  /**
   * Replace a filter — retires old filter, creates new one with incremented suffix.
   */
  async replace(ctx: RequestContext, filterId: string, remarks: string) {
    const instance = await prisma.assetInstance.findFirst({
      where: { id: filterId },
    });
    if (!instance) throw new AppError(404, 'NOT_FOUND', 'Filter not found');

    // Calculate new name: increment suffix
    const oldName = instance.name;
    const match = oldName.match(/-(\d+)$/);
    let newName: string;
    if (match) {
      const num = parseInt(match[1]) + 1;
      newName = oldName.replace(/-\d+$/, '-' + String(num).padStart(2, '0'));
    } else {
      newName = oldName + '-01';
    }

    // Guard (2026-07-08): refuse the replacement when the computed new name is
    // already used by another ACTIVE filter. replace() blindly increments the
    // trailing suffix, so replacing "…/00-00" produces "…/00-01" — which collides
    // when "…/00-01" already exists as its own filter, silently creating two
    // filters with the same name. Per user decision: on collision, do NOT replace.
    // This runs BEFORE retire() so nothing is mutated when we abort. Retired
    // filters keep their names by design, so we only check active FILTER instances.
    const nameClash = await prisma.assetInstance.findFirst({
      where: { name: newName, isActive: true, template: { templateKind: 'FILTER' } },
      select: { id: true },
    });
    if (nameClash) {
      throw new AppError(
        409,
        'DUPLICATE_FILTER_NAME',
        `Cannot replace "${oldName}": a filter named "${newName}" already exists. Rename or retire that filter first.`,
      );
    }

    // Snapshot the old filter's FilterDetails BEFORE retire() clears them.
    // We need filterSet + filterProfileId to copy onto the replacement.
    const oldDetails = await prisma.filterDetails.findUnique({
      where: { assetInstanceId: filterId },
      select: { filterSet: true, filterProfileId: true },
    });

    // Retire old filter first — mark its terminated cycle (if any) as REPLACED
    // (not just RETIRED) so reports distinguish a replacement from a retirement.
    await this.retire(ctx, filterId, remarks, 'REPLACED');

    // Create replacement filter + relationships in a transaction (rollback on failure).
    // FilterDetails (filterSet, filterProfileId) live in the sidecar (Step 6).
    let newFilter: any;
    let movedTagCount = 0;
    try {
      newFilter = await prisma.$transaction(async (tx) => {
        const created = await tx.assetInstance.create({
          data: {
            name: newName,
            templateId: instance.templateId,
            templateVersion: instance.templateVersion,
            parentId: instance.parentId,
            attributes: instance.attributes ?? {},
            status: 'Active',
            isActive: true,
            createdBy: ctx.userId ?? ctx.userSub,
          },
        });

        // Eager FilterDetails for the new filter, copying old filterSet + filterProfileId.
        await tx.filterDetails.create({
          data: {
            assetInstanceId: created.id,
            filterSet: oldDetails?.filterSet ?? null,
            filterProfileId: oldDetails?.filterProfileId ?? null,
          },
        });

        // Create relationships with parent (same as old filter)
        if (instance.parentId) {
          await tx.assetRelationship.create({
            data: {
              sourceAssetId: instance.parentId,
              targetAssetId: created.id,
              relationshipType: 'CONTAINS',
              createdBy: ctx.userId ?? ctx.userSub,
            },
          });
          await tx.assetRelationship.create({
            data: {
              sourceAssetId: created.id,
              targetAssetId: instance.parentId,
              relationshipType: 'CONTAINED_IN',
              createdBy: ctx.userId ?? ctx.userSub,
            },
          });
        }

        // Carry the physical tag(s) over to the replacement filter. A swapped
        // filter keeps the SAME RFID/QR tag — only the filter ID changes. Since
        // identifier_value is globally unique we MOVE the rows (re-point assetId)
        // rather than copy. retire() above never touches identifiers, so they're
        // still attached to the old filter at this point and re-point cleanly.
        const moved = await tx.assetIdentifier.updateMany({
          where: { assetId: filterId },
          data: { assetId: created.id, updatedBy: ctx.userId ?? ctx.userSub ?? null },
        });
        movedTagCount = moved.count;

        return created;
      });
    } catch (err) {
      // Re-activate the retired filter if replacement creation fails
      // (currentLifecycleState moved to FilterDetails — Step 6).
      await prisma.assetInstance.update({
        where: { id: filterId },
        data: { status: 'Active', isActive: true },
      });
      await prisma.filterDetails.update({
        where: { assetInstanceId: filterId },
        data: { currentLifecycleState: null },
      });
      throw err;
    }

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FILTER_REPLACED',
      targetType: 'filter', targetId: filterId,
      afterValue: {
        oldFilterId: filterId,
        oldFilterName: oldName,
        newFilterId: newFilter.id,
        newFilterName: newName,
        identifiersMoved: movedTagCount,
        remarks,
      },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return {
      success: true,
      oldFilterId: filterId,
      newFilterId: newFilter.id,
      newFilterName: newName,
      identifiersMoved: movedTagCount,
    };
  }

  /**
   * Get all retired filters.
   */
  async getRetirements(_ctx: RequestContext) {
    // filterSet moved to FilterDetails (Step 6) — include + flatten.
    const retirementsRaw = await prisma.assetInstance.findMany({
      where: { status: 'Retired', isActive: false },
      select: {
        id: true, name: true, updatedAt: true, attributes: true,
        parentId: true, customAttributes: true,
        filterDetails: { select: { filterSet: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5000, // defensive cap — preserves the array contract, bounds memory (audit perf)
    });
    const retirements = retirementsRaw.map((r: any) => ({
      ...r,
      filterSet: r.filterDetails?.filterSet ?? null,
    }));

    // Resolve original parent names for display
    const parentIds = retirements
      .map((r: any) => (r.customAttributes as any)?._preRetireParentId)
      .filter(Boolean) as string[];
    const parents = parentIds.length > 0
      ? await prisma.assetInstance.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true } })
      : [];
    const parentMap = new Map(parents.map(p => [p.id, p.name]));

    // Retirement remarks + performer live in the FILTER_RETIRED audit (the asset
    // row doesn't store them). Join the latest FILTER_RETIRED record per filter.
    const retiredIds = retirements.map((r: any) => r.id);
    const retireAudits = retiredIds.length > 0
      ? await prisma.auditTrail.findMany({
          where: { action: 'FILTER_RETIRED', targetId: { in: retiredIds } },
          select: { targetId: true, afterValue: true, timestamp: true, userName: true, userId: true },
          orderBy: { timestamp: 'desc' },
        })
      : [];
    const retireByFilter = new Map<string, { remarks: string | null; retiredBy: string | null; retiredAt: Date }>();
    for (const a of retireAudits) {
      if (!a.targetId || retireByFilter.has(a.targetId)) continue; // desc order → first seen is the most recent
      const v = (a.afterValue as any) ?? {};
      retireByFilter.set(a.targetId, {
        remarks: v.remarks ?? null,
        retiredBy: a.userName ?? a.userId ?? null,
        retiredAt: a.timestamp,
      });
    }

    return retirements.map((r: any) => {
      const preRetireParentId = (r.customAttributes as any)?._preRetireParentId ?? null;
      const audit = retireByFilter.get(r.id);
      return {
        id: r.id, name: r.name, updatedAt: r.updatedAt,
        attributes: r.attributes, filterSet: r.filterSet, parentId: r.parentId,
        preRetireParentId,
        preRetireParentName: preRetireParentId ? parentMap.get(preRetireParentId) ?? null : null,
        remarks: audit?.remarks ?? null,
        retiredBy: audit?.retiredBy ?? null,
        retiredAt: audit?.retiredAt ?? r.updatedAt,
      };
    });
  }

  /**
   * Get replacement history from audit trail.
   *
   * Visibility rule (matches `/api/audit` intent but corrects the
   * SUPER_ADMIN-hides-from-self bug):
   *   - SUPER_ADMIN viewer → sees ALL replacements including their own.
   *     (No row to hide from the highest privilege.)
   *   - Lower roles → SUPER_ADMIN-performed replacements hidden, mirroring
   *     the audit-trail leak-prevention policy (audit/routes.ts:73, :200).
   *
   * Bug history: until 2026-05-16 this endpoint applied the SUPER_ADMIN
   * exclusion unconditionally, which made every SUPER_ADMIN replacement
   * invisible to SUPER_ADMIN viewers themselves — the most common operator
   * since `superadmin` is the default login.
   */
  async getReplacements(ctx: RequestContext) {
    const isSuperAdmin = ctx.userRole === 'SUPER_ADMIN';
    const records = await prisma.auditTrail.findMany({
      where: {
        action: 'FILTER_REPLACED',
        ...(isSuperAdmin
          ? {}
          : { OR: [{ userRole: { not: 'SUPER_ADMIN' } }, { userRole: null }] }),
      },
      select: { id: true, userId: true, userName: true, timestamp: true, afterValue: true },
      orderBy: { timestamp: 'desc' },
      take: 5000, // defensive cap — preserves the array contract, bounds memory (audit perf)
    });

    const mapped = records.map(r => {
      const val = r.afterValue as any ?? {};
      return {
        id: r.id,
        oldFilterId: val.oldFilterId ?? null,
        oldFilterName: val.oldFilterName ?? null,
        newFilterId: val.newFilterId ?? null,
        newFilterName: val.newFilterName ?? null,
        remarks: val.remarks ?? null,
        replacedAt: r.timestamp,
        performedBy: r.userName ?? r.userId,
      };
    });

    return mapped;
  }

  async getCleaningReasons(profileId?: string) {
    return getCleaningReasons(profileId);
  }
}
