import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

/**
 * GET /api/notification-rules/recipient-users — the Notification Rules page's
 * USER recipient picker.
 *
 * The page read `/api/users`, which needs USER_READ, so an administrator who may
 * manage notification rules but not users got an EMPTY picker and could not name a
 * person as a recipient. This narrow route is gated like rule management
 * (CONFIG_UPDATE) and returns only what a picker needs — id, username, display
 * name — of ENABLED users, hiding the accounts `GET /api/users` hides from the
 * caller (`hiddenRolesFor`: SUPER_ADMIN and ADMIN from lower roles).
 */

const S = `${Date.now()}`;
const ROLE_CFG = `NRU_CFG_${S}`.slice(0, 50);
const ROLE_NONE = `NRU_NONE_${S}`.slice(0, 50);
const PASSWORD = 'NruTest@12345';
const U = {
  cfg: `nru_cfg_${S}`.slice(0, 50),
  none: `nru_none_${S}`.slice(0, 50),
  enabled: `nru_on_${S}`.slice(0, 50),
  disabled: `nru_off_${S}`.slice(0, 50),
  admin: `nru_adm_${S}`.slice(0, 50),
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: ROLE_CFG, displayName: 'NRU cfg', hierarchyLevel: 2, permissions: ['CONFIG_READ', 'CONFIG_UPDATE'] } });
  await prisma.role.create({ data: { name: ROLE_NONE, displayName: 'NRU none', hierarchyLevel: 1, permissions: ['CONFIG_READ'] } });
  invalidateRolePermsCache();
  const { hashPassword } = await import('../lib/password.js');
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (username: string, role: string, status: 'ENABLED' | 'DISABLED' = 'ENABLED') => prisma.user.create({
    data: {
      username, fullName: `Full ${username}`, email: `${username}@test.example`, passwordHash, role, status,
      forcePasswordChange: false, isTemporaryPassword: false,
    },
  });
  await mk(U.cfg, ROLE_CFG);
  await mk(U.none, ROLE_NONE);
  await mk(U.enabled, ROLE_NONE);
  await mk(U.disabled, ROLE_NONE, 'DISABLED');
  await mk(U.admin, 'ADMIN');
});

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { username: { in: Object.values(U) } }, select: { id: true } });
  await prisma.session.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await prisma.user.deleteMany({ where: { username: { in: Object.values(U) } } });
  await prisma.role.deleteMany({ where: { name: { in: [ROLE_CFG, ROLE_NONE] } } });
  invalidateRolePermsCache();
  await app.close();
});

const get = (token: string) => app.inject({
  method: 'GET', url: '/api/notification-rules/recipient-users', headers: { authorization: `Bearer ${token}` },
});

describe('notification-rules recipient users', () => {
  it('a rule manager WITHOUT USER_READ gets the enabled users, picker fields only', async () => {
    const token = await loginAs(app, U.cfg, PASSWORD);
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Record<string, unknown>[];
    const names = data.map((u) => u.username);
    expect(names).toContain(U.enabled);
    expect(names).not.toContain(U.disabled);
    const row = data.find((u) => u.username === U.enabled)!;
    expect(Object.keys(row).sort()).toEqual(['fullName', 'id', 'username']);
    expect(row.fullName).toBe(`Full ${U.enabled}`);
  });

  it('hides the accounts GET /api/users hides from the caller (SUPER_ADMIN, ADMIN)', async () => {
    const token = await loginAs(app, U.cfg, PASSWORD);
    const data = (await get(token)).json().data as { username: string }[];
    expect(data.map((u) => u.username)).not.toContain(U.admin);
    const supers = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { username: true } });
    for (const s of supers) expect(data.map((u) => u.username)).not.toContain(s.username);
  });

  it('a SUPER_ADMIN sees ADMIN accounts too', async () => {
    const token = await loginAs(app);
    const data = (await get(token)).json().data as { username: string }[];
    expect(data.map((u) => u.username)).toContain(U.admin);
  });

  it('is refused without the rule-management permission', async () => {
    const token = await loginAs(app, U.none, PASSWORD);
    expect((await get(token)).statusCode).toBe(403);
  });
});
