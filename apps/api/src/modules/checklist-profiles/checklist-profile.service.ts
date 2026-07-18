/**
 * Checklist Profile Service — CRUD for checklist profiles and questions.
 *
 * Phase A.1 versioning (2026-05-01): every mutation is a snapshot-then-bump.
 * Before applying any change we write the OUTGOING version's full state into
 * `ChecklistProfileVersion.snapshot`, then bump `ChecklistProfile.version`.
 * Cycles pin a specific version at start so questions resolve byte-exactly
 * regardless of subsequent edits — online and offline submissions become
 * symmetric.
 */
import type { RequestContext } from '../../types/context.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Build a complete snapshot of the profile + questions to freeze on the
 * outgoing version before mutating. Reads inside the same transaction so
 * concurrent writers see a consistent snapshot.
 */
async function snapshotProfile(tx: Tx, profileId: string): Promise<{ version: number; snapshot: any } | null> {
  const profile = await tx.checklistProfile.findUnique({
    where: { id: profileId },
    include: { questions: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!profile) return null;
  return {
    version: profile.version,
    snapshot: {
      name: profile.name,
      description: profile.description,
      isActive: profile.isActive,
      questions: profile.questions.map((q: any) => ({
        id: q.id,
        question: q.question,
        questionType: q.questionType,
        required: q.required,
        section: q.section,
        description: q.description,
        options: q.options,
        validation: q.validation,
        sortOrder: q.sortOrder,
      })),
    },
  };
}

/**
 * Snapshot the current version into the versions table, then bump the live
 * version pointer. Caller is expected to be inside a transaction and is
 * responsible for the actual mutation that follows.
 */
async function snapshotAndBump(
  tx: Tx,
  profileId: string,
  changeNotes: string,
  ctx: RequestContext,
): Promise<void> {
  const snap = await snapshotProfile(tx, profileId);
  if (!snap) throw new AppError(404, 'NOT_FOUND', 'Checklist profile not found');
  await tx.checklistProfileVersion.create({
    data: {
      profileId,
      versionNumber: snap.version,
      snapshot: snap.snapshot,
      changeNotes,
      createdBy: ctx.userSub,
    },
  });
  await tx.checklistProfile.update({
    where: { id: profileId },
    data: { version: { increment: 1 } },
  });
}

export class ChecklistProfileService {
  async list(
    _ctx: RequestContext,
    query: { page?: number; limit?: number; isActive?: string; expand?: string },
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 100);
    const where: any = {};
    if (query.isActive === 'true') where.isActive = true;
    else if (query.isActive === 'false') where.isActive = false;

    // expand=questions inlines the full questions array on each profile so the
    // mobile/tablet client can cache the entire checklist payload for offline
    // use. Without this the offline checklist dialog opens with zero questions.
    const expand = String(query.expand ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const includeQuestions = expand.includes('questions');

    const [data, total] = await Promise.all([
      prisma.checklistProfile.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { questions: true } },
          ...(includeQuestions ? { questions: { orderBy: { sortOrder: 'asc' } } } : {}),
        },
      }),
      prisma.checklistProfile.count({ where }),
    ]);

    return {
      data: data.map((p: any) => ({
        id: p.id, name: p.name, description: p.description,
        isActive: p.isActive, version: p.version, questionCount: p._count.questions,
        createdAt: p.createdAt, updatedAt: p.updatedAt,
        ...(includeQuestions && { questions: p.questions ?? [] }),
      })),
      total, page, limit, totalPages: Math.ceil(total / limit),
    };
  }

  async getById(_ctx: RequestContext, id: string) {
    const profile = await prisma.checklistProfile.findFirst({
      where: { id },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!profile) throw new AppError(404, 'NOT_FOUND', 'Checklist profile not found');
    return profile;
  }

  /**
   * Read a specific historical version. Returns the snapshot payload exactly
   * as it was when that version was frozen. Used by audit replay and by the
   * offline tablet to fetch a version it doesn't yet have cached.
   */
  async getVersion(_ctx: RequestContext, profileId: string, versionNumber: number) {
    const v = await prisma.checklistProfileVersion.findUnique({
      where: { profileId_versionNumber: { profileId, versionNumber } },
    });
    if (!v) throw new AppError(404, 'NOT_FOUND', `Version ${versionNumber} of profile ${profileId} not found`);
    return {
      profileId: v.profileId,
      versionNumber: v.versionNumber,
      ...(v.snapshot as any),
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      changeNotes: v.changeNotes,
    };
  }

  async listVersions(_ctx: RequestContext, profileId: string) {
    return prisma.checklistProfileVersion.findMany({
      where: { profileId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, changeNotes: true, createdAt: true, createdBy: true },
    });
  }

  async create(ctx: RequestContext, data: any) {
    // First version is created lazily on first edit. Profile starts at version=1
    // with empty questions; no version row needed yet (live row IS v1).
    const profile = await prisma.checklistProfile.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        createdBy: ctx.userSub,
      },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CREATED',
      targetType: 'checklist_profile', targetId: profile.id,
      afterValue: { name: data.name, version: profile.version },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });
    return profile;
  }

  async update(ctx: RequestContext, id: string, data: any) {
    // Captured inside the tx, audited after it commits (house pattern: see
    // cleaning-profile.service.ts — audit only what actually persisted).
    let before: { name: string; description: string | null; isActive: boolean; version: number } | undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.checklistProfile.findUnique({ where: { id } });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Checklist profile not found');
      before = {
        name: existing.name,
        description: existing.description,
        isActive: existing.isActive,
        version: existing.version,
      };
      await snapshotAndBump(tx, id, 'profile metadata updated', ctx);
      return tx.checklistProfile.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'UPDATED',
      targetType: 'checklist_profile', targetId: id,
      beforeValue: before,
      afterValue: {
        name: updated.name, description: updated.description,
        isActive: updated.isActive, version: updated.version,
      },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return updated;
  }

  async delete(ctx: RequestContext, id: string) {
    const existing = await this.getById(ctx, id);

    // The in-use guards and the delete must be ONE transaction. They used to be
    // four separate statements: an operator starting a cycle between the
    // cleaning_cycles count and the delete pinned a version the cascade then
    // destroyed — precisely what the pin guard exists to prevent, and the one
    // window in which it is useless. Every other mutation in this service is
    // already transactional; this was the outlier.
    const versionCount = await prisma.$transaction(async (tx) => {
      // Check if referenced by any pipeline CHECKLIST nodes in non-archived cleaning profiles
      const usedInPipelines = await tx.filterPipelineStage.count({
        where: {
          nodeType: 'CHECKLIST',
          configuration: { path: ['checklistProfileId'], equals: id },
          profile: { status: { not: 'ARCHIVED' } },
        },
      });
      if (usedInPipelines > 0) {
        throw new AppError(409, 'IN_USE', 'Cannot delete: checklist is referenced by ' + usedInPipelines + ' pipeline node(s)');
      }
      // Phase A.1: also block delete if any cycle (active or historical) has this
      // profile in its checklistVersionPins. Removing version history would break
      // audit reproducibility for those cycles.
      const usedInCycles = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM cleaning_cycles WHERE checklist_version_pins ? ${id}
      `;
      const cycleCount = Number(usedInCycles[0]?.count ?? 0);
      if (cycleCount > 0) {
        throw new AppError(409, 'IN_USE', `Cannot delete: ${cycleCount} cleaning cycle(s) have audit history pinned to this checklist's versions`);
      }
      // The cascade below destroys every ChecklistProfileVersion row, so the audit
      // entry is the ONLY surviving trace of this profile — capture the identifying
      // state (and how much version history went with it) before the delete.
      const count = await tx.checklistProfileVersion.count({ where: { profileId: id } });

      // ChecklistProfileVersion rows cascade-delete with the profile.
      await tx.checklistProfile.delete({ where: { id } });
      return count;
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'DELETED',
      targetType: 'checklist_profile', targetId: id,
      beforeValue: {
        name: existing.name,
        description: existing.description,
        isActive: existing.isActive,
        version: existing.version,
        questionCount: existing.questions.length,
        archivedVersionsDestroyed: versionCount,
      },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true };
  }

  // ─── Questions ────────────────────────────────────────────

  async addQuestion(ctx: RequestContext, profileId: string, data: any) {
    // `name` is the owning profile's — the audit renderer resolves {targetName}
    // from it, and a question row has no name of its own to show an inspector.
    let profileName = '';

    const created = await prisma.$transaction(async (tx) => {
      const profile = await tx.checklistProfile.findUnique({ where: { id: profileId } });
      if (!profile) throw new AppError(404, 'NOT_FOUND', 'Checklist profile not found');
      profileName = profile.name;
      await snapshotAndBump(tx, profileId, `question added: ${data.question}`, ctx);
      const maxOrder = await tx.checklistQuestion.aggregate({ where: { profileId }, _max: { sortOrder: true } });
      return tx.checklistQuestion.create({
        data: {
          profileId,
          question: data.question,
          questionType: data.questionType ?? 'YES_NO',
          required: data.required ?? false,
          section: data.section ?? null,
          description: data.description ?? null,
          options: data.options ?? [],
          validation: data.validation ?? {},
          sortOrder: data.sortOrder ?? ((maxOrder._max.sortOrder ?? -1) + 1),
        },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CHECKLIST_QUESTION_ADDED',
      targetType: 'checklist_profile', targetId: profileId,
      afterValue: {
        name: profileName,
        questionId: created.id,
        question: created.question,
        questionType: created.questionType,
        required: created.required,
        section: created.section,
        sortOrder: created.sortOrder,
      },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return created;
  }

  async updateQuestion(ctx: RequestContext, profileId: string, questionId: string, data: any) {
    let profileName = '';
    let before: Record<string, unknown> | undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const q = await tx.checklistQuestion.findFirst({ where: { id: questionId, profileId } });
      if (!q) throw new AppError(404, 'NOT_FOUND', 'Question not found');
      const profile = await tx.checklistProfile.findUnique({ where: { id: profileId } });
      if (!profile) throw new AppError(404, 'NOT_FOUND', 'Checklist profile not found');
      profileName = profile.name;
      before = {
        question: q.question, questionType: q.questionType, required: q.required,
        section: q.section, sortOrder: q.sortOrder,
      };
      await snapshotAndBump(tx, profileId, `question updated: ${data.question ?? q.question}`, ctx);
      return tx.checklistQuestion.update({
        where: { id: questionId },
        data: {
          ...(data.question !== undefined && { question: data.question }),
          ...(data.questionType !== undefined && { questionType: data.questionType }),
          ...(data.required !== undefined && { required: data.required }),
          ...(data.section !== undefined && { section: data.section }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.options !== undefined && { options: data.options }),
          ...(data.validation !== undefined && { validation: data.validation }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CHECKLIST_QUESTION_UPDATED',
      targetType: 'checklist_profile', targetId: profileId,
      beforeValue: { name: profileName, questionId, ...before },
      afterValue: {
        name: profileName,
        questionId,
        question: updated.question,
        questionType: updated.questionType,
        required: updated.required,
        section: updated.section,
        sortOrder: updated.sortOrder,
      },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return updated;
  }

  async deleteQuestion(ctx: RequestContext, profileId: string, questionId: string) {
    let profileName = '';
    let deleted: Record<string, unknown> | undefined;

    const result = await prisma.$transaction(async (tx) => {
      const q = await tx.checklistQuestion.findFirst({ where: { id: questionId, profileId } });
      if (!q) throw new AppError(404, 'NOT_FOUND', 'Question not found');
      const profile = await tx.checklistProfile.findUnique({ where: { id: profileId } });
      if (!profile) throw new AppError(404, 'NOT_FOUND', 'Checklist profile not found');
      profileName = profile.name;
      deleted = {
        question: q.question, questionType: q.questionType, required: q.required,
        section: q.section, sortOrder: q.sortOrder,
      };
      await snapshotAndBump(tx, profileId, `question deleted: ${q.question}`, ctx);
      await tx.checklistQuestion.delete({ where: { id: questionId } });
      return { success: true };
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CHECKLIST_QUESTION_DELETED',
      targetType: 'checklist_profile', targetId: profileId,
      beforeValue: { name: profileName, questionId, ...deleted },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return result;
  }

  async reorderQuestions(ctx: RequestContext, profileId: string, questionIds: string[]) {
    let profileName = '';
    let previousOrder: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      const profile = await tx.checklistProfile.findUnique({ where: { id: profileId } });
      if (!profile) throw new AppError(404, 'NOT_FOUND', 'Checklist profile not found');
      profileName = profile.name;
      const current = await tx.checklistQuestion.findMany({
        where: { profileId }, orderBy: { sortOrder: 'asc' }, select: { id: true },
      });
      previousOrder = current.map((q) => q.id);
      await snapshotAndBump(tx, profileId, 'questions reordered', ctx);
      await Promise.all(questionIds.map((qId, i) =>
        tx.checklistQuestion.update({ where: { id: qId }, data: { sortOrder: i } })
      ));
      return { success: true };
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CHECKLIST_QUESTIONS_REORDERED',
      targetType: 'checklist_profile', targetId: profileId,
      beforeValue: { name: profileName, questionOrder: previousOrder },
      afterValue: { name: profileName, questionOrder: questionIds },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return result;
  }
}
