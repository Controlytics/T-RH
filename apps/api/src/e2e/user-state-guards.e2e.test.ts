/**
 * Application review 2026-10-12, findings 3, 4, 8 (user side) and 12.
 *
 * 3 — an admin password reset, an unlock, or an approved reset request wrote
 *     `status: 'ENABLED'` unconditionally, silently re-enabling a DISABLED
 *     account; forgot-password filed requests for disabled accounts.
 * 4 — `PUT /api/users/:id` accepted `status`, so USER_UPDATE alone could
 *     disable or re-enable an account with no reason and no USER_DISABLED row.
 * 8 — the user checks compared hierarchy NUMBERS only, so a custom role sitting
 *     at or above SUPER_ADMIN's level could manage a SUPER_ADMIN account.
 * 12 — `GET /api/users/:id` returned accounts the list hides from the caller.
 *
 * Fixtures: throwaway roles and users, cleaned up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { authService } from '../modules/auth/auth.service.js';

const S = Date.now().toString(36).toUpperCase();
const MID = `USG_MID_${S}`;      // level 3, a normal custom manager role
const HIGH = `USG_HIGH_${S}`;    // level 7: a legacy row ABOVE SUPER_ADMIN's 6
const PW = 'Mgr0@Passw0rd';
const NEWPW = 'Tmp0@Passw0rd!';
const users: string[] = [];
const MANAGE = ['USER_READ', 'USER_UPDATE', 'USER_UNLOCK', 'USER_RESET_PASSWORD', 'USER_ENABLE_DISABLE', 'USER_CREATE'];

let app: FastifyInstance;
let sa: Record<string, string>;
let mid: Record<string, string>;
let high: Record<string, string>;

async function makeUser(username: string, role: string, status: 'ENABLED' | 'LOCKED' | 'DISABLED' = 'ENABLED', password = 'Victim@Pass1') {
  const u = await prisma.user.create({
    data: { username, fullName: username, role, status, passwordHash: await hashPassword(password), passwordChangedAt: new Date() },
  });
  users.push(u.id);
  return u;
}
const statusOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: MID, displayName: `USG mid ${S}`, hierarchyLevel: 3, permissions: MANAGE, isSystem: false } });
  await prisma.role.create({ data: { name: HIGH, displayName: `USG high ${S}`, hierarchyLevel: 7, permissions: MANAGE, isSystem: false } });
  invalidateRolePermsCache();
  await makeUser(`usg${S}m`.toLowerCase(), MID, 'ENABLED', PW);
  await makeUser(`usg${S}h`.toLowerCase(), HIGH, 'ENABLED', PW);
  sa = { authorization: `Bearer ${await loginAs(app)}` };
  mid = { authorization: `Bearer ${await loginAs(app, `usg${S}m`.toLowerCase(), PW)}` };
  high = { authorization: `Bearer ${await loginAs(app, `usg${S}h`.toLowerCase(), PW)}` };
});

afterAll(async () => {
  try {
    await prisma.passwordResetRequest.deleteMany({ where: { userId: { in: users } } });
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } catch { /* best effort */ }
  try { await prisma.role.deleteMany({ where: { name: { in: [MID, HIGH, `USG_TOP_${S}`] } } }); } finally { invalidateRolePermsCache(); }
  await app.close();
});

describe('finding 4 — PUT /api/users/:id does not change status', () => {
  it('a status in the body is 400 and the account is untouched', async () => {
    const v = await makeUser(`usg${S}p1`.toLowerCase(), 'OPERATOR');
    const res = await app.inject({ method: 'PUT', url: `/api/users/${v.id}`, headers: sa, payload: { status: 'DISABLED' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(await statusOf(v.id)).toBe('ENABLED');
  });

  it('an ordinary edit still works', async () => {
    const v = await makeUser(`usg${S}p2`.toLowerCase(), 'OPERATOR');
    const res = await app.inject({ method: 'PUT', url: `/api/users/${v.id}`, headers: sa, payload: { fullName: 'Edited Name' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: v.id } })).fullName).toBe('Edited Name');
  });
});

describe('finding 3 — a reset or an unlock does not re-enable a DISABLED account', () => {
  it('admin reset-password on a DISABLED account leaves it DISABLED, and the audit row says so', async () => {
    const v = await makeUser(`usg${S}r1`.toLowerCase(), 'OPERATOR', 'DISABLED');
    const res = await app.inject({ method: 'POST', url: `/api/users/${v.id}/reset-password`, headers: sa, payload: { newPassword: NEWPW } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(v.id)).toBe('DISABLED');
    const row = await prisma.auditTrail.findFirst({ where: { action: 'PASSWORD_RESET', targetId: v.id }, orderBy: { timestamp: 'desc' } });
    expect((row?.afterValue as Record<string, unknown>)?.status).toBe('DISABLED');
  });

  it('admin reset-password on a LOCKED account still clears the lock (positive control)', async () => {
    const v = await makeUser(`usg${S}r2`.toLowerCase(), 'OPERATOR', 'LOCKED');
    const res = await app.inject({ method: 'POST', url: `/api/users/${v.id}/reset-password`, headers: sa, payload: { newPassword: NEWPW } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(v.id)).toBe('ENABLED');
  });

  it('unlock on a DISABLED account leaves it DISABLED', async () => {
    const v = await makeUser(`usg${S}u1`.toLowerCase(), 'OPERATOR', 'DISABLED');
    const res = await app.inject({ method: 'POST', url: `/api/users/${v.id}/unlock`, headers: sa, payload: { newPassword: NEWPW } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(v.id)).toBe('DISABLED');
    const row = await prisma.auditTrail.findFirst({ where: { action: 'ACCOUNT_UNLOCKED', targetId: v.id }, orderBy: { timestamp: 'desc' } });
    expect((row?.afterValue as Record<string, unknown>)?.status).toBe('DISABLED');
  });

  it('unlock on a LOCKED account enables it (positive control)', async () => {
    const v = await makeUser(`usg${S}u2`.toLowerCase(), 'OPERATOR', 'LOCKED');
    const res = await app.inject({ method: 'POST', url: `/api/users/${v.id}/unlock`, headers: sa, payload: { newPassword: NEWPW } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(v.id)).toBe('ENABLED');
  });

  it('an approved password-reset REQUEST on a DISABLED account leaves it DISABLED', async () => {
    const v = await makeUser(`usg${S}q1`.toLowerCase(), 'OPERATOR', 'DISABLED');
    const r = await prisma.passwordResetRequest.create({ data: { userId: v.id, status: 'PENDING' } });
    const res = await app.inject({
      method: 'POST', url: `/api/users/reset-requests/${r.id}/process`, headers: sa,
      payload: { action: 'approve', newPassword: NEWPW },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(v.id)).toBe('DISABLED');
  });

  it('forgot-password files NO request for a DISABLED account (and answers the same as for anyone)', async () => {
    const v = await makeUser(`usg${S}f1`.toLowerCase(), 'OPERATOR', 'DISABLED');
    const out = await authService.forgotPassword(v.username, '127.0.0.1', 'e2e');
    expect(out).toBeUndefined();
    expect(await prisma.passwordResetRequest.count({ where: { userId: v.id } })).toBe(0);
  });

  it('forgot-password still files a request for an ENABLED account (positive control)', async () => {
    const v = await makeUser(`usg${S}f2`.toLowerCase(), 'OPERATOR');
    await authService.forgotPassword(v.username, '127.0.0.1', 'e2e');
    expect(await prisma.passwordResetRequest.count({ where: { userId: v.id } })).toBe(1);
  });
});

describe('finding 8 — SUPER_ADMIN is protected by NAME, not only by hierarchy number', () => {
  it('a role numbered above SUPER_ADMIN cannot reset a SUPER_ADMIN password', async () => {
    const target = await makeUser(`usg${S}sa1`.toLowerCase(), 'SUPER_ADMIN');
    const res = await app.inject({ method: 'POST', url: `/api/users/${target.id}/reset-password`, headers: high, payload: { newPassword: NEWPW } });
    expect(res.statusCode, res.body).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).passwordHash).toBe(target.passwordHash);
  });

  it('a role numbered above SUPER_ADMIN cannot disable a SUPER_ADMIN', async () => {
    const target = await makeUser(`usg${S}sa2`.toLowerCase(), 'SUPER_ADMIN');
    const res = await app.inject({ method: 'POST', url: `/api/users/${target.id}/disable`, headers: high, payload: { reason: 'e2e' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(await statusOf(target.id)).toBe('ENABLED');
  });

  it('a role numbered above SUPER_ADMIN cannot assign SUPER_ADMIN to a user', async () => {
    const v = await makeUser(`usg${S}sa3`.toLowerCase(), 'OPERATOR');
    const res = await app.inject({ method: 'PUT', url: `/api/users/${v.id}`, headers: high, payload: { role: 'SUPER_ADMIN' } });
    expect(res.statusCode, res.body).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: v.id } })).role).toBe('OPERATOR');
  });

  it('SUPER_ADMIN cannot create a role numbered at or above its own level', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/roles', headers: sa,
      payload: { name: `USG_TOP_${S}`, displayName: 'Too high', hierarchyLevel: 7, permissions: [] },
    });
    expect([400, 403]).toContain(res.statusCode);
    expect(await prisma.role.count({ where: { name: `USG_TOP_${S}` } })).toBe(0);
  });

  it('SUPER_ADMIN cannot raise a custom role to SUPER_ADMIN\'s level', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/roles/${MID}`, headers: sa, payload: { hierarchyLevel: 6 } });
    expect([400, 403]).toContain(res.statusCode);
    expect((await prisma.role.findUniqueOrThrow({ where: { name: MID } })).hierarchyLevel).toBe(3);
  });
});

describe('finding 12 — GET /api/users/:id hides what the list hides', () => {
  it('a SUPER_ADMIN account is 404 to a non-SUPER_ADMIN caller', async () => {
    const target = await makeUser(`usg${S}g1`.toLowerCase(), 'SUPER_ADMIN');
    const res = await app.inject({ method: 'GET', url: `/api/users/${target.id}`, headers: mid });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('an ADMIN account is 404 to a caller below ADMIN', async () => {
    const target = await makeUser(`usg${S}g2`.toLowerCase(), 'ADMIN');
    const res = await app.inject({ method: 'GET', url: `/api/users/${target.id}`, headers: mid });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('a visible account is still returned (positive control), and SUPER_ADMIN sees everyone', async () => {
    const op = await makeUser(`usg${S}g3`.toLowerCase(), 'OPERATOR');
    expect((await app.inject({ method: 'GET', url: `/api/users/${op.id}`, headers: mid })).statusCode).toBe(200);
    const target = await makeUser(`usg${S}g4`.toLowerCase(), 'SUPER_ADMIN');
    expect((await app.inject({ method: 'GET', url: `/api/users/${target.id}`, headers: sa })).statusCode).toBe(200);
  });
});
