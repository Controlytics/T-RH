import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import {
  startFakeAdServer, type FakeAdServer,
  SERVICE_ACCOUNT_DN, SERVICE_ACCOUNT_PASSWORD, EMPLOYEES_OU,
  PARENT_GROUP_DN, GROUP_DNS, AD_PASSWORD,
} from '../test-support/fake-ad-server.js';

/**
 * End-to-end cover for directory authentication, against a real LDAP server.
 *
 * Everything below talks to `src/test-support/fake-ad-server.ts` over a TCP
 * socket using the unmodified `ldapts` client — so the filter we recommend in
 * the integration guide, the two-bind flow, and AD's nested-group semantics are
 * genuinely exercised, not mocked. The unit suites prove our branching; this
 * proves the conversation.
 *
 * Directory layout mirrors the customer's: one parent group holding five role
 * sub-groups, employees inside the sub-groups (never in the parent directly).
 *
 * NOT covered here, and not to be read as covered: TLS (`ldap://` only, so
 * `tlsRejectUnauthorized` is inert), AD's own lockout/expiry/disabled-account
 * behaviour, and paged or ranged `memberOf` retrieval.
 */

const PORT = 13890; // not 389 — no privileged bind, and no clash with a real DC
const SEARCH_FILTER =
  `(&(sAMAccountName={{username}})(memberOf:1.2.840.113556.1.4.1941:=${PARENT_GROUP_DN}))`;

let app: FastifyInstance;
let ad: FakeAdServer;

/**
 * Every `system_config` key this suite writes, snapshotted in beforeAll and put
 * back in afterAll.
 *
 * This list is load-bearing, not tidiness. The suite runs against the SHARED
 * `digilog_test_db`, and an earlier version restored only `ldap` and
 * `action-reauth` — so the `password-policy` row it overwrote with
 * `{ passwordExpiryDays: 90 }` stayed that way, silently stripping minLength and
 * every complexity flag. Three unrelated tests in `user.service.test.ts` that
 * deliberately run the REAL validator against the real policy then started
 * accepting a weak password and failing. If you add a key here, add it to this
 * array in the same commit.
 */
const TOUCHED_CONFIG_KEYS = ['ldap', 'action-reauth', 'password-policy', 'user-id'] as const;
const originalConfigRows = new Map<string, unknown | null>();

const ROLE_MAPPINGS = [
  { ldapGroup: GROUP_DNS.admin, role: 'ADMIN' },
  { ldapGroup: GROUP_DNS.supervisor, role: 'SUPERVISOR' },
  { ldapGroup: GROUP_DNS.qa, role: 'QA' },
  { ldapGroup: GROUP_DNS.maintenance, role: 'MAINTENANCE' },
  { ldapGroup: GROUP_DNS.operator, role: 'OPERATOR' },
];

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    serverUrl: `ldap://127.0.0.1:${PORT}`,
    bindDN: SERVICE_ACCOUNT_DN,
    bindPassword: SERVICE_ACCOUNT_PASSWORD,
    searchBase: EMPLOYEES_OU,
    searchFilter: SEARCH_FILTER,
    usernameAttribute: 'sAMAccountName',
    emailAttribute: 'mail',
    fullNameAttribute: 'displayName',
    departmentAttribute: 'department',
    groupAttribute: 'memberOf',
    tlsRejectUnauthorized: false, // plain ldap:// — inert, see header note
    connectionTimeout: 5000,
    roleMappings: ROLE_MAPPINGS,
    defaultRole: 'VIEWER',
    syncAttributes: true,
    requiredGroups: [] as string[],
    strictRoleMapping: false,
    ...overrides,
  };
}

async function setLdapConfig(overrides: Record<string, unknown> = {}) {
  await prisma.systemConfig.upsert({
    where: { configKey: 'ldap' },
    update: { configValue: baseConfig(overrides) as any, updatedBy: 'e2e' },
    create: {
      configKey: 'ldap', configValue: baseConfig(overrides) as any,
      configType: 'security', requiresReauth: true, updatedBy: 'e2e',
    },
  });
}

/**
 * `force: true` on every login: this app allows one session per user, so a
 * second login without it returns 409 SESSION_CONFLICT. Several tests log the
 * same person in twice on purpose (to exercise attribute sync and the
 * force-password-change heal), and admin logs in repeatedly — without force,
 * those fail on session bookkeeping rather than on what they are testing.
 */
const login = (username: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, force: true } });

/** Remove any user this suite provisioned, so each test starts from first-login. */
async function purgeDirectoryUsers() {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: 'EMP' } }, select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.passwordHistory.deleteMany({ where: { userId: { in: ids } } });
  await prisma.passwordResetRequest.deleteMany({ where: { userId: { in: ids } } });
  await prisma.userConfig.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  ad = await startFakeAdServer(PORT);
  app = await buildApp();
  await app.ready();

  for (const key of TOUCHED_CONFIG_KEYS) {
    const row = await prisma.systemConfig.findUnique({
      where: { configKey: key }, select: { configValue: true },
    });
    originalConfigRows.set(key, row ? row.configValue : null);
  }

  // The customer's QA role does not exist out of the box. Creating it here is
  // the point, not a workaround: without it every QA mapping would silently
  // exercise the fallback path instead of the mapping we mean to test.
  await prisma.role.upsert({
    where: { name: 'QA' },
    update: { isActive: true },
    create: {
      name: 'QA', displayName: 'Quality Assurance', hierarchyLevel: 4,
      permissions: ['INSTRUMENT_READ', 'AUDIT_READ'], isActive: true, isSystem: false,
    },
  });

  await purgeDirectoryUsers();
}, 30_000);

afterAll(async () => {
  // Restore the config row EXACTLY as found. Leaving `enabled: true` behind
  // would point every later suite's unknown-username login at a dead socket —
  // and would quietly invalidate the pre-existing-failure baseline that the
  // rest of this work is measured against.
  for (const key of TOUCHED_CONFIG_KEYS) {
    const original = originalConfigRows.get(key);
    if (original == null) {
      await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    } else {
      await prisma.systemConfig.update({
        where: { configKey: key }, data: { configValue: original as any },
      });
    }
  }
  await purgeDirectoryUsers();
  await prisma.role.deleteMany({ where: { name: 'QA' } });
  await app.close();
  await ad.close();
  // 30s: teardown does four config restores, a user purge, app.close() and the
  // LDAP server shutdown. The 10s default was enough when this file ran alone
  // and not when it ran inside the full suite under a loaded connection pool.
}, 30_000);

beforeEach(async () => {
  await setLdapConfig();
  await purgeDirectoryUsers();
  ad.bindLog.length = 0;
  ad.searchLog.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('first login — auto-provisioning', () => {
  it('creates the user from their directory record and admits them', async () => {
    const res = await login('EMP1002', AD_PASSWORD);
    expect(res.statusCode).toBe(200);

    const user = await prisma.user.findUnique({ where: { username: 'EMP1002' } });
    expect(user).toMatchObject({
      username: 'EMP1002',
      fullName: 'Priya Sharma',
      email: 'priya.sharma@corp.local',
      department: 'Production',
      role: 'SUPERVISOR',
      authSource: 'ldap',
      passwordHash: 'LDAP_EXTERNAL_AUTH',
      status: 'ENABLED',
      forcePasswordChange: false,
    });
    expect(user!.ldapDn).toBe('CN=Priya Sharma,OU=Employees,DC=corp,DC=local');
  });

  it('performs the real two-bind flow: service account, then the user', async () => {
    await login('EMP1002', AD_PASSWORD);

    // Exactly two binds, in order: the service account looks the user up, then
    // the user proves their own password. Asserted as an exact list on purpose —
    // it caught a first login binding FOUR times, because the provisioning path
    // and the directory-user path each ran a full authentication.
    expect(ad.bindLog).toEqual([
      { dn: SERVICE_ACCOUNT_DN, ok: true },
      { dn: 'CN=Priya Sharma,OU=Employees,DC=corp,DC=local', ok: true },
    ]);
    expect(ad.searchLog).toHaveLength(1);
  });

  it('sends the documented nested-group filter to the directory', async () => {
    await login('EMP1002', AD_PASSWORD);

    expect(ad.searchLog[0]).toContain('1.2.840.113556.1.4.1941');
    expect(ad.searchLog[0]).toContain('sAMAccountName=EMP1002');
  });

  it('writes a USER_CREATED audit row carrying the AD groups (§11.10(e))', async () => {
    await login('EMP1002', AD_PASSWORD);

    const row = await prisma.auditTrail.findFirst({
      where: { action: 'USER_CREATED', userId: 'EMP1002' },
      orderBy: { timestamp: 'desc' },
    });
    expect(row).toBeTruthy();
    const after = row!.afterValue as any;
    expect(after).toMatchObject({ username: 'EMP1002', role: 'SUPERVISOR', authSource: 'ldap' });
    expect(String(after.ldapGroups)).toContain('Compliance-Supervisor');
  });

  it('maps all five role groups to their five application roles', async () => {
    const expected: Array<[string, string]> = [
      ['EMP1001', 'ADMIN'], ['EMP1002', 'SUPERVISOR'], ['EMP1003', 'OPERATOR'],
      ['EMP1004', 'QA'], ['EMP1005', 'MAINTENANCE'],
    ];
    for (const [username] of expected) {
      const res = await login(username, AD_PASSWORD);
      expect(res.statusCode, `${username} should be admitted`).toBe(200);
    }
    const rows = await prisma.user.findMany({
      where: { username: { in: expected.map(([u]) => u) } },
      select: { username: true, role: true },
    });
    expect(rows.sort((a, b) => a.username.localeCompare(b.username)).map((r) => [r.username, r.role]))
      .toEqual(expected);
  });

  it('rejects a wrong password and provisions nothing', async () => {
    const res = await login('EMP1002', 'not-their-password');

    expect(res.statusCode).toBe(401);
    expect(await prisma.user.findUnique({ where: { username: 'EMP1002' } })).toBeNull();
  });
});

describe('access restriction', () => {
  it('refuses a directory employee who is in no Compliance group', async () => {
    // EMP9999 authenticates perfectly against AD. The nested-group filter is
    // what keeps them out — this is the check that decides whether the whole
    // company can log in or only the intended staff.
    const res = await login('EMP9999', AD_PASSWORD);

    expect(res.statusCode).toBe(401);
    expect(await prisma.user.findUnique({ where: { username: 'EMP9999' } })).toBeNull();
  });

  it('refuses a non-member even when the search filter is left wide open', async () => {
    // The belt to the filter's braces: with the default filter, the directory
    // returns EMP9999 happily, and only `requiredGroups` stops them.
    //
    // The list names the ROLE groups, not the parent — see the sibling test
    // below for why that distinction is the whole ballgame.
    await setLdapConfig({
      searchFilter: '(sAMAccountName={{username}})',
      requiredGroups: [GROUP_DNS.supervisor, GROUP_DNS.operator],
    });

    const res = await login('EMP9999', AD_PASSWORD);
    expect(res.statusCode).toBe(401);

    // Proof the gate — not the filter — did the work: the directory DID match
    // and the user's own bind DID succeed.
    expect(ad.bindLog.some((b) => b.dn.includes('Sunil Outsider') && b.ok)).toBe(true);

    // And the other half, without which this test would pass even if the gate
    // refused EVERYONE: a member of a listed group still gets in. An earlier
    // version of this test listed the PARENT group and asserted only the
    // refusal — so it passed while the configuration it described locked the
    // whole company out.
    expect((await login('EMP1002', AD_PASSWORD)).statusCode).toBe(200);
  });

  it('requiredGroups matches DIRECT membership only — the parent group locks everyone out', async () => {
    // `memberOf` carries only the groups a user is a DIRECT member of. The
    // nested-group walk is something the DIRECTORY does, inside the search
    // filter's matching rule — this gate runs in our code against the list AD
    // returned, so naming the parent matches nobody.
    //
    // Pinned as a test because it is the obvious wrong move: the parent group DN
    // is the one the customer hands over, and putting it here silently refuses
    // every employee while looking perfectly reasonable on screen. The config
    // page and the integration guide both say to list the role groups.
    await setLdapConfig({
      searchFilter: '(sAMAccountName={{username}})',
      requiredGroups: [PARENT_GROUP_DN],
    });

    expect((await login('EMP1002', AD_PASSWORD)).statusCode).toBe(401);
  });

  it('the wide-open filter really does admit everyone without the gate — the risk is real', async () => {
    await setLdapConfig({ searchFilter: '(sAMAccountName={{username}})', requiredGroups: [] });

    const res = await login('EMP9999', AD_PASSWORD);

    expect(res.statusCode).toBe(200);
    // Auto-provisioned onto defaultRole, from outside every intended group.
    expect(await prisma.user.findUnique({ where: { username: 'EMP9999' } }))
      .toMatchObject({ role: 'VIEWER', authSource: 'ldap' });
  });

  it('a DIRECT (non-nested) parent-group filter matches nobody — the customer-layout trap', async () => {
    // Without the 1.2.840.113556.1.4.1941 matching rule, AD checks only direct
    // membership. Employees live in the role sub-groups, so a plain memberOf
    // clause against the parent silently locks out the entire company.
    await setLdapConfig({
      searchFilter: `(&(sAMAccountName={{username}})(memberOf=${PARENT_GROUP_DN}))`,
    });

    const res = await login('EMP1002', AD_PASSWORD);
    expect(res.statusCode).toBe(401);
  });
});

describe('re-authentication — the electronic-signature path', () => {
  // POST /api/auth/verify — the first re-auth implementation, which minted a
  // verification token nothing consumed — was removed (audit 2026-10-03,
  // SEC-5). The ONE re-auth path is now lib/reauth-check.ts, exercised below
  // through a real gated endpoint. Before 2026-08-08 both implementations
  // bcrypt-compared a directory user's password against the sentinel and could
  // never succeed, so no AD Supervisor or QA could sign anything.

  // Seeding action-reauth is essential — without a row naming this action for
  // this role, enforceReauth short-circuits and a test would pass while
  // proving nothing. Idempotent, so each case seeds for itself.
  const armProfileReauthForAdmin = () => prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: { UPDATE_PROFILE: ['ADMIN'] } as any },
    create: { configKey: 'action-reauth', configValue: { UPDATE_PROFILE: ['ADMIN'] } as any, configType: 'security', updatedBy: 'e2e' },
  });

  it('a failed reauth does NOT lock the account (lockout delegated to AD)', async () => {
    await armProfileReauthForAdmin();
    const token = JSON.parse((await login('EMP1001', AD_PASSWORD)).body).token; // ADMIN

    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'PUT', url: '/api/auth/profile',
        headers: { authorization: `Bearer ${token}` },
        payload: { fullName: 'Ravi Kumar', _currentPassword: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    }

    const user = await prisma.user.findUnique({ where: { username: 'EMP1001' } });
    expect(user!.failedLoginAttempts).toBe(0);
    expect(user!.status).toBe('ENABLED');
  });

  it('the enforceReauth path (inline password on a real endpoint) also works', async () => {
    // The SECOND reauth implementation, in lib/reauth-check.ts, carried the
    // identical bug. Seeding action-reauth is essential — without a row naming
    // this action for this role, enforceReauth short-circuits and the test
    // would pass while proving nothing.
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      update: { configValue: { UPDATE_PROFILE: ['ADMIN'] } as any },
      create: { configKey: 'action-reauth', configValue: { UPDATE_PROFILE: ['ADMIN'] } as any, configType: 'security', updatedBy: 'e2e' },
    });

    const token = JSON.parse((await login('EMP1001', AD_PASSWORD)).body).token; // ADMIN

    // Without the password → challenged, proving the gate is genuinely armed.
    const challenged = await app.inject({
      method: 'PUT', url: '/api/auth/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Ravi Kumar' },
    });
    expect(challenged.statusCode).toBe(401);
    expect(JSON.parse(challenged.body).error).toBe('REAUTH_REQUIRED');

    // With the AD password → accepted, via a live directory bind.
    const accepted = await app.inject({
      method: 'PUT', url: '/api/auth/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Ravi Kumar', _currentPassword: AD_PASSWORD },
    });
    expect(accepted.statusCode).toBe(200);
  });
});

describe('password management is refused and delegated', () => {
  it('admin password reset is refused for a directory user', async () => {
    await login('EMP1003', AD_PASSWORD);
    const target = await prisma.user.findUnique({ where: { username: 'EMP1003' } });

    const adminToken = JSON.parse((await login('admin', 'Admin@123')).body).token;
    const res = await app.inject({
      method: 'POST', url: `/api/users/${target!.id}/reset-password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { newPassword: 'Brandnew@123' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Active Directory/i);

    // The credential is untouched — this is the assertion that matters. The old
    // behaviour wrote a bcrypt hash here, detaching the account from AD so that
    // disabling them in the directory no longer revoked their access.
    const after = await prisma.user.findUnique({ where: { username: 'EMP1003' } });
    expect(after!.passwordHash).toBe('LDAP_EXTERNAL_AUTH');
    expect(after!.authSource).toBe('ldap');
  });

  it('self-service password change is refused', async () => {
    const token = JSON.parse((await login('EMP1003', AD_PASSWORD)).body).token;

    const res = await app.inject({
      method: 'POST', url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: AD_PASSWORD, newPassword: 'Brandnew@123' },
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { username: 'EMP1003' } }))
      .toMatchObject({ passwordHash: 'LDAP_EXTERNAL_AUTH' });
  });

  it('forgot-password files no request, and reveals nothing', async () => {
    await login('EMP1003', AD_PASSWORD);
    const target = await prisma.user.findUnique({ where: { username: 'EMP1003' } });

    const res = await app.inject({
      method: 'POST', url: '/api/auth/forgot-password', payload: { username: 'EMP1003' },
    });

    expect(res.statusCode).toBe(200); // same answer as for an unknown user
    expect(await prisma.passwordResetRequest.count({ where: { userId: target!.id } })).toBe(0);
  });

  it('unlock clears the lock without issuing or changing a password', async () => {
    await login('EMP1003', AD_PASSWORD);
    const target = await prisma.user.findUnique({ where: { username: 'EMP1003' } });
    await prisma.user.update({
      where: { id: target!.id }, data: { status: 'LOCKED', failedLoginAttempts: 5 },
    });

    const adminToken = JSON.parse((await login('admin', 'Admin@123')).body).token;
    const res = await app.inject({
      method: 'POST', url: `/api/users/${target!.id}/unlock`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {}, // no newPassword — the schema now allows its absence
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).passwordIssued).toBe(false);

    const after = await prisma.user.findUnique({ where: { id: target!.id } });
    expect(after).toMatchObject({
      status: 'ENABLED', failedLoginAttempts: 0,
      passwordHash: 'LDAP_EXTERNAL_AUTH', forcePasswordChange: false,
    });
  });
});

describe('password policy does not apply to directory users', () => {
  it('an ancient password does not expire them off the application', async () => {
    await prisma.systemConfig.upsert({
      where: { configKey: 'password-policy' },
      update: { configValue: { passwordExpiryDays: 90 } as any },
      create: { configKey: 'password-policy', configValue: { passwordExpiryDays: 90 } as any, configType: 'security', updatedBy: 'e2e' },
    });

    await login('EMP1002', AD_PASSWORD);
    const target = await prisma.user.findUnique({ where: { username: 'EMP1002' } });
    await prisma.user.update({
      where: { id: target!.id },
      data: {
        passwordChangedAt: new Date(Date.now() - 500 * 86_400_000),
        createdAt: new Date(Date.now() - 500 * 86_400_000),
      },
    });

    const token = JSON.parse((await login('EMP1002', AD_PASSWORD)).body).token;
    const res = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` },
    });

    // Pre-fix this was 403 PASSWORD_EXPIRED, on an account whose password this
    // application cannot change — a permanent lockout.
    expect(res.statusCode).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: target!.id } }))
      .toMatchObject({ forcePasswordChange: false });
  });

  it('a stranded forcePasswordChange flag is cleared, not enforced', async () => {
    // Rows left in this state by the old expiry bug. Merely ignoring the flag
    // server-side is not enough: the login response carries it and the web
    // client redirects to a change-password screen that refuses AD accounts.
    await login('EMP1002', AD_PASSWORD);
    const target = await prisma.user.findUnique({ where: { username: 'EMP1002' } });
    await prisma.user.update({
      where: { id: target!.id }, data: { forcePasswordChange: true, isTemporaryPassword: true },
    });

    const body = JSON.parse((await login('EMP1002', AD_PASSWORD)).body);
    expect(body.user?.forcePasswordChange ?? body.forcePasswordChange).toBeFalsy();

    const res = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${body.token}` },
    });
    expect(res.statusCode).toBe(200);

    expect(await prisma.user.findUnique({ where: { id: target!.id } }))
      .toMatchObject({ forcePasswordChange: false });
  });

  it('an employee ID that violates the User ID Format is still admitted', async () => {
    // AD owns the naming; the format governs locally-created users only.
    await prisma.systemConfig.upsert({
      where: { configKey: 'user-id' },
      update: { configValue: { format: 'NUMBERS_ONLY', length: 4 } as any },
      create: { configKey: 'user-id', configValue: { format: 'NUMBERS_ONLY', length: 4 } as any, configType: 'user', updatedBy: 'e2e' },
    });

    // 'EMP1002' is neither numbers-only nor 4 characters.
    expect((await login('EMP1002', AD_PASSWORD)).statusCode).toBe(200);
  });
});

describe('role mapping robustness', () => {
  it('falls back to the default role when the mapped role does not exist', async () => {
    await setLdapConfig({
      roleMappings: [...ROLE_MAPPINGS, { ldapGroup: GROUP_DNS.contractors, role: 'NO_SUCH_ROLE' }],
    });

    const res = await login('EMP1006', AD_PASSWORD);
    expect(res.statusCode).toBe(200);

    expect(await prisma.user.findUnique({ where: { username: 'EMP1006' } }))
      .toMatchObject({ role: 'VIEWER' });

    const row = await prisma.auditTrail.findFirst({
      where: { action: 'USER_CREATED', userId: 'EMP1006' }, orderBy: { timestamp: 'desc' },
    });
    expect((row!.afterValue as any).mappedRoleNotFound).toBe('NO_SUCH_ROLE');
  });

  it('syncs a role change from the directory on the next login, and audits it', async () => {
    await login('EMP1004', AD_PASSWORD);
    expect(await prisma.user.findUnique({ where: { username: 'EMP1004' } }))
      .toMatchObject({ role: 'QA' });

    // The employee is moved to the Admin group in AD — modelled by remapping
    // their existing group, which is what the application actually observes.
    await setLdapConfig({ roleMappings: [{ ldapGroup: GROUP_DNS.qa, role: 'ADMIN' }] });
    await login('EMP1004', AD_PASSWORD);

    expect(await prisma.user.findUnique({ where: { username: 'EMP1004' } }))
      .toMatchObject({ role: 'ADMIN' });

    const row = await prisma.auditTrail.findFirst({
      where: { action: 'USER_UPDATED', userId: 'EMP1004' }, orderBy: { timestamp: 'desc' },
    });
    expect(row!.signatureMeaning).toMatch(/QA.*ADMIN|role changed/i);
  });

  it('never confers SUPER_ADMIN, whatever the mapping says', async () => {
    await setLdapConfig({ roleMappings: [{ ldapGroup: GROUP_DNS.admin, role: 'SUPER_ADMIN' }] });

    await login('EMP1001', AD_PASSWORD);

    expect(await prisma.user.findUnique({ where: { username: 'EMP1001' } }))
      .toMatchObject({ role: 'VIEWER' }); // fell through to defaultRole
  });
});

describe('failure modes', () => {
  it('turning LDAP off locks directory users out — the sentinel is never a free pass', async () => {
    await login('EMP1002', AD_PASSWORD);
    await setLdapConfig({ enabled: false });

    expect((await login('EMP1002', AD_PASSWORD)).statusCode).toBe(401);
    expect((await login('EMP1002', 'LDAP_EXTERNAL_AUTH')).statusCode).toBe(401);
  });

  it('a wrong service-account password fails every login, not just some', async () => {
    // The single most common cause of a total outage: the service account's
    // password expired.
    await setLdapConfig({ bindPassword: 'wrong-service-password' });

    const res = await login('EMP1002', AD_PASSWORD);
    expect(res.statusCode).toBe(401);
  });

  it('an unreachable directory fails closed rather than erroring out', async () => {
    await setLdapConfig({ serverUrl: 'ldap://127.0.0.1:1', connectionTimeout: 1000 });

    const res = await login('EMP1002', AD_PASSWORD);
    expect([401, 403]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
  });

  it('local accounts are unaffected while LDAP is enabled', async () => {
    const res = await login('admin', 'Admin@123');
    expect(res.statusCode).toBe(200);
  });
});
