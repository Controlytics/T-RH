import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { RequestContext } from '../../types/context.js';
import { createNotification } from '../notifications/notification.service.js';

export const blockChangeService = {
  /**
   * Cross-block mode (config `block-change-approval.mode`):
   *   - 'NONE'     → no cross-block check at all; clean any filter in any block.
   *   - 'CONFIRM'  → operator self-confirm (no approval); the default.
   *   - 'APPROVAL' → formal block-change request that an approver must approve.
   * For CONFIRM/APPROVAL: online only — OFFLINE never gates (the FE shows an
   * informational notice and the server auto-passes offline replays). Defaults
   * to 'CONFIRM' when the config row/key is absent.
   */
  async getMode(): Promise<'NONE' | 'CONFIRM' | 'APPROVAL'> {
    const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'block-change-approval' } });
    const mode = (cfg?.configValue as any)?.mode;
    if (mode === 'NONE') return 'NONE';
    if (mode === 'APPROVAL') return 'APPROVAL';
    return 'CONFIRM';
  },

  async create(ctx: RequestContext, data: {
    filterId: string; filterName: string;
    fromBlockId: string; fromBlockName: string;
    toBlockId: string; toBlockName: string;
    reason?: string;
  }) {
    const existing = await prisma.blockChangeRequest.findFirst({
      where: { filterId: data.filterId, toBlockId: data.toBlockId, status: 'PENDING' },
    });
    if (existing) throw new AppError(409, 'DUPLICATE_REQUEST', 'A pending request already exists for this filter and block');

    // Build the row from explicit named fields — never spread the request body.
    // `data` arrives as `req.body as any` and the POST schema does not set
    // additionalProperties:false, so a spread let a requester supply real model
    // columns: `status:'APPROVED'` self-forged the approval that hasApproval()
    // checks (bypassing the cross-block gate with no approver), and
    // `manualEntry:true` disguised the row as a data-management insert.
    const request = await prisma.blockChangeRequest.create({
      data: {
        filterId: data.filterId,
        filterName: data.filterName,
        fromBlockId: data.fromBlockId,
        fromBlockName: data.fromBlockName,
        toBlockId: data.toBlockId,
        toBlockName: data.toBlockName,
        reason: data.reason,
        requestedBy: ctx.userSub,
        requestedByName: ctx.userId,
      },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'BLOCK_CHANGE_REQUESTED',
      targetType: 'block_change_request', targetId: request.id,
      afterValue: { filterId: data.filterId, fromBlock: data.fromBlockName, toBlock: data.toBlockName },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    // Notify the approvers. Pre-fix, this row was created silently and the
    // configured approval-role users had no signal at all — they only knew
    // a request existed if they happened to visit /approvals (which polls
    // /pending-count). Reported 2026-05-25: "request was going to selected
    // role users or not" — answer was "not". Now we read the same config
    // key the approval gate (routes.ts:assertApprovalRoleAllowed) uses and
    // fan out a notification to that role + SUPER_ADMIN (who can always
    // approve). Failure is non-fatal — the request row is the source of
    // truth; the notification is convenience.
    try {
      const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'block-change-approval' } });
      const approvalRole = ((cfg?.configValue as any)?.approvalRole as string | undefined)?.trim() || 'ADMIN';
      const baseMsg = {
        type: 'BLOCK_CHANGE_REQUESTED' as const,
        title: 'Block Change Approval Needed',
        message: `${ctx.userId} requested approval to clean ${data.filterName} (from ${data.fromBlockName}) in ${data.toBlockName}.${data.reason ? ` Reason: ${data.reason}` : ''}`,
        metadata: {
          requestId: request.id,
          filterId: data.filterId,
          filterName: data.filterName,
          fromBlockId: data.fromBlockId,
          fromBlockName: data.fromBlockName,
          toBlockId: data.toBlockId,
          toBlockName: data.toBlockName,
          requestedByName: ctx.userId,
        },
        createdBy: ctx.userId,
      };
      await createNotification({ ...baseMsg, forRole: approvalRole });
      // Also notify SUPER_ADMIN unless it IS the configured role (avoid duplicate).
      if (approvalRole !== 'SUPER_ADMIN') {
        await createNotification({ ...baseMsg, forRole: 'SUPER_ADMIN' });
      }
    } catch (e) {
      console.error('[block-change] Failed to dispatch approval notification:', (e as Error).message);
    }

    return request;
  },

  async list(ctx: RequestContext, query: { status?: string; page?: number; limit?: number; mine?: boolean }) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: any = {};

    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.mine) where.requestedBy = ctx.userSub;

    const [data, total] = await Promise.all([
      prisma.blockChangeRequest.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.blockChangeRequest.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  async pendingCount(_ctx: RequestContext) {
    const where: any = { status: 'PENDING' };
    return prisma.blockChangeRequest.count({ where });
  },

  async process(ctx: RequestContext, id: string, action: 'approve' | 'reject', comment?: string) {
    const request = await prisma.blockChangeRequest.findUnique({ where: { id } });
    if (!request) throw new AppError(404, 'NOT_FOUND', 'Request not found');
    if (request.status !== 'PENDING') throw new AppError(409, 'ALREADY_PROCESSED', `Request already ${request.status.toLowerCase()}`);

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const updated = await prisma.blockChangeRequest.update({
      where: { id },
      data: {
        status: newStatus,
        processedBy: ctx.userSub,
        processedByName: ctx.userId,
        processedComment: comment ?? null,
        processedAt: new Date(),
      },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: action === 'approve' ? 'BLOCK_CHANGE_APPROVED' : 'BLOCK_CHANGE_REJECTED',
      targetType: 'block_change_request', targetId: id,
      beforeValue: { status: 'PENDING' },
      afterValue: { status: newStatus, comment },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    // Close the loop: tell the requester their request was processed.
    // `requestedByName` is the username stamp written in create(); it matches
    // the `forUserId` field convention used elsewhere (see auth.service.ts
    // createNotification calls).
    try {
      await createNotification({
        type: action === 'approve' ? 'BLOCK_CHANGE_APPROVED' : 'BLOCK_CHANGE_REJECTED',
        title: action === 'approve' ? 'Block Change Approved' : 'Block Change Rejected',
        message: action === 'approve'
          ? `Your request to clean ${request.filterName} in ${request.toBlockName} was approved by ${ctx.userId}.${comment ? ` Note: ${comment}` : ''}`
          : `Your request to clean ${request.filterName} in ${request.toBlockName} was rejected by ${ctx.userId}.${comment ? ` Reason: ${comment}` : ''}`,
        forUserId: request.requestedByName,
        metadata: {
          requestId: id,
          filterId: request.filterId,
          filterName: request.filterName,
          toBlockId: request.toBlockId,
          toBlockName: request.toBlockName,
          processedByName: ctx.userId,
          comment,
        },
        createdBy: ctx.userId,
      });
    } catch (e) {
      console.error('[block-change] Failed to dispatch process notification:', (e as Error).message);
    }

    return updated;
  },

  /**
   * How long an APPROVED request stays usable. Config `autoExpireHours`
   * (default 24); 0 means never expire.
   */
  async getAutoExpireHours(): Promise<number> {
    const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'block-change-approval' } });
    const raw = (cfg?.configValue as any)?.autoExpireHours;
    const hours = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(hours) && hours > 0 ? hours : 0;
  },

  /**
   * Is there a usable approval for this filter→block?
   *
   * Expiry is evaluated HERE, at read time, rather than by a sweep: the config
   * value can change at any moment, and a row that has merely aged out is not a
   * different kind of record — it's just no longer usable. (The row keeps
   * status APPROVED until something consumes it; the gate is what enforces the
   * window, and current-state reports through this same call so the UI agrees.)
   *
   * `autoExpireHours` was pure config theater before 2026-07-15 — editable on
   * Config → Role Assignments and read by nothing at all.
   */
  async hasApproval(filterId: string, toBlockId: string): Promise<boolean> {
    const approved = await prisma.blockChangeRequest.findFirst({
      where: { filterId, toBlockId, status: 'APPROVED' },
      orderBy: { processedAt: 'desc' },
    });
    if (!approved) return false;

    const hours = await this.getAutoExpireHours();
    if (hours === 0) return true;

    // processedAt is stamped at approval; fall back to createdAt for any legacy
    // row approved before that column was populated.
    const approvedAt = approved.processedAt ?? approved.createdAt;
    if (!approvedAt) return true;
    return approvedAt.getTime() >= Date.now() - hours * 3_600_000;
  },

  /**
   * Audit 2026-05-05 fix #7 documented a tx-aware consume so the find+update
   * would happen under the same row lock as the cycle insert — but it was
   * written and never wired, so until 2026-07-15 NOTHING consumed an approval.
   * Now start-cycle spends it inside its $transaction.
   *
   * The non-transactional `consumeApproval` and the unused `hasApprovalTx` were
   * removed at the same time: both had zero callers, and keeping a consume that
   * runs outside the caller's lock only invites reintroducing the race.
   *
   * Spend one APPROVED request. Returns how many rows were consumed — 0 means
   * the approval was already spent (or never existed), which the caller MUST
   * treat as "not approved". That count is what makes the gate single-use under
   * concurrency: validateBlockChange's read happens outside the start-cycle
   * transaction, so two racing starts can both see hasApproval=true; only the
   * one whose updateMany actually flips APPROVED→EXPIRED under the row lock may
   * proceed.
   */
  async consumeApprovalTx(tx: any, filterId: string, toBlockId: string): Promise<number> {
    const { count } = await tx.blockChangeRequest.updateMany({
      where: { filterId, toBlockId, status: 'APPROVED' },
      data: { status: 'EXPIRED' },
    });
    return count;
  },
};
