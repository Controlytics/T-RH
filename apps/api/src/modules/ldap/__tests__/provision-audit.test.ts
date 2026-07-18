/**
 * 21 CFR §11.10(e) — LDAP auto-provisioning + attribute sync must be audited.
 *
 * Pre-2026-07-15 both wrote NOTHING. With a group→ADMIN role mapping, an unknown
 * directory user logging in silently became an ADMIN with no record of it, while
 * the local user-creation path emitted USER_CREATED. syncUserAttributes could
 * likewise escalate an existing user's role on any login with no trace.
 *
 * The audit write is deliberately best-effort here: auth.service.login wraps both
 * calls in try/catch, so a failing audit must not break an otherwise valid login.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma, mockAuditLog, mockInvalidateCache } = vi.hoisted(() => ({
  mockPrisma: {
    user: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  },
  mockAuditLog: vi.fn(),
  mockInvalidateCache: vi.fn(),
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../../plugins/auth.js', () => ({ invalidateUserAuthCache: mockInvalidateCache }));

const { ldapService } = await import('../ldap.service.js');

const ldapResult = {
  success: true as const,
  userDn: 'cn=jdoe,ou=users,dc=corp,dc=local',
  attributes: { fullName: 'J Doe', email: 'jdoe@corp.local', department: 'QA' },
  groups: ['cn=admins,ou=groups,dc=corp,dc=local'],
};

const config: any = {
  enabled: true,
  defaultRole: 'OPERATOR',
  roleMappings: [{ ldapGroup: 'cn=admins,ou=groups,dc=corp,dc=local', role: 'ADMIN' }],
  syncAttributes: true,
};

describe('ldapService.provisionUser — audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.create.mockResolvedValue({ id: 'u-new', username: 'jdoe', role: 'ADMIN' });
  });

  it('emits USER_CREATED recording the mapped role and directory identity', async () => {
    await ldapService.provisionUser('jdoe', ldapResult as any, config);

    expect(mockAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAuditLog.mock.calls[0][0];
    expect(entry.action).toBe('USER_CREATED');
    expect(entry.targetId).toBe('u-new');
    // The whole point: the privilege the directory conferred must be on the row.
    expect(entry.afterValue).toMatchObject({
      username: 'jdoe', role: 'ADMIN', authSource: 'ldap',
      ldapDn: 'cn=jdoe,ou=users,dc=corp,dc=local',
    });
    expect(entry.afterValue.ldapGroups).toEqual(ldapResult.groups);
    // §11.10(e) requires attribution; auditLog itself rejects a missing userId.
    expect(entry.userId).toBe('jdoe');
  });

  it('still returns the user when the audit write fails (login must not break)', async () => {
    mockAuditLog.mockRejectedValue(new Error('audit DB down'));

    const user = await ldapService.provisionUser('jdoe', ldapResult as any, config);

    expect(user).toMatchObject({ id: 'u-new' });
  });
});

describe('ldapService.syncUserAttributes — audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.update.mockResolvedValue({});
  });

  it('emits USER_UPDATED naming the role escalation when group mapping changes it', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      username: 'jdoe', fullName: 'J Doe', email: 'jdoe@corp.local',
      department: 'QA', role: 'OPERATOR', ldapDn: ldapResult.userDn,
    });

    await ldapService.syncUserAttributes('u-1', ldapResult as any, config);

    expect(mockAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAuditLog.mock.calls[0][0];
    expect(entry.action).toBe('USER_UPDATED');
    expect(entry.targetId).toBe('u-1');
    expect(entry.beforeValue).toMatchObject({ role: 'OPERATOR' });
    expect(entry.afterValue).toMatchObject({ role: 'ADMIN' });
    expect(entry.signatureMeaning).toContain('OPERATOR');
    expect(entry.signatureMeaning).toContain('ADMIN');
  });

  it('does not audit when nothing actually changed (runs on EVERY login)', async () => {
    // Already matches the directory, including the mapped role.
    mockPrisma.user.findUnique.mockResolvedValue({
      username: 'jdoe', fullName: 'J Doe', email: 'jdoe@corp.local',
      department: 'QA', role: 'ADMIN', ldapDn: ldapResult.userDn,
    });

    await ldapService.syncUserAttributes('u-1', ldapResult as any, config);

    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it('does not touch the user or audit when syncAttributes is off', async () => {
    await ldapService.syncUserAttributes('u-1', ldapResult as any, { ...config, syncAttributes: false });

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
