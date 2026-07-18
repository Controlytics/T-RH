/**
 * Filter Profile Service — CRUD + assignment for filter profiles.
 *
 * Phase A.3 versioning (2026-05-01): every mutation is a snapshot-then-bump.
 * Before applying any change we write the OUTGOING version's full state into
 * `FilterProfileVersion.snapshot`, then bump `FilterProfile.version`. Cycles
 * already pin `cleaning_cycles.profileId` to a FilterCleaningProfile row at
 * start, so no cycle-side pin map is needed for FilterProfile — versions
 * exist purely so audit replay and the admin UI can reconstruct the exact
 * mapping that was active at any historical moment.
 *
 * Step 4 (2026-05-02): `applicableTemplates` migrated from a JSONB array on
 * `FilterProfile` to a proper join table `filter_profile_applicable_templates`
 * with cascade FKs to AssetTemplate. Reads flatten the join rows back into a
 * `string[]` on the response so the API + FE shape is unchanged. Snapshots
 * resolve and freeze the array inside the transaction so historical replay
 * still works byte-correct.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Snapshot the current FilterProfile row + bump version. Caller is expected
 * to be inside a transaction and is responsible for the actual mutation that
 * follows. Mirrors the A.1 ChecklistProfile pattern.
 *
 * Step 4: `applicableTemplates` is no longer a column on FilterProfile, so we
 * read the live join rows inside the same transaction and freeze them into the
 * snapshot as `string[]` (same shape callers always saw).
 */
async function snapshotAndBump(
  tx: Tx,
  profileId: string,
  changeNotes: string | null,
  ctx: RequestContext,
): Promise<void> {
  const profile = await tx.filterProfile.findUnique({
    where: { id: profileId },
    include: { applicableTemplates: { select: { templateId: true } } },
  });
  if (!profile) throw new AppError(404, 'NOT_FOUND', 'Filter profile not found');
  await tx.filterProfileVersion.create({
    data: {
      profileId,
      versionNumber: profile.version,
      snapshot: {
        name: profile.name,
        description: profile.description,
        cleaningProfileId: profile.cleaningProfileId,
        applicableTemplates: profile.applicableTemplates.map(t => t.templateId),
        defaultPmScheduleId: profile.defaultPmScheduleId,
        blockRestriction: profile.blockRestriction,
        allowedBlocks: profile.allowedBlocks,
        maxCleaningCycles: profile.maxCleaningCycles,
        isActive: profile.isActive,
      },
      changeNotes,
      createdBy: ctx.userSub,
    },
  });
  await tx.filterProfile.update({
    where: { id: profileId },
    data: { version: { increment: 1 } },
  });
}

/**
 * Flatten Prisma's joined `applicableTemplates: [{templateId}]` to the wire
 * shape `applicableTemplates: string[]` so callers (API responses, FE) see
 * exactly what they did before Step 4.
 */
function flattenApplicableTemplates<T extends { applicableTemplates?: { templateId: string }[] }>(row: T): Omit<T, 'applicableTemplates'> & { applicableTemplates: string[] } {
  const ids = (row.applicableTemplates ?? []).map(t => t.templateId);
  return { ...row, applicableTemplates: ids };
}

export class FilterProfileService {
  async list(_ctx: RequestContext, query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: any = {};

    const [data, total] = await Promise.all([
      prisma.filterProfile.findMany({
        where,
        include: {
          cleaningProfile: { select: { name: true } },
          applicableTemplates: { select: { templateId: true } },
          _count: { select: { filterDetails: true } }, // Step 6: assetInstances → filterDetails
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.filterProfile.count({ where }),
    ]);

    const enriched = data.map((fp: any) => ({
      ...flattenApplicableTemplates(fp),
      cleaningProfileName: fp.cleaningProfile?.name ?? 'Unknown',
      activeFilterCount: fp._count.filterDetails,
      cleaningProfile: undefined,
      _count: undefined,
    }));

    return { data: enriched, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getById(_ctx: RequestContext, id: string) {
    const fp = await prisma.filterProfile.findFirst({
      where: { id },
      include: { applicableTemplates: { select: { templateId: true } } },
    });
    if (!fp) throw new AppError(404, 'NOT_FOUND', 'Filter profile not found');
    return flattenApplicableTemplates(fp);
  }

  /**
   * List archived versions of a filter profile, newest first. The current live
   * row is NOT in the versions table (versions only contains pre-mutation
   * snapshots), so the response is the history strictly BEFORE the current
   * version pointer.
   */
  async getVersions(_ctx: RequestContext, profileId: string) {
    const profile = await prisma.filterProfile.findUnique({
      where: { id: profileId },
      select: { id: true, version: true },
    });
    if (!profile) throw new AppError(404, 'NOT_FOUND', 'Filter profile not found');
    const versions = await prisma.filterProfileVersion.findMany({
      where: { profileId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, changeNotes: true, createdAt: true, createdBy: true },
    });
    return { profileId, currentVersion: profile.version, versions };
  }

  /**
   * Read a frozen historical version. Returns the snapshot payload exactly as
   * it was when that version was archived. Used by audit replay.
   */
  async getVersion(_ctx: RequestContext, profileId: string, versionNumber: number) {
    const v = await prisma.filterProfileVersion.findUnique({
      where: { profileId_versionNumber: { profileId, versionNumber } },
    });
    if (!v) throw new AppError(404, 'NOT_FOUND', `Version ${versionNumber} of filter profile ${profileId} not found`);
    return {
      profileId: v.profileId,
      versionNumber: v.versionNumber,
      ...(v.snapshot as any),
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      changeNotes: v.changeNotes,
    };
  }

  async create(ctx: RequestContext, data: any) {
    const { name, description, cleaningProfileId, applicableTemplates, blockRestriction, allowedBlocks, maxCleaningCycles } = data;

    // Verify cleaning profile exists
    const cp = await prisma.filterCleaningProfile.findFirst({
      where: { id: cleaningProfileId, status: 'ACTIVE' },
    });
    if (!cp) throw new AppError(400, 'VALIDATION_ERROR', 'Referenced cleaning profile not found or not active');

    const incomingTemplateIds: string[] = Array.isArray(applicableTemplates) ? applicableTemplates : [];

    // Verify referenced templates actually exist before we try to bind them.
    // The DB FK on the join table would reject this anyway, but doing it here
    // returns a useful error instead of a Prisma constraint exception.
    if (incomingTemplateIds.length > 0) {
      const found = await prisma.assetTemplate.findMany({
        where: { id: { in: incomingTemplateIds } },
        select: { id: true },
      });
      if (found.length !== incomingTemplateIds.length) {
        const foundSet = new Set(found.map(t => t.id));
        const missing = incomingTemplateIds.filter(id => !foundSet.has(id));
        throw new AppError(400, 'VALIDATION_ERROR', `Unknown asset template id(s): ${missing.join(', ')}`);
      }
    }

    // First version is created lazily on first edit. Profile starts at version=1;
    // no version row needed yet (live row IS v1). Mirrors A.1 ChecklistProfile.
    const fp = await prisma.$transaction(async (tx) => {
      const created = await tx.filterProfile.create({
        data: {
          name,
          description,
          cleaningProfileId,
          blockRestriction: blockRestriction ?? 'OWN_BLOCK_ONLY',
          allowedBlocks: allowedBlocks ?? undefined,
          maxCleaningCycles,
        },
      });
      if (incomingTemplateIds.length > 0) {
        await tx.filterProfileApplicableTemplate.createMany({
          data: incomingTemplateIds.map(templateId => ({ profileId: created.id, templateId })),
        });
      }
      return tx.filterProfile.findUnique({
        where: { id: created.id },
        include: { applicableTemplates: { select: { templateId: true } } },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CREATED',
      targetType: 'filter_profile', targetId: fp!.id,
      afterValue: { name, cleaningProfileId, applicableTemplates: incomingTemplateIds },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return flattenApplicableTemplates(fp!);
  }

  async update(ctx: RequestContext, id: string, data: any) {
    const existing = await this.getById(ctx, id);

    // Validate cleaning profile is active if being changed (read-only check, do
    // outside transaction so we don't hold a row lock for an HTTP round-trip).
    if (data.cleaningProfileId) {
      const cp = await prisma.filterCleaningProfile.findUnique({ where: { id: data.cleaningProfileId } });
      if (!cp) throw new AppError(404, 'NOT_FOUND', 'Cleaning profile not found');
      if (cp.status !== 'ACTIVE') throw new AppError(400, 'VALIDATION_ERROR', 'Cleaning profile must be active');
    }

    // Step 4: when the caller is replacing the applicable-templates set, verify
    // the new IDs exist before we open the transaction (same UX as create()).
    const replacingApplicable = Array.isArray(data.applicableTemplates);
    const incomingTemplateIds: string[] = replacingApplicable ? data.applicableTemplates : [];
    if (replacingApplicable && incomingTemplateIds.length > 0) {
      const found = await prisma.assetTemplate.findMany({
        where: { id: { in: incomingTemplateIds } },
        select: { id: true },
      });
      if (found.length !== incomingTemplateIds.length) {
        const foundSet = new Set(found.map(t => t.id));
        const missing = incomingTemplateIds.filter(id => !foundSet.has(id));
        throw new AppError(400, 'VALIDATION_ERROR', `Unknown asset template id(s): ${missing.join(', ')}`);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Phase A.3: snapshot-then-bump. Freeze the OUTGOING state into the
      // versions table before mutating the live row.
      await snapshotAndBump(tx, id, data.changeNotes ?? null, ctx);
      const live = await tx.filterProfile.update({
        where: { id },
        data: {
          name: data.name ?? existing.name,
          description: data.description ?? existing.description,
          cleaningProfileId: data.cleaningProfileId ?? existing.cleaningProfileId,
          blockRestriction: data.blockRestriction ?? existing.blockRestriction,
          allowedBlocks: data.allowedBlocks ?? existing.allowedBlocks,
          maxCleaningCycles: data.maxCleaningCycles ?? existing.maxCleaningCycles,
          isActive: data.isActive ?? existing.isActive,
        },
      });
      // Step 4: rewrite the join set if the caller provided one. Wholesale
      // delete-then-recreate is fine here because the relation rows carry no
      // metadata beyond the FK pair; the per-cell sets are tiny (a handful
      // of templates per profile).
      if (replacingApplicable) {
        await tx.filterProfileApplicableTemplate.deleteMany({ where: { profileId: id } });
        if (incomingTemplateIds.length > 0) {
          await tx.filterProfileApplicableTemplate.createMany({
            data: incomingTemplateIds.map(templateId => ({ profileId: id, templateId })),
          });
        }
      }
      return tx.filterProfile.findUnique({
        where: { id: live.id },
        include: { applicableTemplates: { select: { templateId: true } } },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'UPDATED',
      targetType: 'filter_profile', targetId: id,
      beforeValue: { name: existing.name, version: existing.version },
      afterValue: { name: updated!.name, version: updated!.version },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return flattenApplicableTemplates(updated!);
  }

  async delete(ctx: RequestContext, id: string) {
    const existing = await this.getById(ctx, id);

    // Check if any filters are currently assigned to this profile (FilterDetails — Step 6).
    const assignedCount = await prisma.filterDetails.count({
      where: { filterProfileId: id },
    });
    if (assignedCount > 0) {
      throw new AppError(400, 'VALIDATION_ERROR', `Cannot delete: ${assignedCount} filter(s) are still assigned to this profile`);
    }

    // Hard delete. The version sidecar rows cascade via @relation onDelete:Cascade.
    // Step 4: applicable-template join rows also cascade. Profile lifecycle
    // (Phase A.3 decision): we keep hard-delete-with-guard rather than
    // soft-archive — once a profile has no live filters pointing at it and no
    // cycles will ever reference it, history is moot.
    await prisma.filterProfile.delete({ where: { id } });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'DELETED',
      targetType: 'filter_profile', targetId: id,
      beforeValue: { name: existing.name, version: existing.version },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true };
  }

  async assign(ctx: RequestContext, id: string, filterInstanceIds: string[]) {
    const fp = await this.getById(ctx, id);

    // filterProfileId now lives on FilterDetails (Step 6) — upsert per-instance
    // so legacy non-eager rows still get a sidecar row.
    let assignedCount = 0;
    await Promise.all(filterInstanceIds.map(async (assetId) => {
      await prisma.filterDetails.upsert({
        where: { assetInstanceId: assetId },
        update: { filterProfileId: id },
        create: { assetInstanceId: assetId, filterProfileId: id },
      });
      assignedCount++;
    }));

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'ASSIGNED',
      targetType: 'filter_profile', targetId: id,
      afterValue: { assignedFilters: filterInstanceIds.length, profileVersion: fp.version },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true, assignedCount };
  }
}
