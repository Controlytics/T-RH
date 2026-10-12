/**
 * Application review 2026-10-12, findings 11 and 13.
 *
 * 11 — `POST /api/auth/login` answered ACCOUNT_LOCKED / ACCOUNT_DISABLED /
 *      PASSWORD_EXPIRED BEFORE checking the password, so anyone could learn an
 *      account's state (and that it exists) without knowing its password. The
 *      password is checked first now; a WRONG password gets the one generic
 *      401 whatever the account's state — including the attempt that trips the
 *      lockout — and the state is told only to someone who proved the password.
 *      A wrong guess against an already-LOCKED / DISABLED / EXPIRED account does
 *      not move the counter (it would re-lock and re-notify on every guess).
 * 13 — `GET /api/auth/me` returned the permissions of an INACTIVE role, while
 *      the backend grants an inactive role nothing; the shell showed menus that
 *      403 on every click.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateUserAuthCache } from '../plugins/auth.js';

const S = Date.now().toString(36).toLowerCase();
const PW = 'Right0@Password';
const WRONG = 'Wrong0@Password';
const ROLE = `LSO_${S.toUpperCase()}`;
const users: string[] = [];
let app: FastifyInstance;

async function makeUser(suffix: string, data: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      username: `lso${S}${suffix}`, fullName: 'Login probe', role: 'OPERATOR', status: 'ENABLED',
      passwordHash: await hashPassword(PW), passwordChangedAt: new Date(),
      isTemporaryPassword: false, forcePasswordChange: false, ...data,
    },
  });
  users.push(u.id);
  return u;
}
const login = (username: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

let generic: { status: number; body: unknown };

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: ROLE, displayName: ROLE, hierarchyLevel: 2, permissions: ['AUDIT_READ', 'USER_READ'], isActive: true } });
  invalidateRolePermsCache(ROLE);
  const unknown = await login(`nobody-${S}`, WRONG);
  generic = { status: unknown.statusCode, body: unknown.json() };
});

afterAll(async () => {
  try {
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.role.deleteMany({ where: { name: ROLE } });
  } finally { invalidateRolePermsCache(ROLE); }
  await app.close();
});

describe('finding 11 — a wrong password is answered the same whatever the account state', () => {
  it('the baseline is the generic 401 for an unknown user', () => {
    expect(generic.status).toBe(401);
    expect(generic.body).toMatchObject({ error: 'INVALID_CREDENTIALS' });
  });

  it('DISABLED + wrong password = the generic 401; right password = ACCOUNT_DISABLED', async () => {
    const u = await makeUser('d', { status: 'DISABLED' });
    const wrong = await login(u.username, WRONG);
    expect(wrong.statusCode).toBe(generic.status);
    expect(wrong.json()).toEqual(generic.body);
    const right = await login(u.username, PW);
    expect(right.statusCode).toBe(403);
    expect(right.json().error).toBe('ACCOUNT_DISABLED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe('DISABLED');
  });

  it('LOCKED + wrong password = the generic 401 and the counter does not move', async () => {
    const u = await makeUser('l', { status: 'LOCKED', failedLoginAttempts: 5, lockedAt: new Date(), lockoutUntil: new Date(Date.now() + 3600_000) });
    const wrong = await login(u.username, WRONG);
    expect(wrong.statusCode).toBe(generic.status);
    expect(wrong.json()).toEqual(generic.body);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.failedLoginAttempts).toBe(5);
    expect(after.lockoutUntil?.getTime()).toBe(u.lockoutUntil?.getTime());
    const right = await login(u.username, PW);
    expect(right.statusCode).toBe(403);
    expect(right.json().error).toBe('ACCOUNT_LOCKED');
  });

  it('EXPIRED + wrong password = the generic 401; right password = PASSWORD_EXPIRED', async () => {
    const u = await makeUser('e', { status: 'EXPIRED', isTemporaryPassword: false, forcePasswordChange: false });
    const wrong = await login(u.username, WRONG);
    expect(wrong.statusCode).toBe(generic.status);
    expect(wrong.json()).toEqual(generic.body);
    const right = await login(u.username, PW);
    expect(right.statusCode).toBe(403);
    expect(right.json().error).toBe('PASSWORD_EXPIRED');
  });

  it('the guess that TRIPS the lockout is the generic 401 too — and the account IS locked', async () => {
    const policy = await prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
    const max = ((policy?.configValue as { maxFailedAttempts?: number } | null)?.maxFailedAttempts) ?? 5;
    const u = await makeUser('t', { failedLoginAttempts: max - 1 });
    const res = await login(u.username, WRONG);
    expect(res.statusCode).toBe(generic.status);
    expect(res.json()).toEqual(generic.body);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe('LOCKED');
  });

  it('an ENABLED account with the right password still logs in (positive control)', async () => {
    const u = await makeUser('ok');
    const res = await login(u.username, PW);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().token).toBeTruthy();
  });
});

describe('finding 13 — /api/auth/me grants an inactive role nothing', () => {
  it('permissions are [] once the role is switched off', async () => {
    const u = await makeUser('me', { role: ROLE });
    const res = await login(u.username, PW);
    expect(res.statusCode, res.body).toBe(200);
    const auth = { authorization: `Bearer ${res.json().token}` };
    const active = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
    expect(active.json().permissions).toEqual(expect.arrayContaining(['AUDIT_READ']));

    await prisma.role.update({ where: { name: ROLE }, data: { isActive: false } });
    invalidateRolePermsCache(ROLE);
    invalidateUserAuthCache(u.id);
    const inactive = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
    expect(inactive.statusCode, inactive.body).toBe(200);
    expect(inactive.json().permissions).toEqual([]);
  });
});
