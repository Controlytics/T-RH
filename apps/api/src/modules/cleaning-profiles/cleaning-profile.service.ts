/**
 * Cleaning Profile Service — CRUD, validation, versioning for filter cleaning profiles.
 */
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';

export class CleaningProfileService {
  async list(_ctx: RequestContext, query: { page?: number; limit?: number; status?: string }) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: any = {};

    if (query.status === 'ACTIVE') {
      // Show only profiles with ACTIVE status (latest version per lineage)
      where.status = 'ACTIVE';
    } else if (query.status === 'INACTIVE') {
      // Show only lineages whose latest version is NOT ACTIVE
      // (i.e. the profile family was explicitly disabled, not just an old version)
      const activeLineages = await prisma.filterCleaningProfile.findMany({
        where: { status: 'ACTIVE' },
        select: { lineageId: true },
        distinct: ['lineageId'],
      });
      const activeLineageSet = activeLineages.map(l => l.lineageId);
      where.status = { in: ['ARCHIVED', 'DRAFT'] };
      if (activeLineageSet.length > 0) {
        where.lineageId = { notIn: activeLineageSet };
      }
    }

    // Get latest version per lineage
    const latestPerLineage = await prisma.filterCleaningProfile.findMany({
      where,
      distinct: ['lineageId'],
      orderBy: [{ lineageId: 'asc' }, { version: 'desc' }],
      select: { id: true },
    });

    const total = latestPerLineage.length;
    const pagedIds = latestPerLineage.slice((page - 1) * limit, page * limit).map(p => p.id);

    const paged = pagedIds.length > 0
      ? await prisma.filterCleaningProfile.findMany({
          where: { id: { in: pagedIds } },
          orderBy: [{ name: 'asc' }, { version: 'desc' }],
          include: { stages: { select: { nodeType: true } }, _count: { select: { connections: true } } },
        })
      : [];

    return {
      data: paged.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        flowMode: p.flowMode,
        version: p.version,
        status: p.status,
        stageCount: p.stages.filter(s => s.nodeType !== 'START' && s.nodeType !== 'END').length,
        connectionCount: p._count.connections,
        createdAt: p.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getById(_ctx: RequestContext, id: string) {
    const profile = await prisma.filterCleaningProfile.findFirst({
      where: { id },
      include: {
        stages: { orderBy: { sortOrder: 'asc' } },
        connections: true,
      },
    });
    if (!profile) throw new AppError(404, 'NOT_FOUND', 'Cleaning profile not found');
    return profile;
  }

  async create(ctx: RequestContext, data: any) {
    const { name, description, flowMode, alarmOnForwardSkip, alarmOnBackwardJump, alarmOnOutOfSequence, cleaningReasons, stages, connections } = data;

    // Validate pipeline graph
    this.validatePipeline(stages, connections);

    const profile = await prisma.filterCleaningProfile.create({
      data: {
        lineageId: randomUUID(),
        name,
        description,
        flowMode: flowMode ?? 'STRICT',
        alarmOnForwardSkip: alarmOnForwardSkip ?? true,
        alarmOnBackwardJump: alarmOnBackwardJump ?? true,
        alarmOnOutOfSequence: alarmOnOutOfSequence ?? true,
        cleaningReasons: cleaningReasons ?? undefined,
        status: 'ACTIVE',
        createdBy: ctx.userSub,
        stages: {
          create: stages.map((s: any, i: number) => ({
            stateKey: s.stateKey ?? null,
            nodeType: s.nodeType,
            configuration: s.configuration ?? {},
            positionX: s.positionX ?? 0,
            positionY: s.positionY ?? 0,
            sortOrder: s.sortOrder ?? i,
          })),
        },
      },
      include: { stages: { orderBy: { sortOrder: 'asc' } } },
    });

    // Create connections (need stage IDs from created profile)
    if (connections && connections.length > 0) {
      const stageMap = new Map<number, string>();
      profile.stages.forEach((s, i) => stageMap.set(i, s.id));

      await prisma.filterPipelineConnection.createMany({
        data: connections.map((c: any) => {
          const fromId = c.fromStageId ?? stageMap.get(c.fromIndex);
          if (!fromId) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid connection: could not resolve source stage');
          const toId = c.toStageId ?? stageMap.get(c.toIndex);
          if (!toId) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid connection: could not resolve target stage');
          return {
            profileId: profile.id,
            fromStageId: fromId,
            toStageId: toId,
            label: c.label ?? 'Next',
          };
        }),
      });
    }

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CREATED',
      targetType: 'cleaning_profile', targetId: profile.id,
      afterValue: { name, flowMode },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return this.getById(ctx, profile.id);
  }

  async update(ctx: RequestContext, id: string, data: any) {
    const existing = await this.getById(ctx, id);

    // Validate what will actually be PERSISTED, not just what was sent. The
    // writes below fall back to the existing stages/connections, so validating
    // only `data.*` let a body of `{connections: []}` skip validation entirely
    // (no `data.stages` → no call) and publish a new ACTIVE version carrying the
    // old stages and zero edges. Mirrors the `?? existing` fallbacks used below.
    this.validatePipeline(
      data.stages ?? existing.stages,
      data.connections ?? this.toIndexedConnections(existing.connections, existing.stages),
    );

    // Wrap entire versioning in a transaction for consistency
    const result = await prisma.$transaction(async (tx) => {
    // Mark old version as ARCHIVED
    await tx.filterCleaningProfile.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });

    // Create new version with ACTIVE status — inherits lineageId from parent
    const newProfile = await tx.filterCleaningProfile.create({
      data: {
        lineageId: existing.lineageId,
        name: data.name ?? existing.name,
        description: data.description ?? existing.description,
        flowMode: data.flowMode ?? existing.flowMode,
        alarmOnForwardSkip: data.alarmOnForwardSkip ?? existing.alarmOnForwardSkip,
        alarmOnBackwardJump: data.alarmOnBackwardJump ?? existing.alarmOnBackwardJump,
        alarmOnOutOfSequence: data.alarmOnOutOfSequence ?? existing.alarmOnOutOfSequence,
        cleaningReasons: data.cleaningReasons ?? existing.cleaningReasons ?? undefined,
        version: existing.version + 1,
        status: 'ACTIVE',
        createdBy: ctx.userSub,
        stages: {
          create: (data.stages ?? existing.stages).map((s: any, i: number) => ({
            stateKey: s.stateKey ?? null,
            nodeType: s.nodeType,
            configuration: s.configuration ?? {},
            positionX: s.positionX ?? 0,
            positionY: s.positionY ?? 0,
            sortOrder: s.sortOrder ?? i,
          })),
        },
      },
      include: { stages: { orderBy: { sortOrder: 'asc' } } },
    });

    // Create connections for new version.
    // IMPORTANT: old stage IDs from `existing.connections` (or payload echoing them)
    // no longer exist — they belong to the archived version. Remap everything to
    // new stage IDs via sortOrder (the stable index used when creating new stages).
    const conns = data.connections ?? existing.connections;
    if (conns && conns.length > 0) {
      // index → new stage id
      const indexToNewId = new Map<number, string>();
      newProfile.stages.forEach((s) => indexToNewId.set(s.sortOrder, s.id));

      // old stage id → sortOrder (so we can translate payloads that still carry old IDs)
      const oldIdToIndex = new Map<string, number>();
      existing.stages.forEach((s) => oldIdToIndex.set(s.id, s.sortOrder));

      const resolve = (stageId: string | undefined, idx: number | undefined): string | undefined => {
        if (idx !== undefined && indexToNewId.has(idx)) return indexToNewId.get(idx);
        if (stageId) {
          // If the payload still references an old (archived) stage id, translate via sortOrder
          const mappedIdx = oldIdToIndex.get(stageId);
          if (mappedIdx !== undefined) return indexToNewId.get(mappedIdx);
          // If it already matches a new stage id, use it as-is
          if (newProfile.stages.some((s) => s.id === stageId)) return stageId;
        }
        return undefined;
      };

      await tx.filterPipelineConnection.createMany({
        data: conns.map((c: any) => {
          const fromId = resolve(c.fromStageId, c.fromIndex);
          if (!fromId) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid connection: could not resolve source stage');
          const toId = resolve(c.toStageId, c.toIndex);
          if (!toId) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid connection: could not resolve target stage');
          return {
            profileId: newProfile.id,
            fromStageId: fromId,
            toStageId: toId,
            label: c.label ?? 'Next',
          };
        }),
      });
    }

    // Migrate all filter profiles from old version to new version
    await tx.filterProfile.updateMany({
      where: { cleaningProfileId: id },
      data: { cleaningProfileId: newProfile.id },
    });

    // Migrate config-based cleaning-profile assignment rules from old id → new id
    const assignCfg = await tx.systemConfig.findUnique({ where: { configKey: 'cleaning-profile-assignment' } });
    if (assignCfg?.configValue) {
      const cfg = assignCfg.configValue as { mode: string; rules?: Array<{ matchValue: string; profileId: string }> };
      if (Array.isArray(cfg.rules) && cfg.rules.some(r => r.profileId === id)) {
        const nextRules = cfg.rules.map(r => r.profileId === id ? { ...r, profileId: newProfile.id } : r);
        await tx.systemConfig.update({
          where: { configKey: 'cleaning-profile-assignment' },
          data: { configValue: { ...cfg, rules: nextRules } },
        });
      }
    }

    return newProfile;
    }); // end transaction
    const newProfile = result;

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'UPDATED',
      targetType: 'cleaning_profile', targetId: newProfile.id,
      beforeValue: { version: existing.version },
      afterValue: { version: newProfile.version },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return this.getById(ctx, newProfile.id);
  }

  async toggleStatus(ctx: RequestContext, id: string) {
    const existing = await this.getById(ctx, id);
    const newStatus = existing.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE';

    // If deactivating, check references
    if (newStatus === 'ARCHIVED') {
      const activeProfiles = await prisma.filterProfile.count({
        where: { cleaningProfileId: id, isActive: true },
      });
      if (activeProfiles > 0) {
        throw new AppError(409, 'CONFLICT', `Cannot deactivate: ${activeProfiles} active filter profile(s) reference this cleaning profile`);
      }
    }

    await prisma.filterCleaningProfile.update({
      where: { id },
      data: { status: newStatus },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: newStatus === 'ACTIVE' ? 'ACTIVATED' : 'DEACTIVATED',
      targetType: 'cleaning_profile', targetId: id,
      beforeValue: { status: existing.status },
      afterValue: { status: newStatus },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true, status: newStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE' };
  }

  async archive(ctx: RequestContext, id: string) {
    const existing = await this.getById(ctx, id);

    const activeProfiles = await prisma.filterProfile.count({
      where: { cleaningProfileId: id, isActive: true },
    });
    if (activeProfiles > 0) {
      throw new AppError(409, 'CONFLICT', `Cannot archive: ${activeProfiles} active filter profile(s) reference this cleaning profile`);
    }

    await prisma.filterCleaningProfile.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'ARCHIVED',
      targetType: 'cleaning_profile', targetId: id,
      beforeValue: { status: existing.status },
      afterValue: { status: 'ARCHIVED' },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true };
  }

  /**
   * List all versions in the same lineage as `id`. Latest version first.
   * Phase A.2 (2026-05-01): exposes the immutable-rowful version history.
   */
  async getVersions(_ctx: RequestContext, id: string) {
    const anchor = await prisma.filterCleaningProfile.findUnique({
      where: { id },
      select: { lineageId: true },
    });
    if (!anchor) throw new AppError(404, 'NOT_FOUND', 'Cleaning profile not found');

    const versions = await prisma.filterCleaningProfile.findMany({
      where: { lineageId: anchor.lineageId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        name: true,
        version: true,
        status: true,
        flowMode: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { lineageId: anchor.lineageId, versions };
  }

  /**
   * Fetch a specific historical version (frozen snapshot including stages + connections).
   * Phase A.2 (2026-05-01).
   */
  async getVersion(_ctx: RequestContext, id: string, versionNumber: number) {
    const anchor = await prisma.filterCleaningProfile.findUnique({
      where: { id },
      select: { lineageId: true },
    });
    if (!anchor) throw new AppError(404, 'NOT_FOUND', 'Cleaning profile not found');

    const profile = await prisma.filterCleaningProfile.findUnique({
      where: { lineageId_version: { lineageId: anchor.lineageId, version: versionNumber } },
      include: {
        stages: { orderBy: { sortOrder: 'asc' } },
        connections: true,
      },
    });
    if (!profile) {
      throw new AppError(
        404,
        'NOT_FOUND',
        `Version ${versionNumber} not found in lineage ${anchor.lineageId}`,
      );
    }
    return profile;
  }

  /**
   * Delete a cleaning profile row entirely. Blocks if any cycle references it
   * (cycles freeze profileId at start; deleting an in-flight or archived row that
   * a cycle still points to would corrupt audit replay).
   * Phase A.2 (2026-05-01).
   */
  async deleteProfile(ctx: RequestContext, id: string) {
    const existing = await this.getById(ctx, id);

    const cycleCount = await prisma.cleaningCycle.count({ where: { profileId: id } });
    if (cycleCount > 0) {
      throw new AppError(
        409,
        'CONFLICT',
        `Cannot delete: ${cycleCount} cleaning cycle(s) reference this version. Archive it instead.`,
      );
    }

    const filterProfileCount = await prisma.filterProfile.count({ where: { cleaningProfileId: id } });
    if (filterProfileCount > 0) {
      throw new AppError(
        409,
        'CONFLICT',
        `Cannot delete: ${filterProfileCount} filter profile assignment(s) reference this version.`,
      );
    }

    await prisma.filterCleaningProfile.delete({ where: { id } });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'DELETED',
      targetType: 'cleaning_profile', targetId: id,
      beforeValue: { name: existing.name, version: existing.version, lineageId: existing.lineageId },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true };
  }

  // Audit 2026-05-09 cleanup: removed three unused public methods —
  // getAssignedAssets(), assignAssets(), and validate() — along with their
  // routes (POST /:id/validate, GET /:id/assigned-assets, POST /:id/assign-assets).
  // Zero callers in the codebase. Asset → filter-profile binding is done
  // at FilterProfile create time via cleaningProfileId; no separate
  // bulk-assign UI was ever built. validatePipeline() (the internal helper
  // called by create + update) is preserved.

  /**
   * Restate stored connections as {fromIndex,toIndex} in the sortOrder index
   * space. A stored row references stage UUIDs of the version it belongs to, so
   * it only resolves against that version's stages — validating it against an
   * incoming `data.stages` (whose nodes carry no ids yet) would resolve to -1
   * and reject a valid edit. sortOrder is the index space the persist path
   * below already remaps through (old id → sortOrder → new id).
   */
  private toIndexedConnections(connections: any[], stages: any[]) {
    const idToIndex = new Map<string, number>();
    stages.forEach((s: any, i: number) => idToIndex.set(s.id, s.sortOrder ?? i));
    return (connections ?? []).map((c: any) => ({
      fromIndex: idToIndex.get(c.fromStageId) ?? -1,
      toIndex: idToIndex.get(c.toStageId) ?? -1,
      label: c.label,
    }));
  }

  private validatePipeline(stages: any[], connections: any[]) {
    if (!stages || stages.length < 2) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Pipeline must have at least 2 stages (START and END)');
    }

    const startNodes = stages.filter((s: any) => s.nodeType === 'START');
    const endNodes = stages.filter((s: any) => s.nodeType === 'END');

    if (startNodes.length !== 1) {
      throw new AppError(400, 'VALIDATION_ERROR', `Pipeline must have exactly 1 START node (found ${startNodes.length})`);
    }
    if (endNodes.length !== 1) {
      throw new AppError(400, 'VALIDATION_ERROR', `Pipeline must have exactly 1 END node (found ${endNodes.length})`);
    }

    // Validate STAGE nodes have stateKeys
    const stageNodes = stages.filter((s: any) => s.nodeType === 'STAGE');
    for (const sn of stageNodes) {
      if (!sn.stateKey) throw new AppError(400, 'VALIDATION_ERROR', 'All STAGE nodes must have a stateKey assigned');
    }

    // Validate CHECKLIST nodes have checklistProfileId
    const checklistNodes = stages.filter((s: any) => s.nodeType === 'CHECKLIST');
    for (const cn of checklistNodes) {
      if (!cn.configuration?.checklistProfileId) throw new AppError(400, 'VALIDATION_ERROR', 'All CHECKLIST nodes must have a checklist profile assigned');
    }

    // An edgeless graph used to skip every check below, so a profile with no
    // connections saved as ACTIVE and any cycle started against it could never
    // advance (the stage chain is walked over connections). There is no draft
    // state to accommodate — create() always writes status ACTIVE.
    if (!connections || connections.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Pipeline must have at least one connection — a profile with no connections cannot be traversed, so cycles started against it could never advance');
    }

    // Build a UUID-to-index map so connections with fromStageId/toStageId can be normalized
    const stageIdToIndex = new Map<string, number>();
    stages.forEach((s: any, i: number) => {
      if (s.id) stageIdToIndex.set(s.id, i);
    });

    const hasIncoming = new Set<number>();
    const hasOutgoing = new Set<number>();
    connections.forEach((c: any) => {
      const fromIdx = c.fromIndex ?? (c.fromStageId ? stageIdToIndex.get(c.fromStageId) : undefined) ?? -1;
      const toIdx = c.toIndex ?? (c.toStageId ? stageIdToIndex.get(c.toStageId) : undefined) ?? -1;
      hasOutgoing.add(fromIdx);
      hasIncoming.add(toIdx);
    });

    // START must have outgoing
    const startIdx = stages.findIndex((s: any) => s.nodeType === 'START');
    if (!hasOutgoing.has(startIdx)) throw new AppError(400, 'VALIDATION_ERROR', 'START node must have at least one outgoing connection');

    // END must have incoming
    const endIdx = stages.findIndex((s: any) => s.nodeType === 'END');
    if (!hasIncoming.has(endIdx)) throw new AppError(400, 'VALIDATION_ERROR', 'END node must have at least one incoming connection');

    // Check for disconnected nodes
    for (let i = 0; i < stages.length; i++) {
      if (stages[i].nodeType === 'START' || stages[i].nodeType === 'END') continue;
      if (!hasIncoming.has(i) && !hasOutgoing.has(i)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Disconnected node found: ' + (stages[i].stateKey || stages[i].nodeType));
      }
    }
  }
}
