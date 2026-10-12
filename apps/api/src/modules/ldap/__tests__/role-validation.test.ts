import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `users.role` is a plain VarChar with NO foreign key to `roles.name`, and
 * `provisionUser`/`syncUserAttributes` wrote the group-mapped name straight into
 * it. So a mapping naming a role this application does not have — a typo, or a
 * role an admin later deleted or deactivated — produced a user whose every
 * permission lookup missed. They logged in perfectly successfully to an empty
 * application, with no error surfaced anywhere to explain why.
 *
 * That is the expected first-run experience for a customer who maps an AD group
 * to a role like "QA" before creating it under Roles & Access, which is exactly
 * the integration this was written for. `resolveMappedRole` closes it.
 */

const { mockPrisma, mockAuditLog } = vi.hoisted(() => ({
  mockPrisma: {
    user: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    role: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../../plugins/auth.js', () => ({ invalidateUserAuthCache: vi.fn() }));

const { ldapService } = await import('../ldap.service.js');

const groups = ['CN=DigiLog-QA,OU=Groups,DC=corp,DC=local'];
const config: any = {
  defaultRole: 'OPERATOR',
  roleMappings: [{ ldapGroup: 'DigiLog-QA', role: 'QA' }],
  strictRoleMapping: false,
};

/** `roles` contains exactly the names given; everything else is missing. */
function rolesTableHas(...names: string[]) {
  mockPrisma.role.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(names.includes(where.name) ? { name: where.name } : null));
  // The precedence lookup: every active candidate with its level (all level 1
  // here unless a test sets `levels`).
  mockPrisma.role.findMany.mockImplementation(({ where }: any) =>
    Promise.resolve((where.name.in as string[]).filter((n) => names.includes(n))
      .map((n) => ({ name: n, hierarchyLevel: levels[n] ?? 1 }))));
}
let levels: Record<string, number> = {};

beforeEach(() => {
  vi.clearAllMocks();
  levels = {};
  mockPrisma.role.findMany.mockResolvedValue([]);
  mockPrisma.user.create.mockResolvedValue({ id: 'u-new', username: 'EMP1234' });
});

describe('resolveMappedRole', () => {
  it('returns the mapped role when it exists and is active', async () => {
    rolesTableHas('QA', 'OPERATOR');
    expect(await ldapService.resolveMappedRole(groups, config))
      .toEqual({ role: 'QA', mappedRole: 'QA', fellBack: false });
  });

  // ── the bug ──
  it('falls back to the default role when the mapped role does not exist', async () => {
    rolesTableHas('OPERATOR'); // "QA" was never created
    expect(await ldapService.resolveMappedRole(groups, config))
      .toEqual({ role: 'OPERATOR', mappedRole: 'QA', fellBack: true });
  });

  it('treats an INACTIVE role as missing', async () => {
    // findFirst filters on isActive: true, so a deactivated role returns null —
    // deactivating a role must not silently strand everyone mapped to it.
    mockPrisma.role.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.name === 'OPERATOR' && where.isActive ? { name: 'OPERATOR' } : null));
    const result = await ldapService.resolveMappedRole(groups, config);
    expect(result.fellBack).toBe(true);
    expect(result.role).toBe('OPERATOR');
  });

  it('does not swap one dangling role for another when the DEFAULT is also missing', async () => {
    rolesTableHas(); // nothing exists
    const result = await ldapService.resolveMappedRole(groups, config);
    expect(result.fellBack).toBe(true);
    // Keeps the mapped name rather than pretending the default is valid — the
    // operator's log line names both, and neither is a lie.
    expect(result.role).toBe('QA');
  });

  it('throws instead of falling back when strictRoleMapping is on', async () => {
    rolesTableHas('OPERATOR');
    await expect(ldapService.resolveMappedRole(groups, { ...config, strictRoleMapping: true }))
      .rejects.toThrow(/not an active role/i);
  });
});

describe('provisionUser with an unmapped role', () => {
  it('creates the user at the fallback role, not the missing one', async () => {
    rolesTableHas('OPERATOR');

    await ldapService.provisionUser('EMP1234', {
      success: true, userDn: 'CN=E,DC=corp,DC=local',
      attributes: { fullName: 'E', email: 'e@corp.local', department: 'QA' },
      groups,
    } as any, config);

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'OPERATOR' }) }),
    );
  });

  it('records the mismatch in the audit trail (§11.10(e))', async () => {
    rolesTableHas('OPERATOR');

    await ldapService.provisionUser('EMP1234', {
      success: true, userDn: 'CN=E,DC=corp,DC=local',
      attributes: { fullName: 'E', email: 'e@corp.local', department: 'QA' },
      groups,
    } as any, config);

    const entry = mockAuditLog.mock.calls[0][0];
    // An inspector must be able to see that the role GRANTED is not the role the
    // directory mapping asked for — otherwise the row reads as a normal
    // provisioning and the misconfiguration stays invisible.
    expect(entry.afterValue.mappedRoleNotFound).toBe('QA');
    expect(entry.afterValue.role).toBe('OPERATOR');
    expect(entry.signatureMeaning).toContain('QA');
    expect(entry.signatureMeaning).toMatch(/does not exist/i);
  });

  it('sets passwordChangedAt so the row is not mistaken for a legacy local user', async () => {
    // A null passwordChangedAt is what let the expiry sweep treat directory
    // users as ancient local ones and force-expire them.
    rolesTableHas('QA', 'OPERATOR');

    await ldapService.provisionUser('EMP1234', {
      success: true, userDn: 'CN=E,DC=corp,DC=local',
      attributes: { fullName: 'E', email: 'e@corp.local', department: 'QA' },
      groups,
    } as any, config);

    const data = mockPrisma.user.create.mock.calls[0][0].data;
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
    expect(data.authSource).toBe('ldap');
    expect(data.passwordHash).toBe('LDAP_EXTERNAL_AUTH');
  });
});

// Application review 2026-10-12, follow-up 5: when a user's groups match
// several mappings, the HIGHEST-PRIVILEGE active role wins, whatever the
// stored order; stored order only breaks a tie.
describe('mapping precedence', () => {
  const both = ['CN=Ops,DC=x', 'CN=Admins,DC=x'];
  const cfg = (rows: Array<{ ldapGroup: string; role: string }>): any => ({ defaultRole: 'OPERATOR', roleMappings: rows, strictRoleMapping: false });

  it('a higher role listed SECOND still wins', async () => {
    rolesTableHas('OPERATOR', 'ADMIN'); levels = { OPERATOR: 2, ADMIN: 5 };
    const r = await ldapService.resolveMappedRole(both, cfg([{ ldapGroup: 'Ops', role: 'OPERATOR' }, { ldapGroup: 'Admins', role: 'ADMIN' }]));
    expect(r.role).toBe('ADMIN');
  });

  it('the same answer whatever the order', async () => {
    rolesTableHas('OPERATOR', 'ADMIN'); levels = { OPERATOR: 2, ADMIN: 5 };
    const r = await ldapService.resolveMappedRole(both, cfg([{ ldapGroup: 'Admins', role: 'ADMIN' }, { ldapGroup: 'Ops', role: 'OPERATOR' }]));
    expect(r.role).toBe('ADMIN');
  });

  it('a missing or inactive higher role never beats an active lower one', async () => {
    rolesTableHas('OPERATOR'); levels = { OPERATOR: 2 };
    const r = await ldapService.resolveMappedRole(both, cfg([{ ldapGroup: 'Admins', role: 'GHOST_ADMIN' }, { ldapGroup: 'Ops', role: 'OPERATOR' }]));
    expect(r).toEqual({ role: 'OPERATOR', mappedRole: 'OPERATOR', fellBack: false });
  });

  it('a tie at one level goes to the stored order', async () => {
    rolesTableHas('QA', 'OPS2'); levels = { QA: 3, OPS2: 3 };
    const r = await ldapService.resolveMappedRole(both, cfg([{ ldapGroup: 'Admins', role: 'OPS2' }, { ldapGroup: 'Ops', role: 'QA' }]));
    expect(r.role).toBe('OPS2');
  });
});
