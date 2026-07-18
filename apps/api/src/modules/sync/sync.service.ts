/**
 * Sync Service — Phase 8.4b (Option D, 2026-05-02).
 *
 * Single endpoint that returns all rows newer than the client's per-entity
 * version cursors. Drives the FE's versioned local cache (IDB v5+) so
 * mobile / desktop offline-capable pages can render without server contact
 * once seeded.
 *
 * Entities covered (all carry monotonic `version` columns except Filters,
 * which use an `updatedAt` watermark):
 *   - FilterCleaningProfile (Phase A.2 lineage versioning; this query reads
 *     the LIVE row only — historical lineage versions are exposed via the
 *     dedicated `/api/filter-cleaning-profiles/:id/versions` endpoint)
 *   - FilterProfile (Phase A.3)
 *   - EquipmentGroup (Phase A.4)
 *   - ChecklistProfile (Phase A.1 snapshot-then-bump on every mutation of
 *     profile or its questions). Hydrated 2026-05-03 (8.4b follow-up): the
 *     8.4a regression gate against per-write bumps now passes (`f63207c`),
 *     so cache consumers receive `questions` inlined to match the legacy
 *     `/api/checklist-profiles?expand=questions` shape — without it the
 *     offline checklist dialog would open empty.
 *   - AssetTemplate (`version` bumped by template.service.ts on every
 *     update). Hydrated 2026-05-03 (8.4b follow-up). Returned verbatim so
 *     the FE caches the full template definition (attributeSchema,
 *     telemetrySchema, statusLifecycle, etc.) — same shape as
 *     `/api/assets/templates`.
 *   - Filters (AssetInstance + FilterDetails sidecar) — uses `updatedAt`
 *     watermark instead of a monotonic counter (no version column)
 *
 * Pagination: each entity is capped at LIMIT rows. If any entity hits the
 * cap, the response sets `hasMore: true` and the FE retries with updated
 * version cursors after consuming.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';

/** Max rows per entity per request. FE retries when any entity returns LIMIT. */
export const SYNC_PAGE_LIMIT = 500;

export interface SyncSinceQuery {
  profileVersion?: number;
  filterProfileVersion?: number;
  equipmentGroupVersion?: number;
  checklistVersion?: number;
  assetTemplateVersion?: number;
  /** ISO-8601 timestamp; null/undefined = full sync. */
  filterUpdatedSince?: string;
}

export interface SyncSinceResponse {
  filterCleaningProfiles: any[];
  filterProfiles: any[];
  equipmentGroups: any[];
  checklistProfiles: any[];
  assetTemplates: any[];
  filters: any[];
  serverTimestamp: string;
  hasMore: boolean;
}

export class SyncService {
  /**
   * Fetch rows changed since the client's per-entity cursors. Each entity
   * query is independent — Promise.all so a slow query doesn't serialize the
   * others. `_ctx` is unused today (single-tenant); kept for signature
   * symmetry with other services and forward compatibility.
   */
  async since(_ctx: RequestContext, q: SyncSinceQuery): Promise<SyncSinceResponse> {
    const profileVersion = q.profileVersion ?? 0;
    const filterProfileVersion = q.filterProfileVersion ?? 0;
    const equipmentGroupVersion = q.equipmentGroupVersion ?? 0;
    const checklistVersion = q.checklistVersion ?? 0;
    const assetTemplateVersion = q.assetTemplateVersion ?? 0;
    const filterUpdatedSince = q.filterUpdatedSince ? new Date(q.filterUpdatedSince) : null;
    // Validate the date — bad input falls back to "full sync" rather than 500.
    const filterCutoff = filterUpdatedSince && !isNaN(filterUpdatedSince.getTime())
      ? filterUpdatedSince
      : null;

    const [
      filterCleaningProfiles,
      filterProfiles,
      equipmentGroups,
      checklistProfiles,
      assetTemplates,
      filters,
    ] = await Promise.all([
      // FilterCleaningProfile: full row + stages + connections so the FE can
      // execute the pipeline locally without a follow-up GET /:id round trip.
      prisma.filterCleaningProfile.findMany({
        where: { version: { gt: profileVersion } },
        include: {
          stages: { orderBy: { sortOrder: 'asc' } },
          connections: true,
        },
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
        take: SYNC_PAGE_LIMIT,
      }),

      // FilterProfile: include the cleaning-profile id (already a column) +
      // applicableTemplates flattened so the wire shape matches existing
      // GET /api/filter-profiles responses (Step 4 join-table awareness).
      prisma.filterProfile.findMany({
        where: { version: { gt: filterProfileVersion } },
        include: {
          applicableTemplates: { select: { templateId: true } },
        },
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
        take: SYNC_PAGE_LIMIT,
      }).then(rows =>
        rows.map(r => ({
          ...r,
          applicableTemplates: r.applicableTemplates.map(t => t.templateId),
        }))
      ),

      // EquipmentGroup: include instruments composite (group + 3 instruments
      // is the unit of versioning per Phase A.4).
      prisma.equipmentGroup.findMany({
        where: { version: { gt: equipmentGroupVersion } },
        include: {
          instruments: { orderBy: { sortOrder: 'asc' } },
        },
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
        take: SYNC_PAGE_LIMIT,
      }),

      // ChecklistProfile: full row + questions inlined (matches the existing
      // GET /api/checklist-profiles?expand=questions wire shape so the offline
      // dialog opens with all questions populated). Phase A.1 bumps `version`
      // on every mutation of the profile or its questions, so the cursor on
      // the parent row is sufficient — children don't carry an independent
      // version column.
      prisma.checklistProfile.findMany({
        where: { version: { gt: checklistVersion } },
        include: {
          questions: { orderBy: { sortOrder: 'asc' } },
        },
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
        take: SYNC_PAGE_LIMIT,
      }),

      // AssetTemplate: full row passed through verbatim (attributeSchema /
      // telemetrySchema / statusLifecycle / checklistSchema +
      // ingestion config + versioning metadata). Mirrors the
      // /api/assets/templates list shape the FE already consumes for the
      // legacy `templates` cache. `version` is bumped by template.service.ts
      // on every update().
      prisma.assetTemplate.findMany({
        where: { version: { gt: assetTemplateVersion } },
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
        take: SYNC_PAGE_LIMIT,
      }),

      // Filters: AssetInstance rows whose template is FILTER-kind, joined with
      // FilterDetails (1:1 sidecar — Step 6) and parent chain flattened to
      // names matching the FE CachedFilter shape.
      // No version column on AssetInstance — uses updatedAt watermark.
      // Either the instance OR its FilterDetails sidecar can change without
      // bumping the other, so we union: any filter whose instance OR its
      // sidecar updatedAt is past the cutoff.
      this.fetchFilters(filterCutoff),
    ]);

    const hasMore =
      filterCleaningProfiles.length === SYNC_PAGE_LIMIT
      || filterProfiles.length === SYNC_PAGE_LIMIT
      || equipmentGroups.length === SYNC_PAGE_LIMIT
      || checklistProfiles.length === SYNC_PAGE_LIMIT
      || assetTemplates.length === SYNC_PAGE_LIMIT
      || filters.length === SYNC_PAGE_LIMIT;

    return {
      filterCleaningProfiles,
      filterProfiles,
      equipmentGroups,
      checklistProfiles,
      assetTemplates,
      filters,
      serverTimestamp: new Date().toISOString(),
      hasMore,
    };
  }

  /**
   * Fetch FILTER-kind AssetInstances changed since the watermark. Returns
   * flat objects matching the FE CachedFilter shape so existing offline
   * consumers don't need to learn a new contract.
   */
  private async fetchFilters(filterCutoff: Date | null): Promise<any[]> {
    const where: any = {
      template: { templateKind: 'FILTER' },
      isActive: true,
    };
    if (filterCutoff) {
      // Either the AssetInstance itself OR its FilterDetails sidecar updated
      // since the cutoff. Prisma OR on relation `is.updatedAt` works because
      // FilterDetails is 1:1.
      where.OR = [
        { updatedAt: { gt: filterCutoff } },
        { filterDetails: { is: { updatedAt: { gt: filterCutoff } } } },
      ];
    }

    const rows = await prisma.assetInstance.findMany({
      where,
      include: {
        template: { select: { id: true, name: true, templateKind: true } },
        filterDetails: true,
        parent: {
          // Filter -> AHU -> (Area?) -> Block. Fetch up to 3 ancestor levels.
          // The Area level is OPTIONAL: an AHU can be parented directly by a
          // Block (no Area). So the chain is either Filter→AHU→Area→Block OR
          // Filter→AHU→Block. We pull templateKind at every level and bucket
          // ancestors by kind below — a positional walk (area = ahu.parent)
          // mislabels the Block as the Area and leaves blockId null for any
          // filter under a direct-under-block AHU.
          select: {
            id: true, name: true, parentId: true,
            template: { select: { templateKind: true } },
            parent: {
              select: {
                id: true, name: true, parentId: true,
                template: { select: { templateKind: true } },
                parent: {
                  select: {
                    id: true, name: true,
                    template: { select: { templateKind: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: SYNC_PAGE_LIMIT,
    });

    return rows.map(r => {
      // Resolve parent chain by KIND, not by position. The Area level is
      // optional (AHU can sit directly under a Block), so walking by fixed
      // depth (area = ahu.parent; block = area.parent) breaks for filters
      // under a direct-under-block AHU — it labels the Block as the Area and
      // yields blockId = null, which then drops the home-block on the tablet's
      // offline cache. Collect the linear ancestor chain and bucket by kind.
      // Names are best-effort; a missing level stays null and the FE renders "—".
      const chain = [r.parent, r.parent?.parent, (r.parent?.parent as any)?.parent].filter(Boolean) as Array<{ id: string; name: string; template?: { templateKind?: string } | null }>;
      const byKind = (kind: string) => chain.find(n => n?.template?.templateKind === kind) ?? null;
      // Direct parent is the AHU; fall back to it if kind metadata is absent.
      const ahu = byKind('AHU') ?? r.parent;
      const area = byKind('AREA');
      const block = byKind('BLOCK');
      return {
        id: r.id,
        name: r.name,
        templateId: r.templateId,
        templateName: r.template?.name ?? null,
        templateKind: r.template?.templateKind ?? null,
        status: r.status,
        isActive: r.isActive,
        attributes: r.attributes,
        parentId: r.parentId,
        // Flat parent-chain names — matches CachedFilter / FE consumer shape.
        ahuId: ahu?.id ?? null,
        ahuName: ahu?.name ?? null,
        areaId: area?.id ?? null,
        areaName: area?.name ?? null,
        blockId: block?.id ?? null,
        blockName: block?.name ?? null,
        // FilterDetails sidecar — flatten to top-level for FE convenience.
        filterProfileId: r.filterDetails?.filterProfileId ?? null,
        currentLifecycleState: r.filterDetails?.currentLifecycleState ?? null,
        currentCycleId: r.filterDetails?.currentCycleId ?? null,
        filterSet: r.filterDetails?.filterSet ?? null,
        // Watermark fields — FE picks the max(updatedAt) across the response
        // to advance its cursor.
        updatedAt: r.updatedAt,
        filterDetailsUpdatedAt: r.filterDetails?.updatedAt ?? null,
      };
    });
  }
}
