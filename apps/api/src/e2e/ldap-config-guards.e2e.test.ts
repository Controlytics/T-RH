/**
 * Application review 2026-10-12, findings 2 and 7.
 *
 * 2 — `POST /api/ldap/test-connection` merged the request body over the STORED
 *     config and bound with the result. A CONFIG_UPDATE holder could send only
 *     `serverUrl: ldap://their-host` and receive the stored service-account
 *     password in the clear (an LDAP simple bind carries it as-is). The stored
 *     password is now used only when the server URL and bind DN are the stored
 *     ones; otherwise the request must carry a password. The same rule now
 *     guards SAVE, which had the identical path (a changed serverUrl saved with
 *     the `********` mask kept the stored password, and the next login bound
 *     to the new host with it). The test is audited and takes the LDAP re-auth.
 *     LOW: the config page sends the mask for a saved password; on an
 *     unchanged target the mask now means "use stored" instead of being sent
 *     as the password.
 * 7 — LDAP `roleMappings` / `defaultRole` were writable by any CONFIG_UPDATE
 *     holder to any role, so a group the caller belongs to could be mapped to
 *     ADMIN. A non-SUPER_ADMIN may only target roles below its own level;
 *     mappings already stored are grandfathered.
 *
 * A plain TCP listener stands in for "the attacker's host": it records what
 * the client sends on bind and then hangs up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

const S = Date.now().toString(36).toUpperCase();
const MGR = `LG_MGR_${S}`;
const LOW = `LG_LOW_${S}`;
const PW = 'Mgr0@Passw0rd';
const STORED_SECRET = `stored-secret-${S}`;
const users: string[] = [];

let app: FastifyInstance;
let sa: Record<string, string>;
let mgr: Record<string, string>;
let trap: net.Server;
let trapPort = 0;
let captured: Buffer[] = [];
const rows: Record<string, { configValue: unknown; configType: string; requiresReauth: boolean } | null> = {};

const storedUrl = () => `ldap://127.0.0.1:${trapPort}`;
const STORED_DN = 'CN=svc,DC=corp,DC=local';
const capturedText = () => Buffer.concat(captured).toString('latin1');

async function setLdap(value: Record<string, unknown>) {
  await prisma.systemConfig.upsert({
    where: { configKey: 'ldap' },
    update: { configValue: value as never },
    create: { configKey: 'ldap', configValue: value as never, configType: 'security', requiresReauth: true },
  });
}
const storedLdap = async () =>
  (await prisma.systemConfig.findUniqueOrThrow({ where: { configKey: 'ldap' } })).configValue as Record<string, any>;

beforeAll(async () => {
  for (const key of ['ldap', 'action-reauth']) {
    const r = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    rows[key] = r ? { configValue: r.configValue, configType: r.configType, requiresReauth: r.requiresReauth } : null;
  }
  trap = net.createServer((sock) => {
    sock.on('data', (d) => { captured.push(d); sock.destroy(); });
  });
  await new Promise<void>((r) => trap.listen(0, '127.0.0.1', () => r()));
  trapPort = (trap.address() as net.AddressInfo).port;

  app = await buildApp();
  await prisma.role.create({ data: { name: MGR, displayName: MGR, hierarchyLevel: 3, permissions: ['CONFIG_READ', 'CONFIG_UPDATE'] } });
  await prisma.role.create({ data: { name: LOW, displayName: LOW, hierarchyLevel: 2, permissions: [] } });
  invalidateRolePermsCache();
  const u = await prisma.user.create({
    data: { username: `lg${S}m`.toLowerCase(), fullName: 'ldap mgr', role: MGR, status: 'ENABLED', passwordHash: await hashPassword(PW), passwordChangedAt: new Date() },
  });
  users.push(u.id);
  sa = { authorization: `Bearer ${await loginAs(app)}` };
  mgr = { authorization: `Bearer ${await loginAs(app, u.username, PW)}` };
});

afterAll(async () => {
  try {
    for (const key of ['ldap', 'action-reauth']) {
      const r = rows[key];
      if (r) await prisma.systemConfig.update({ where: { configKey: key }, data: r as never });
      else await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    }
  } finally {
    invalidateReauthCache();
  }
  try {
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.role.deleteMany({ where: { name: { in: [MGR, LOW] } } });
  } finally { invalidateRolePermsCache(); }
  trap?.close();
  await app.close();
});

const baseStored = () => ({
  enabled: false, serverUrl: storedUrl(), bindDN: STORED_DN, bindPassword: STORED_SECRET,
  searchBase: 'DC=corp,DC=local', connectionTimeout: 1500, roleMappings: [], defaultRole: 'OPERATOR',
});

describe('finding 2 — test-connection never hands the stored password to a new target', () => {
  it('a changed serverUrl with no password is refused, and nothing is sent anywhere', async () => {
    // The stored target is NOT the trap: if the stored password leaves, it
    // leaves toward the URL the caller supplied — the trap.
    await setLdap({ ...baseStored(), serverUrl: 'ldap://127.0.0.1:1' });
    captured = [];
    const res = await app.inject({ method: 'POST', url: '/api/ldap/test-connection', headers: mgr, payload: { serverUrl: storedUrl() } });
    expect(res.statusCode, res.body).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(capturedText()).not.toContain(STORED_SECRET);
  });

  it('a changed bindDN with the mask is refused the same way', async () => {
    await setLdap(baseStored());
    captured = [];
    const res = await app.inject({
      method: 'POST', url: '/api/ldap/test-connection', headers: mgr,
      payload: { ...baseStored(), bindDN: 'CN=attacker,DC=evil', bindPassword: '********' },
    });
    expect(res.statusCode, res.body).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(capturedText()).not.toContain(STORED_SECRET);
  });

  it('a new target WITH its own password is tested with that password', async () => {
    await setLdap({ ...baseStored(), serverUrl: 'ldap://127.0.0.1:1' });
    captured = [];
    const res = await app.inject({
      method: 'POST', url: '/api/ldap/test-connection', headers: mgr,
      payload: { serverUrl: storedUrl(), bindDN: STORED_DN, bindPassword: 'typed-by-caller' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(capturedText()).toContain('typed-by-caller');
    expect(capturedText()).not.toContain(STORED_SECRET);
  });

  it('LOW: on the STORED target the page\'s mask means "use the stored password", not the literal mask', async () => {
    await setLdap(baseStored());
    captured = [];
    const res = await app.inject({
      method: 'POST', url: '/api/ldap/test-connection', headers: sa,
      payload: { ...baseStored(), bindPassword: '********' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(capturedText()).toContain(STORED_SECRET);
    expect(capturedText()).not.toContain('********');
  });

  it('every test is audited, with no secret in the row', async () => {
    await setLdap(baseStored());
    const res = await app.inject({ method: 'POST', url: '/api/ldap/test-connection', headers: sa, payload: { bindPassword: '********' } });
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'LDAP_CONNECTION_TESTED' }, orderBy: { timestamp: 'desc' } });
    expect(row).toBeTruthy();
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(STORED_SECRET);
    expect((row?.afterValue as Record<string, unknown>)?.serverUrl).toBe(storedUrl());
  });

  it('the test takes the LDAP re-auth when it is switched on', async () => {
    await setLdap(baseStored());
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      update: { configValue: { UPDATE_LDAP_CONFIG: ['SUPER_ADMIN'] } as never },
      create: { configKey: 'action-reauth', configValue: { UPDATE_LDAP_CONFIG: ['SUPER_ADMIN'] } as never, configType: 'security', requiresReauth: false },
    });
    invalidateReauthCache();
    try {
      const refused = await app.inject({ method: 'POST', url: '/api/ldap/test-connection', headers: sa, payload: {} });
      expect(refused.statusCode, refused.body).toBe(401);
      const signed = await app.inject({ method: 'POST', url: '/api/ldap/test-connection', headers: { ...sa, 'x-reauth-password': ADMIN_PASSWORD }, payload: {} });
      expect(signed.statusCode, signed.body).toBe(200);
    } finally {
      await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: { configValue: (rows['action-reauth']?.configValue ?? {}) as never } });
      invalidateReauthCache();
    }
  });

  it('SAVE: a changed serverUrl with the mask is refused and the stored config is untouched', async () => {
    await setLdap(baseStored());
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: mgr,
      payload: { ...baseStored(), serverUrl: 'ldap://evil.example:389', bindPassword: '********' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((await storedLdap()).serverUrl).toBe(storedUrl());
  });

  it('SAVE: the mask on the unchanged target keeps the stored password (positive control)', async () => {
    await setLdap(baseStored());
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: mgr,
      payload: { ...baseStored(), searchBase: 'DC=other,DC=local', bindPassword: '********' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await storedLdap();
    expect(after.bindPassword).toBe(STORED_SECRET);
    expect(after.searchBase).toBe('DC=other,DC=local');
  });
});

describe('finding 7 — LDAP role mappings stay below the caller', () => {
  it('a non-SUPER_ADMIN cannot map a group to a role at or above its level', async () => {
    await setLdap(baseStored());
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: mgr,
      payload: { ...baseStored(), bindPassword: '********', roleMappings: [{ ldapGroup: 'Mine', role: 'ADMIN' }] },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect((await storedLdap()).roleMappings).toEqual([]);
  });

  it('nor to its own role', async () => {
    await setLdap(baseStored());
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: mgr,
      payload: { ...baseStored(), bindPassword: '********', roleMappings: [{ ldapGroup: 'Mine', role: MGR }] },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('nor set the default role above itself', async () => {
    await setLdap(baseStored());
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: mgr,
      payload: { ...baseStored(), bindPassword: '********', defaultRole: 'ADMIN' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect((await storedLdap()).defaultRole).toBe('OPERATOR');
  });

  it('a mapping to a role below the caller is accepted', async () => {
    await setLdap(baseStored());
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: mgr,
      payload: { ...baseStored(), bindPassword: '********', roleMappings: [{ ldapGroup: 'Ops', role: LOW }] },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a mapping a SUPER_ADMIN stored is grandfathered: the lower admin can still save other fields', async () => {
    await setLdap({ ...baseStored(), roleMappings: [{ ldapGroup: 'Admins', role: 'ADMIN' }] });
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: mgr,
      payload: { ...baseStored(), bindPassword: '********', searchBase: 'DC=x', roleMappings: [{ ldapGroup: 'Admins', role: 'ADMIN' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('SUPER_ADMIN may map to any role (positive control)', async () => {
    await setLdap(baseStored());
    const res = await app.inject({
      method: 'PUT', url: '/api/ldap/config', headers: sa,
      payload: { ...baseStored(), bindPassword: '********', roleMappings: [{ ldapGroup: 'Admins', role: 'ADMIN' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
