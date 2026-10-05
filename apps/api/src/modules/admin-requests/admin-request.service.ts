import { randomInt } from 'node:crypto';
import { updateUserSchema } from '@digilog/shared';
import { auditLog } from '../../lib/audit.js';
// The SHARED client (audit 2026-10-03, API-20). This file opened a second
// `new PrismaClient()` — a second connection pool — so the claim/revert below
// ran on different connections from `auditLog`'s, and nothing here could ever
// share a transaction with the rest of the app.
import { prisma } from '../../lib/prisma.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../lib/errors.js';
import { userService } from '../users/user.service.js';
import { userRepository } from '../users/user.repository.js';
import type { RequestContext } from '../../types/context.js';
import { describeTarget, targetFromRequestData, requesterLabel, requestRecordName } from './describe-request.js';
import { decideAccountState, type AccountStatus, type StateRequestType } from './account-state.js';

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

    /**
     * Audit log. No `userId` — this is a PUBLIC endpoint and nobody has
     * authenticated; the requester's own employee ID is what identifies them, and
     * it is not a verified identity. The approval record's `by` is.
     *
     * The record names the TARGET account and its role, not only the requester
     * (operator, 2026-09-02) — see describe-request.ts for what was wrong.
     */
    const asked = requesterLabel(request);
    // Role is whatever the request itself carries: CREATE_USER names the role
    // being asked for. For the other types it is not in `requestData`, and this
    // endpoint deliberately does NOT look it up — see the enumeration-oracle note
    // in account-state.ts. The approval record fills it in, where the caller is
    // authenticated.
    const target = describeTarget(targetFromRequestData(request.requestData));
    const submittedName = requestRecordName({
      operation: formatRequestType(request.requestType),
      target,
      requester: asked,
    });
    await auditLog({
      // NO `userId` (audit 2026-10-03, API-6): this is the PUBLIC endpoint and
      // the employee id is whatever the caller typed — stamping it into the
      // hash-chained trail's actor column attributed a row to "superadmin" on
      // an anonymous POST. The action is a SYSTEM action (no actor); the
      // typed id is recorded as DATA in `afterValue.requesterEmployeeId`.
      userId: undefined,
      action: 'ADMIN_REQUEST_SUBMITTED',
      targetType: 'admin_request',
      targetId: request.id,
      afterValue: {
        name: submittedName,
        requestType: request.requestType,
        requesterName: request.requesterName,
        requesterEmployeeId: request.requesterEmployeeId,
        // The target, stored as its own fields as well as inside `name`, so a
        // reader can filter on it without parsing a sentence.
        targetUsername: targetFromRequestData(request.requestData).username || null,
        targetRole: targetFromRequestData(request.requestData).role || null,
      },
      reason: `${formatRequestType(request.requestType)} request submitted by ${asked}`,
      signatureMeaning: `Admin request (${formatRequestType(request.requestType)}) submitted by ${asked}`,
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

    /**
     * ONE transaction: claim, act, record (audit 2026-10-03, API-7).
     *
     * The CLAIM is a conditional update on `status = PENDING`. The PENDING check
     * above is a check-then-act with no lock: two admins clicking Approve within
     * the same moment both passed it, and both ran executeApproval, issuing TWO
     * temp passwords for one FORGOT_PASSWORD request. Under the row lock the
     * claim takes, the second admin's update waits, then matches zero rows and
     * stops before any side effect.
     *
     * The claim used to be committed on its own, the side effects run, and
     * the audit row written last and standalone — so a failed audit insert
     * left an APPROVED request with no record of who approved it, and a
     * failed side effect needed a hand-written revert of the claim. Now the
     * decision and its audit row commit together, and a throw anywhere rolls
     * the claim back, which IS the "leave it PENDING for a retry" contract.
     *
     * The side effects (`executeApproval` → userService.create / unlock /
     * disable / resetPassword) each run their own transactions on the shared
     * client, with their own audit rows; they are not undone by a rollback
     * here — the same as before — and they take the audit advisory lock only
     * inside their own transactions, so they cannot deadlock against the one
     * this transaction takes last. The budget is raised because a CREATE_USER
     * approval hashes a password inside it.
     */
    const asked = requesterLabel(request);
    const { updated, actionOutcome } = await prisma.$transaction(async (tx) => {
      const claimed = await tx.adminRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: newStatus,
          adminRemarks: adminRemarks ? stripHtml(adminRemarks) : null,
          processedBy: ctx.userId,
          processedAt: new Date(),
        },
      });
      if (claimed.count === 0) throw new ValidationError('Request has already been processed');

      let actionOutcome: {
        username?: string; temporaryPassword?: string; message?: string;
        /** False when the account was ALREADY in the state asked for, so nothing was
         *  changed. Carried out to the caller so the approval dialog can say so, and
         *  used below to keep that fact in the §11 record. */
        changed?: boolean; targetRole?: string;
      } = {};
      if (action === 'approve') {
        actionOutcome = await executeApproval(request, ctx, adminRemarks);
      }

      const updated = await tx.adminRequest.findUniqueOrThrow({ where: { id } });

      /**
       * Audit log.
       *
       * `userId: ctx.userId` is the VERIFIED identity — the admin who re-authenticated
       * to get here — and it is what `{actor}` renders as "by ...". The requester's ID
       * lives in the description instead. They are different people (operator's own
       * example: requested by 101020, approved by 101010) and this record has to keep
       * them apart.
       */
      // The role is known NOW in a way it was not at submission: `executeApproval`
      // loaded the target user. It falls back to whatever `requestData` carries.
      const targetParts = targetFromRequestData(request.requestData, actionOutcome.targetRole);
      const target = describeTarget(targetParts);
      const processedName = requestRecordName({
        operation: formatRequestType(request.requestType),
        target,
        requester: asked,
      });
      // A no-op approval must not read like an act. `actionOutcome.message` is the
      // one sentence that says what was actually found — see account-state.ts.
      const noop = action === 'approve' && actionOutcome.changed === false;
      await auditLog({
        userId: ctx.userId,
        userRole: ctx.userRole,
        action: action === 'approve' ? 'ADMIN_REQUEST_APPROVED' : 'ADMIN_REQUEST_REJECTED',
        targetType: 'admin_request',
        targetId: id,
        beforeValue: {
          name: processedName, status: 'PENDING',
          requesterEmployeeId: request.requesterEmployeeId,
          targetUsername: targetParts.username || null, targetRole: targetParts.role || null,
        },
        afterValue: {
          name: processedName, status: newStatus, adminRemarks,
          requesterEmployeeId: request.requesterEmployeeId,
          targetUsername: targetParts.username || null, targetRole: targetParts.role || null,
          // Recorded explicitly rather than inferred from the message text: whether
          // an approval changed anything is a fact about the system, and a later
          // reader must not have to parse a sentence to learn it.
          stateChanged: action === 'approve' ? actionOutcome.changed !== false : undefined,
          outcome: actionOutcome.message ?? undefined,
        },
        reason: noop
          ? `${formatRequestType(request.requestType)} request approved, no change made — ${actionOutcome.message} — ${adminRemarks}`
          : `${formatRequestType(request.requestType)} request ${newStatus.toLowerCase()} — ${adminRemarks}`,
        signatureMeaning: noop
          ? `Admin request (${formatRequestType(request.requestType)}) approved by admin — no change made`
          : `Admin request (${formatRequestType(request.requestType)}) ${newStatus.toLowerCase()} by admin`,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        sessionId: ctx.sessionId,
      }, tx);

      return { updated, actionOutcome };
    }, { timeout: 30_000 });

    return { ...updated, ...actionOutcome };
  },
};

async function executeApproval(
  request: { id: string; requestType: string; requestData: unknown; requesterName: string; requesterEmail: string | null },
  ctx: RequestContext,
  adminRemarks: string,
): Promise<{
  username?: string; temporaryPassword?: string; message?: string;
  changed?: boolean; targetRole?: string;
}> {
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
      return { username, temporaryPassword, message: `User "${username}" created.`, changed: true, targetRole: requestedRole };
    }

    /**
     * UNLOCK / ENABLE_ACCOUNT / DISABLE_ACCOUNT — the three that change an
     * account's STATE, and the three that must first check whether it is already
     * in that state (operator, 2026-09-02).
     *
     * One branch for all three because the shape is identical and the decision is
     * `decideAccountState`'s alone; splitting them is how one of them ends up
     * without the guard. **The guard runs BEFORE the state-changing call**, which
     * is the whole point: `userService.unlock/enable/disable` each write their own
     * `ACCOUNT_*` audit row, so calling one for an account already in that state
     * writes a §11 record asserting an act that did not happen.
     */
    case 'UNLOCK':
    case 'ENABLE_ACCOUNT':
    case 'DISABLE_ACCOUNT': {
      const targetUsername = String(data.username ?? '').trim();
      if (!targetUsername) throw new ValidationError('Request is missing username');
      const user = await userRepository.findByUsername(targetUsername);
      if (!user) throw new NotFoundError(`User "${targetUsername}" not found`);

      const decision = decideAccountState(
        request.requestType as StateRequestType,
        (user as { status: AccountStatus }).status,
        targetUsername,
      );
      // The role the audit record will name. Read here because this is the one
      // place the target user is loaded under an authenticated caller.
      const targetRole = (user as { role?: string }).role ?? undefined;

      if (!decision.apply) {
        // Nothing is called, so nothing is audited as done. The approval's own
        // record carries `stateChanged: false` and the message.
        return { username: targetUsername, message: decision.message, changed: false, targetRole };
      }

      if (request.requestType === 'UNLOCK') {
        // A temporary password is issued ONLY on a real unlock. Handing one out
        // for an account that was not locked would be a credential change nobody
        // asked for.
        const temporaryPassword = generateTempPassword();
        await userService.unlock(user.id, temporaryPassword, ctx);
        return { username: targetUsername, temporaryPassword, message: decision.message, changed: true, targetRole };
      }
      if (request.requestType === 'ENABLE_ACCOUNT') {
        await userService.enable(user.id, ctx);
      } else {
        // A disable needs the operator's reason (DATA-11). Here it is the
        // approved request itself, with the admin's remarks when given.
        const why = `Approved admin request ${request.id} (Disable Account) from ${requesterLabel(request)}`
          + (adminRemarks.trim() ? `: ${adminRemarks.trim()}` : '');
        await userService.disable(user.id, ctx, why);
      }
      return { username: targetUsername, message: decision.message, changed: true, targetRole };
    }

    case 'FORGOT_PASSWORD': {
      const targetUsername = String(data.username ?? '').trim();
      if (!targetUsername) throw new ValidationError('Request is missing username');
      const user = await userRepository.findByUsername(targetUsername);
      if (!user) throw new NotFoundError(`User "${targetUsername}" not found`);
      const temporaryPassword = generateTempPassword();
      await userService.resetPassword(user.id, temporaryPassword, ctx);
      return {
        username: targetUsername, temporaryPassword,
        message: `Password reset for "${targetUsername}".`,
        changed: true, targetRole: (user as { role?: string }).role ?? undefined,
      };
    }

    case 'MODIFY_USER': {
      const targetUsername = String(data.username ?? '').trim();
      const field = String(data.modifyField ?? '').trim();
      const newValue = data.newValue;
      if (!targetUsername) throw new ValidationError('Request is missing username');
      if (!field) throw new ValidationError('Request is missing modifyField');
      const allowed = new Set(['fullName', 'email', 'department', 'role', 'status']);
      if (!allowed.has(field)) throw new ValidationError(`Field "${field}" cannot be modified via admin request`);
      // `newValue` arrived UNTYPED on the public form (audit 2026-10-03,
      // API-20): the authenticated route runs the body through
      // `updateUserSchema` before `userService.update`, this path did not —
      // so a `status` of "ANYTHING" or a numeric `role` went straight to
      // Prisma. Same schema, same refusal.
      const typed = updateUserSchema.safeParse({ [field]: newValue });
      if (!typed.success) {
        throw new ValidationError(`Requested ${field} is not valid`, typed.error.flatten());
      }
      // A public form may not ask for SUPER_ADMIN, whoever approves it:
      // `userService.update` lets a SUPER_ADMIN approver assign SUPER_ADMIN
      // (same level, so the hierarchy rule passes). Promotion to the top role
      // is done by a super admin on the Users page, in their own name — never
      // by rubber-stamping an anonymous request. A role above the approver is
      // refused by `userService.update` itself (403).
      if (field === 'role' && String(newValue).trim().toUpperCase() === 'SUPER_ADMIN') {
        throw new ForbiddenError('An admin request cannot assign the SUPER_ADMIN role');
      }
      const user = await userRepository.findByUsername(targetUsername);
      if (!user) throw new NotFoundError(`User "${targetUsername}" not found`);
      await userService.update(user.id, typed.data as Record<string, unknown>, ctx);
      return {
        username: targetUsername,
        message: `User "${targetUsername}" updated (${field}).`,
        changed: true, targetRole: (user as { role?: string }).role ?? undefined,
      };
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
    case 'ENABLE_ACCOUNT': return 'Enable Account';
    case 'DISABLE_ACCOUNT': return 'Disable Account';
    default: return type;
  }
}
