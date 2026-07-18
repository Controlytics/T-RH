/**
 * A-01 Phase 2 Tier 1 — Typed-asset dispatch helper.
 *
 * Foundation for the asset_instances → typed-tables write-cutover. Used by
 * the canonical instance.repository.ts to dual-write every asset CRUD to
 * both the typed-hierarchy table (blocks / areas / ahus / filters) AND the
 * legacy `asset_instances` table.
 *
 * Why dual-write rather than typed-only:
 *   - The legacy `asset_instances` table is still read by ~60% of the
 *     backend (107 prisma.assetInstance.* call sites across 39 files).
 *     Until those sites migrate (Phase 2 Tiers 2-7), `asset_instances`
 *     must stay populated.
 *   - The M-04 forward-mirror trigger (`fn_mirror_asset_instance`) is
 *     idempotent on typed-table inserts via `ON CONFLICT (id) DO UPDATE`,
 *     so dual-write doesn't fight the trigger — it pre-populates the
 *     typed row before the trigger fires.
 *   - Transaction rollback cleans up both writes atomically on failure.
 *
 * Why OTHER kind is special-cased:
 *   - Per D-decision D1 (signed off 2026-05-29 — see tasks/A-01-D-DECISIONS.md),
 *     OTHER-kind asset_instances have no typed home and stay on the legacy
 *     table indefinitely. The helper writes them to asset_instances only.
 *
 * Limitations / future work:
 *   - Read paths (findMany / findUnique / findFirst) are NOT in scope here.
 *     The forward mirror keeps typed tables synced; consumers can already
 *     read either side. This file is write-cutover only.
 *   - Identifier / relationship cascades are handled by separate FK
 *     ON DELETE CASCADE rules; the dispatch helper doesn't touch them.
 *   - The asset_template_versions snapshot side-effect on template updates
 *     happens in the template repository, not here.
 */

import { prisma } from './prisma.js';

// ─── Kind types & shapes ────────────────────────────────────────────────────

export type HierarchyKind = 'BLOCK' | 'AREA' | 'AHU' | 'FILTER';
export type AssetKind = HierarchyKind | 'OTHER' | 'EQUIPMENT';

/**
 * The subset of asset_instances columns that the typed tables mirror.
 * Excludes `templateId` (typed tables don't carry it) and `parentId`
 * (typed tables use kind-specific FKs — translated below).
 */
export interface CommonAssetData {
  name: string;
  description?: string | null;
  status?: string;
  attributes?: Record<string, unknown>;
  customAttributes?: Record<string, unknown>;
  
  isActive?: boolean;
  createdBy?: string | null;
  updatedBy?: string | null;
}

// ─── Kind lookup ────────────────────────────────────────────────────────────

/**
 * Resolve the AssetKind for a given templateId. Hits a per-process Map cache
 * (template kinds are immutable for the lifetime of a template) to keep this
 * cheap on hot paths.
 */
const kindByTemplateIdCache = new Map<string, AssetKind>();

export async function kindFromTemplateId(templateId: string): Promise<AssetKind> {
  const cached = kindByTemplateIdCache.get(templateId);
  if (cached) return cached;
  const tpl = await prisma.assetTemplate.findUnique({
    where: { id: templateId },
    select: { templateKind: true },
  });
  if (!tpl) throw new Error(`Template not found: ${templateId}`);
  const kind = normalizeKind(tpl.templateKind);
  kindByTemplateIdCache.set(templateId, kind);
  return kind;
}

/** Exported for tests + cache-invalidation if a template's kind ever changes. */
export function _clearKindCache(): void {
  kindByTemplateIdCache.clear();
}

function normalizeKind(raw: string): AssetKind {
  switch (raw) {
    case 'BLOCK': case 'AREA': case 'AHU': case 'FILTER': case 'EQUIPMENT': case 'OTHER':
      return raw as AssetKind;
    default:
      return 'OTHER';
  }
}

export function isHierarchyKind(k: AssetKind): k is HierarchyKind {
  return k === 'BLOCK' || k === 'AREA' || k === 'AHU' || k === 'FILTER';
}

/**
 * Resolve the kind of an existing asset by id. Uses the asset_instances ⇒
 * template join. Returns null if the id isn't found.
 */
export async function kindFromInstanceId(id: string): Promise<AssetKind | null> {
  const inst = await prisma.assetInstance.findUnique({
    where: { id },
    select: { template: { select: { templateKind: true } } },
  });
  if (!inst?.template) return null;
  return normalizeKind(inst.template.templateKind);
}

// ─── Data-shape translation ─────────────────────────────────────────────────

/**
 * Translate an asset_instances-shaped data object to its typed-table shape.
 * Strips fields the typed tables don't carry (`templateId`, `templateVersion`,
 * `currentLifecycleState`, etc. — those live on FilterDetails) and translates
 * `parentId` into the kind-specific typed FK column name (areas.blockId,
 * ahus.areaId, filters.ahuId; blocks have no parent FK).
 */
export function translateToTypedShape(
  kind: HierarchyKind,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const {
    // Drop these — typed tables don't have them:
    templateId, templateVersion, parentId,
    currentLifecycleState, currentCycleId, filterProfileId, filterSet,
    // Pass-through:
    ...rest
  } = data as any;

  // Add the kind-specific parent FK if parentId was supplied.
  // blocks have no parent; areas.blockId, ahus.areaId, filters.ahuId.
  if (parentId !== undefined) {
    if (kind === 'AREA')   (rest as any).blockId = parentId;
    else if (kind === 'AHU')   (rest as any).areaId  = parentId;
    else if (kind === 'FILTER')(rest as any).ahuId   = parentId;
    // For BLOCK we drop parentId silently — blocks are top-of-tree.
  }

  return rest;
}

// ─── Tx-aware Prisma delegate dispatch ─────────────────────────────────────

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function typedDelegate(tx: Tx, kind: HierarchyKind) {
  switch (kind) {
    case 'BLOCK':  return tx.block;
    case 'AREA':   return tx.area;
    case 'AHU':    return tx.ahu;
    case 'FILTER': return tx.filter;
  }
}

// ─── Public CRUD primitives ─────────────────────────────────────────────────

/**
 * Dual-write create: writes to the typed table first, then to asset_instances
 * with the SAME id. The forward mirror trigger fires on the asset_instances
 * write — its ON CONFLICT (id) DO UPDATE makes it idempotent on the typed row
 * we just wrote. OTHER-kind rows go to asset_instances only.
 */
export async function dispatchCreate(
  data: Record<string, unknown> & { templateId: string },
): Promise<any> {
  const kind = await kindFromTemplateId(data.templateId);

  if (!isHierarchyKind(kind)) {
    // OTHER / EQUIPMENT — legacy-only per D1=C.
    return prisma.assetInstance.create({ data: data as any });
  }

  return prisma.$transaction(async (tx) => {
    // Write to typed table first; capture the id so asset_instances can
    // reuse it (UUID-reuse keystone preserves all soft-FK references).
    const typedRow = await (typedDelegate(tx, kind) as any).create({
      data: translateToTypedShape(kind, data),
    });
    return tx.assetInstance.create({ data: { ...data, id: typedRow.id } as any });
  });
}

/**
 * Dual-write update by id. Resolves kind via asset_instances ⇒ template join
 * (single round-trip), then updates the typed table + asset_instances inside
 * a transaction. OTHER goes to asset_instances only.
 *
 * Returns the asset_instances row (the API-shape consumers expect).
 */
export async function dispatchUpdate(
  id: string,
  data: Record<string, unknown>,
): Promise<any> {
  const kind = await kindFromInstanceId(id);
  if (!kind) throw new Error(`Asset instance not found: ${id}`);

  if (!isHierarchyKind(kind)) {
    return prisma.assetInstance.update({ where: { id }, data: data as any });
  }

  return prisma.$transaction(async (tx) => {
    const typedData = translateToTypedShape(kind, data);
    // Only update typed table if there's anything mappable to it (e.g. a
    // template-id-only update has nothing left after translate). Otherwise
    // skip the typed update to avoid Prisma "no fields to update" errors.
    if (Object.keys(typedData).length > 0) {
      await (typedDelegate(tx, kind) as any).update({
        where: { id },
        data: typedData,
      });
    }
    return tx.assetInstance.update({ where: { id }, data: data as any });
  });
}

/**
 * Dual-write soft-delete (isActive=false) by ids. Resolves kinds in bulk via
 * one join query, groups by kind, then issues one updateMany per kind on the
 * typed tables + one updateMany on asset_instances inside a transaction.
 *
 * Returns the asset_instances updateMany result (count of rows affected).
 */
export async function dispatchSoftDeleteMany(
  ids: string[],
  username: string,
): Promise<{ count: number }> {
  if (ids.length === 0) return { count: 0 };

  // Group ids by kind in one round-trip
  const insts = await prisma.assetInstance.findMany({
    where: { id: { in: ids } },
    select: { id: true, template: { select: { templateKind: true } } },
  });
  const byKind = new Map<AssetKind, string[]>();
  for (const i of insts) {
    const k = normalizeKind(i.template?.templateKind ?? 'OTHER');
    const arr = byKind.get(k) ?? [];
    arr.push(i.id);
    byKind.set(k, arr);
  }

  return prisma.$transaction(async (tx) => {
    // Update typed tables for hierarchy kinds.
    for (const [kind, kindIds] of byKind.entries()) {
      if (!isHierarchyKind(kind)) continue;
      await (typedDelegate(tx, kind) as any).updateMany({
        where: { id: { in: kindIds } },
        data: { isActive: false, updatedBy: username },
      });
    }
    // Update asset_instances for ALL kinds (typed + OTHER).
    return tx.assetInstance.updateMany({
      where: { id: { in: ids } },
      data: { isActive: false, updatedBy: username },
    });
  });
}
