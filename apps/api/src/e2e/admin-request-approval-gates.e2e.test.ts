/**
 * Application review 2026-10-12, findings 1 and 9.
 *
 * 1 — approving an admin request performed the underlying user mutation
 * (create / unlock / reset password / update / enable / disable) behind
 * ADMIN_REQUEST_APPROVE alone. A role holding ONLY that permission could
 * approve a FORGOT_PASSWORD for a peer and be handed the temporary password —
 * a credential reset its role was never granted, with no USER_RESET_PASSWORD
 * and no RESET_PASSWORD e-signature. Approval now also requires the
 * permission the underlying action requires (same resolver as the route
 * gates) and the underlying action's re-auth.
 *
 * 9 — a public CREATE_USER request could ask for SUPER_ADMIN; a SUPER_ADMIN
 * approver then created a SUPER_ADMIN from an anonymous form. Refused, as
 * MODIFY_USER already refuses it.
 *
 * Fixtures are a throwaway custom role (level 4, above the OPERATOR victims so
 * the hierarchy rule never refuses for the wrong reason) and throwaway users.
 * Requests are inserted with Prisma: the public POST is rate-limited 5/15 min.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

const S = Date.now().toString(36).toUpperCase();
const ROLE = `ARG_${S}`;
const APPROVER = `arg${S}a`.toLowerCase();
const PW = 'Appr0ver@Pass';
const requests: string[] = [];
const users: string[] = [];
const newNames: string[] = [];

/** A User ID the seeded User ID policy accepts (4 digits) that nobody holds. */
async function freeUserId(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = String(9000 + Math.floor(Math.random() * 1000));
    if (!newNames.includes(id) && (await prisma.user.count({ where: { username: id } })) === 0) {
      newNames.push(id);
      return id;
    }
  }
  throw new Error('fixture: no free 4-digit user id');
}

let app: FastifyInstance;
let approver: Record<string, string>;
let superAdmin: Record<string, string>;
let originalReauthRow: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;

async function makeUser(username: string, role: string, password = 'Victim@Pass1', status: 'ENABLED' | 'LOCKED' | 'DISABLED' = 'ENABLED') {
  const u = await prisma.user.create({
    data: {
      username, fullName: username, role, status,
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
    },
  });
  users.push(u.id);
  return u;
}

async function makeRequest(requestType: string, requestData: Record<string, unknown>) {
  const r = await prisma.adminRequest.create({
    data: {
      requestType, requesterName: 'e2e', requesterEmployeeId: `e2e-${S}`,
      requestData: requestData as never, status: 'PENDING',
    },
  });
  requests.push(r.id);
  return r.id;
}

async function setRolePerms(perms: string[]) {
  await prisma.role.update({ where: { name: ROLE }, data: { permissions: perms } });
  invalidateRolePermsCache(ROLE);
}

async function setReauthPolicy(policy: Record<string, string[]>) {
  await prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: policy as never },
    create: { configKey: 'action-reauth', configValue: policy as never, configType: 'security', requiresReauth: false },
  });
  invalidateReauthCache();
}

const approve = (id: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: `/api/admin-requests/${id}/process`, headers, payload: { action: 'approve', adminRemarks: 'e2e' } });

beforeAll(async () => {
  app = await buildApp();
  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  if (existing) originalReauthRow = { configValue: existing.configValue, configType: existing.configType, requiresReauth: existing.requiresReauth };
  await setReauthPolicy({});

  await prisma.role.create({
    data: { name: ROLE, displayName: `ARG ${S}`, hierarchyLevel: 4, permissions: ['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT'], isSystem: false },
  });
  invalidateRolePermsCache(ROLE);
  await makeUser(APPROVER, ROLE, PW);
  approver = { authorization: `Bearer ${await loginAs(app, APPROVER, PW)}` };
  superAdmin = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  try {
    if (originalReauthRow) await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauthRow as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
  } finally {
    invalidateReauthCache();
  }
  try { await prisma.adminRequest.deleteMany({ where: { id: { in: requests } } }); } catch { /* best effort */ }
  try {
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.passwordHistory.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.passwordHistory.deleteMany({ where: { user: { username: { in: newNames } } } });
    await prisma.user.deleteMany({ where: { username: { in: newNames } } });
  } catch { /* best effort */ }
  try { await prisma.role.deleteMany({ where: { name: ROLE } }); } finally { invalidateRolePermsCache(ROLE); }
  await app.close();
});

describe('approving an admin request requires the underlying action\'s permission', () => {
  it('FORGOT_PASSWORD: ADMIN_REQUEST_APPROVE alone is 403, no password issued, request stays PENDING', async () => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT']);
    const victim = await makeUser(`arg${S}v1`.toLowerCase(), 'OPERATOR');
    const id = await makeRequest('FORGOT_PASSWORD', { username: victim.username });

    const res = await approve(id, approver);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().temporaryPassword).toBeUndefined();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.passwordHash).toBe(victim.passwordHash);
    expect((await prisma.adminRequest.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
  });

  it('FORGOT_PASSWORD: with USER_RESET_PASSWORD granted the approval goes through (positive control)', async () => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'USER_RESET_PASSWORD']);
    const victim = await makeUser(`arg${S}v2`.toLowerCase(), 'OPERATOR');
    const id = await makeRequest('FORGOT_PASSWORD', { username: victim.username });
    const res = await approve(id, approver);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().temporaryPassword).toBeTruthy();
  });

  it.each([
    ['UNLOCK', 'USER_UNLOCK'],
    ['DISABLE_ACCOUNT', 'USER_ENABLE_DISABLE'],
    ['ENABLE_ACCOUNT', 'USER_ENABLE_DISABLE'],
  ])('%s: refused 403 without %s, and the account is untouched', async (type) => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT']);
    const status = type === 'UNLOCK' ? 'LOCKED' : type === 'ENABLE_ACCOUNT' ? 'DISABLED' : 'ENABLED';
    const victim = await makeUser(`arg${S}${type.slice(0, 2)}`.toLowerCase(), 'OPERATOR', 'Victim@Pass1', status);
    const id = await makeRequest(type, { username: victim.username });
    const res = await approve(id, approver);
    expect(res.statusCode, res.body).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).status).toBe(status);
  });

  it('MODIFY_USER: refused 403 without USER_UPDATE', async () => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT']);
    const victim = await makeUser(`arg${S}mu`.toLowerCase(), 'OPERATOR');
    const id = await makeRequest('MODIFY_USER', { username: victim.username, modifyField: 'fullName', newValue: 'Renamed' });
    const res = await approve(id, approver);
    expect(res.statusCode, res.body).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).fullName).toBe(victim.fullName);
  });

  it('MODIFY_USER of status needs USER_ENABLE_DISABLE, not USER_UPDATE — and goes through the disable path', async () => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'USER_UPDATE']);
    const victim = await makeUser(`arg${S}ms`.toLowerCase(), 'OPERATOR');
    const id = await makeRequest('MODIFY_USER', { username: victim.username, modifyField: 'status', newValue: 'DISABLED' });
    const refused = await approve(id, approver);
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).status).toBe('ENABLED');

    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'USER_ENABLE_DISABLE']);
    const ok = await approve(id, approver);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).status).toBe('DISABLED');
    // The disable path writes USER_DISABLED with a reason, not a bare USER_UPDATED.
    const row = await prisma.auditTrail.findFirst({ where: { action: 'USER_DISABLED', targetId: victim.id }, orderBy: { timestamp: 'desc' } });
    expect(row?.reason).toMatch(/Approved admin request/);
  });

  it('CREATE_USER: refused 403 without USER_CREATE, no account created', async () => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT']);
    const username = await freeUserId();
    const id = await makeRequest('CREATE_USER', { username, fullName: 'New Person', requestedRole: 'OPERATOR' });
    const res = await approve(id, approver);
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.user.count({ where: { username } })).toBe(0);
  });

  it('the hierarchy rule still applies: an approver cannot reset a user above its own level', async () => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'USER_RESET_PASSWORD']);
    const victim = await makeUser(`arg${S}hi`.toLowerCase(), 'ADMIN');
    const id = await makeRequest('FORGOT_PASSWORD', { username: victim.username });
    const res = await approve(id, approver);
    expect(res.statusCode, res.body).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).passwordHash).toBe(victim.passwordHash);
  });

  it('REJECT keeps its own gate: ADMIN_REQUEST_REJECT alone may reject anything', async () => {
    await setRolePerms(['ADMIN_REQUEST_REJECT']);
    const victim = await makeUser(`arg${S}rj`.toLowerCase(), 'OPERATOR');
    const id = await makeRequest('FORGOT_PASSWORD', { username: victim.username });
    const res = await app.inject({ method: 'POST', url: `/api/admin-requests/${id}/process`, headers: approver, payload: { action: 'reject', adminRemarks: 'no' } });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('approving an admin request requires the underlying action\'s e-signature', () => {
  it('RESET_PASSWORD re-auth switched on for the role: approval without a password is 401 REAUTH_REQUIRED', async () => {
    await setRolePerms(['ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'USER_RESET_PASSWORD']);
    await setReauthPolicy({ RESET_PASSWORD: [ROLE] });
    try {
      const victim = await makeUser(`arg${S}ra`.toLowerCase(), 'OPERATOR');
      const id = await makeRequest('FORGOT_PASSWORD', { username: victim.username });
      const refused = await approve(id, approver);
      expect(refused.statusCode, refused.body).toBe(401);
      expect(refused.json().error).toBe('REAUTH_REQUIRED');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).passwordHash).toBe(victim.passwordHash);

      const signed = await app.inject({
        method: 'POST', url: `/api/admin-requests/${id}/process`,
        headers: { ...approver, 'x-reauth-password': PW },
        payload: { action: 'approve', adminRemarks: 'e2e' },
      });
      expect(signed.statusCode, signed.body).toBe(200);
    } finally {
      await setReauthPolicy({});
    }
  });
});

describe('a public CREATE_USER request cannot ask for SUPER_ADMIN', () => {
  it('even a SUPER_ADMIN approver is refused 403 and nothing is created', async () => {
    const username = await freeUserId();
    const id = await makeRequest('CREATE_USER', { username, fullName: 'Wannabe', requestedRole: 'SUPER_ADMIN' });
    const res = await approve(id, superAdmin);
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.user.count({ where: { username } })).toBe(0);
    expect((await prisma.adminRequest.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
  });

  it('lower-case spelling is refused the same way', async () => {
    const username = await freeUserId();
    const id = await makeRequest('CREATE_USER', { username, fullName: 'Wannabe', requestedRole: ' super_admin ' });
    const res = await approve(id, superAdmin);
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.user.count({ where: { username } })).toBe(0);
  });
});

