import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Cover for the `requiredGroups` access gate (added 2026-08-08).
 *
 * Before it existed, restricting who could sign in lived ENTIRELY in whether the
 * administrator remembered to type a `memberOf` clause into `searchFilter`. With
 * the shipped default filter — `(sAMAccountName={{username}})` — every employee
 * in the customer's directory could authenticate, be auto-provisioned, and land
 * on `defaultRole`. Nothing in the product enforced, defaulted, or warned about
 * that. These tests pin the gate's semantics; the config page additionally warns
 * when the list is empty.
 */

const mockBind = vi.hoisted(() => vi.fn());
const mockUnbind = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => vi.fn());

vi.mock('ldapts', () => ({
  Client: class {
    bind = mockBind;
    unbind = mockUnbind;
    search = mockSearch;
  },
}));

const mockFindFirst = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    systemConfig: { findFirst: mockFindFirst },
    role: { findFirst: vi.fn() },
    user: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn() }));
vi.mock('../../../plugins/auth.js', () => ({ invalidateUserAuthCache: vi.fn() }));

const { ldapService } = await import('../ldap.service.js');

/** Configure the stored LDAP config for one call. */
function withConfig(overrides: Record<string, unknown>) {
  mockFindFirst.mockResolvedValue({
    configValue: {
      enabled: true,
      serverUrl: 'ldaps://dc.corp.local:636',
      bindDN: 'CN=svc,DC=corp,DC=local',
      bindPassword: 'x',
      searchBase: 'DC=corp,DC=local',
      ...overrides,
    },
  });
}

/** The directory returns one user carrying `groups` in memberOf. */
function directoryReturns(groups: string[]) {
  mockSearch.mockResolvedValue({
    searchEntries: [{
      dn: 'CN=Ravi,OU=Employees,DC=corp,DC=local',
      sAMAccountName: 'EMP1234',
      displayName: 'Ravi Kumar',
      mail: 'ravi@corp.local',
      department: 'Quality',
      memberOf: groups,
    }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBind.mockResolvedValue(undefined);
  mockUnbind.mockResolvedValue(undefined);
});

describe('requiredGroups access gate', () => {
  it('admits a member of a required group named by full DN', async () => {
    withConfig({ requiredGroups: ['CN=DigiLog-Users,OU=Groups,DC=corp,DC=local'] });
    directoryReturns(['CN=DigiLog-Users,OU=Groups,DC=corp,DC=local']);

    const result = await ldapService.authenticateUser('EMP1234', 'pw');
    expect(result?.success).toBe(true);
  });

  it('admits a member when the group is configured by bare name', async () => {
    // How operators actually type these — they copy the group name, not the DN.
    withConfig({ requiredGroups: ['DigiLog-Operator'] });
    directoryReturns(['CN=DigiLog-Operator,OU=Groups,DC=corp,DC=local']);

    expect((await ldapService.authenticateUser('EMP1234', 'pw'))?.success).toBe(true);
  });

  it('admits when the user matches ANY of several required groups', async () => {
    withConfig({ requiredGroups: ['DigiLog-Admin', 'DigiLog-QA'] });
    directoryReturns(['CN=DigiLog-QA,OU=Groups,DC=corp,DC=local']);

    expect((await ldapService.authenticateUser('EMP1234', 'pw'))?.success).toBe(true);
  });

  // ── the point of the feature ──
  it('REFUSES an authenticated user who is in no required group', async () => {
    withConfig({ requiredGroups: ['DigiLog-Users'] });
    directoryReturns(['CN=Everyone,OU=Groups,DC=corp,DC=local']);

    // Their password was correct — the bind succeeded — and they are still
    // refused. That is the difference between authentication and authorisation.
    expect(await ldapService.authenticateUser('EMP1234', 'pw')).toBeNull();
  });

  it('does not substring-match its way to a false admit', async () => {
    // Same class of bug as the roleMappings substring defect: "DigiLog" must not
    // let a member of "DigiLog-Contractors-Archive" in.
    withConfig({ requiredGroups: ['DigiLog'] });
    directoryReturns(['CN=DigiLog-Contractors-Archive,OU=Groups,DC=corp,DC=local']);

    expect(await ldapService.authenticateUser('EMP1234', 'pw')).toBeNull();
  });

  it('ignores blank entries rather than treating them as a wildcard', async () => {
    // An operator who clicks "Add Group" and saves without typing must not
    // accidentally create a rule that matches everything — or one that locks
    // out a legitimate member of the group they did fill in.
    withConfig({ requiredGroups: ['', '   '] });
    directoryReturns(['CN=Anyone,DC=corp,DC=local']);

    expect(await ldapService.authenticateUser('EMP1234', 'pw')).toBeNull();
  });

  it('imposes no restriction when the list is empty (existing installs unchanged)', async () => {
    withConfig({ requiredGroups: [] });
    directoryReturns(['CN=Anyone,DC=corp,DC=local']);

    expect((await ldapService.authenticateUser('EMP1234', 'pw'))?.success).toBe(true);
  });

  it('imposes no restriction when the field is absent (config saved before the feature)', async () => {
    withConfig({});
    directoryReturns(['CN=Anyone,DC=corp,DC=local']);

    expect((await ldapService.authenticateUser('EMP1234', 'pw'))?.success).toBe(true);
  });

  it('checks membership only AFTER the user proves their password', async () => {
    // Ordering matters: gating before the user bind would let an unauthenticated
    // caller probe group membership by timing which usernames fail fast.
    withConfig({ requiredGroups: ['DigiLog-Users'] });
    directoryReturns(['CN=Nope,DC=corp,DC=local']);
    // Service-account bind succeeds, user bind fails → null for the wrong reason
    // if ordering were reversed. Here both binds succeed and the gate rejects.
    await ldapService.authenticateUser('EMP1234', 'pw');

    // Two binds: the service account, then the user proving their password.
    expect(mockBind).toHaveBeenCalledTimes(2);
  });
});
