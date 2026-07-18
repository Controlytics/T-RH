import { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { auditLog } from '../../lib/audit.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { userService } from '../users/user.service.js';
import { userRepository } from '../users/user.repository.js';
import type { RequestContext } from '../../types/context.js';

const prisma = new PrismaClient();

export const adminRequestService = {
  async create(data: {
    requestType: string;
    requesterName: string;
    requesterEmployeeId?: string;
    requesterEmail?: string;
    requestData: Record<string, unknown>;
    remarks?: string;
  }) {
    const request = await prisma.adminRequest.create({
      data: {
        requestType: data.requestType,
        requesterName: stripHtml(data.requesterName),
        requesterEmployeeId: data.requesterEmployeeId ? stripHtml(data.requesterEmployeeId) : null,
        requesterEmail: data.requesterEmail ?? null,
        requestData: data.requestData as any,
        remarks: data.remarks ? stripHtml(data.remarks) : null,
        status: 'PENDING',
      },
    });

    // Audit log (no userId since this is a public endpoint)
    const requesterLabel = request.requesterEmployeeId
      ? `${request.requesterName} (${request.requesterEmployeeId})`
      : request.requesterName;
    const submittedName = `${formatRequestType(request.requestType)} — ${requesterLabel}`;
    await auditLog({
      userId: request.requesterEmployeeId ?? undefined,
      action: 'ADMIN_REQUEST_SUBMITTED',
      targetType: 'admin_request',
      targetId: request.id,
      afterValue: {
        name: submittedName,
        requestType: request.requestType,
        requesterName: request.requesterName,
        requesterEmployeeId: request.requesterEmployeeId,
      },
      reason: `${formatRequestType(request.requestType)} request submitted by ${requesterLabel}`,
      signatureMeaning: `Admin request (${formatRequestType(request.requestType)}) submitted by ${requesterLabel}`,
    });

    // Create notification for admins
    await prisma.notification.create({
      data: {
        type: 'USER_CREATION_REQUEST_SUBMITTED',
        title: `New ${formatRequestType(request.requestType)} Request`,
        message: `${request.requesterName} submitted a ${formatRequestType(request.requestType).toLowerCase()} request.`,
        forRole: 'SUPER_ADMIN',
        metadata: { requestId: request.id, requestType: request.requestType },
      },
    });

    return request;
  },

  async list(status?: string) {
    const where = status ? { status } : {};
    return prisma.adminRequest.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
    });
  },

  async pendingCount() {
    return prisma.adminRequest.count({ where: { status: 'PENDING' } });
  },

  async getById(id: string) {
    return prisma.adminRequest.findUnique({ where: { id } });
  },

  async process(
    id: string,
    action: 'approve' | 'reject',
    adminRemarks: string,
    ctx: RequestContext,
  ) {
    const request = await prisma.adminRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundError('Request not found');
    if (request.status !== 'PENDING') throw new ValidationError('Request has already been processed');

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';

    // CLAIM the request before executing anything.
    //
    // This used to execute first and update after, so a failed action left the
    // request PENDING and retryable. But the PENDING check above is a
    // check-then-act with no lock: two admins clicking Approve within the same
    // moment both passed it and both ran executeApproval, issuing TWO temp
    // passwords for one FORGOT_PASSWORD request. The first admin's password is
    // overwritten by the second before they can read it out, so it fails at
    // login — and two audit rows claim the same approval.
    //
    // Claiming atomically means the loser matches zero rows and stops before any
    // side effect. The retry-on-failure contract is preserved by the catch below.
    const claimed = await prisma.adminRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: newStatus,
        adminRemarks: adminRemarks ? stripHtml(adminRemarks) : null,
        processedBy: ctx.userId,
        processedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw new ValidationError('Request has already been processed');

    let actionOutcome: { username?: string; temporaryPassword?: string; message?: string } = {};
    if (action === 'approve') {
      try {
        actionOutcome = await executeApproval(request, ctx);
      } catch (err) {
        // Hand the request back so the admin can retry — the original
        // "if it fails, leave it PENDING" intent. Scoped to our own claim, so a
        // revert can never clobber someone else's decision.
        await prisma.adminRequest.updateMany({
          where: { id, status: newStatus, processedBy: ctx.userId },
          data: { status: 'PENDING', adminRemarks: null, processedBy: null, processedAt: null },
        });
        throw err;
      }
    }

    const updated = await prisma.adminRequest.findUniqueOrThrow({ where: { id } });

    // Audit log
    const requesterLabel = request.requesterEmployeeId
      ? `${request.requesterName} (${request.requesterEmployeeId})`
      : request.requesterName;
    const processedName = `${formatRequestType(request.requestType)} — ${requesterLabel}`;
    await auditLog({
      userId: ctx.userId,
      userRole: ctx.userRole,
      action: action === 'approve' ? 'ADMIN_REQUEST_APPROVED' : 'ADMIN_REQUEST_REJECTED',
      targetType: 'admin_request',
      targetId: id,
      beforeValue: { name: processedName, status: 'PENDING', requesterEmployeeId: request.requesterEmployeeId },
      afterValue: { name: processedName, status: newStatus, adminRemarks, requesterEmployeeId: request.requesterEmployeeId },
      reason: `${formatRequestType(request.requestType)} request ${newStatus.toLowerCase()} — ${adminRemarks}`,
      signatureMeaning: `Admin request (${formatRequestType(request.requestType)}) ${newStatus.toLowerCase()} by admin`,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      sessionId: ctx.sessionId,
    });

    return { ...updated, ...actionOutcome };
  },
};

async function executeApproval(
  request: { id: string; requestType: string; requestData: unknown; requesterName: string; requesterEmail: string | null },
  ctx: RequestContext,
): Promise<{ username?: string; temporaryPassword?: string; message?: string }> {
  const data = (request.requestData ?? {}) as Record<string, any>;
  switch (request.requestType) {
    case 'CREATE_USER': {
      // Email is optional (no longer mandatory on the contact-admin form).
      const email = String(data.email ?? '').trim();
      const fullName = String(data.fullName ?? request.requesterName).trim();
      const requestedRole = String(data.requestedRole ?? '').trim();
      const department = data.department ? String(data.department).trim() : undefined;
      if (!requestedRole) throw new ValidationError('Request is missing requested role');

      // Username: prefer the requester-supplied User ID (collected on the
      // contact-admin form). Legacy requests submitted before that field
      // existed have no `username` → fall back to an email-derived handle.
      const requestedUsername = String(data.username ?? '').trim();
      let username: string;
      if (requestedUsername) {
        if (requestedUsername.length < 6 || requestedUsername.length > 50) {
          throw new ValidationError('Requested User ID must be 6–50 characters');
        }
        const existing = await userRepository.findByUsername(requestedUsername);
        if (existing) throw new ValidationError(`User ID "${requestedUsername}" is already taken`);
        username = requestedUsername;
      } else {
        username = await generateUniqueUsername(email);
      }
      const temporaryPassword = generateTempPassword();

      await userService.create(
        {
          username,
          fullName,
          email: email || undefined,
          department,
          role: requestedRole,
          password: temporaryPassword,
        },
        ctx,
      );
      return { username, temporaryPassword, message: `User "${username}" created.` };
    }

    case 'UNLOCK': {
      const targetUsername = String(data.username ?? '').trim();
      if (!targetUsername) throw new ValidationError('Request is missing username');
      const user = await userRepository.findByUsername(targetUsername);
      if (!user) throw new NotFoundError(`User "${targetUsername}" not found`);
      const temporaryPassword = generateTempPassword();
      await userService.unlock(user.id, temporaryPassword, ctx);
      return { username: targetUsername, temporaryPassword, message: `Account "${targetUsername}" unlocked.` };
    }

    case 'FORGOT_PASSWORD': {
      const targetUsername = String(data.username ?? '').trim();
      if (!targetUsername) throw new ValidationError('Request is missing username');
      const user = await userRepository.findByUsername(targetUsername);
      if (!user) throw new NotFoundError(`User "${targetUsername}" not found`);
      const temporaryPassword = generateTempPassword();
      await userService.resetPassword(user.id, temporaryPassword, ctx);
      return { username: targetUsername, temporaryPassword, message: `Password reset for "${targetUsername}".` };
    }

    case 'MODIFY_USER': {
      const targetUsername = String(data.username ?? '').trim();
      const field = String(data.modifyField ?? '').trim();
      const newValue = data.newValue;
      if (!targetUsername) throw new ValidationError('Request is missing username');
      if (!field) throw new ValidationError('Request is missing modifyField');
      const allowed = new Set(['fullName', 'email', 'department', 'role', 'status']);
      if (!allowed.has(field)) throw new ValidationError(`Field "${field}" cannot be modified via admin request`);
      const user = await userRepository.findByUsername(targetUsername);
      if (!user) throw new NotFoundError(`User "${targetUsername}" not found`);
      await userService.update(user.id, { [field]: newValue }, ctx);
      return { username: targetUsername, message: `User "${targetUsername}" updated (${field}).` };
    }

    default:
      throw new ValidationError(`Unknown request type: ${request.requestType}`);
  }
}

async function generateUniqueUsername(email: string): Promise<string> {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'user';
  let candidate = base;
  for (let i = 2; i < 200; i++) {
    const existing = await userRepository.findByUsername(candidate);
    if (!existing) return candidate;
    candidate = `${base}${i}`;
  }
  throw new ValidationError('Could not generate a unique username — please create user manually');
}

function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%&*';
  const all = upper + lower + digit + special;
  const chars = [
    upper[randomInt(0, upper.length)],
    lower[randomInt(0, lower.length)],
    digit[randomInt(0, digit.length)],
    special[randomInt(0, special.length)],
  ];
  for (let i = 0; i < 10; i++) chars.push(all[randomInt(0, all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function formatRequestType(type: string): string {
  switch (type) {
    case 'CREATE_USER': return 'Create User';
    case 'MODIFY_USER': return 'Modify User';
    case 'UNLOCK': return 'Unlock Account';
    case 'FORGOT_PASSWORD': return 'Forgot Password';
    default: return type;
  }
}
