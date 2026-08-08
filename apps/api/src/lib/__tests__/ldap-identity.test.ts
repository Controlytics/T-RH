import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Cover for the 2026-08-08 directory-credential fixes.
 *
 * The defect these guard against was not "LDAP is broken" — LDAP login worked.
 * It was that EVERY OTHER credential surface (re-authentication, admin password
 * reset, password expiry) had no idea directory users existed and treated the
 * `LDAP_EXTERNAL_AUTH` sentinel as if it were a bcrypt hash. The most damaging
 * consequence: `bcrypt.compare(anything, 'LDAP_EXTERNAL_AUTH')` is always false,
 * so re-authentication — the second factor of a 21 CFR §11.200 electronic
 * signature — could never succeed for an AD-authenticated user. Every approval,
 * signature, bypass and reauth-gated config save was unreachable for them.
 */

const mockVerifyPassword = vi.hoisted(() => vi.fn());
const mockGetConfig = vi.hoisted(() => vi.fn());
const mockAuthenticateUser = vi.hoisted(() => vi.fn());

vi.mock('../password.js', () => ({ verifyPassword: mockVerifyPassword }));
vi.mock('../../modules/ldap/ldap.service.js', () => ({
  LDAP_SENTINEL_HASH: 'LDAP_EXTERNAL_AUTH',
  ldapService: { getConfig: mockGetConfig, authenticateUser: mockAuthenticateUser },
}));

const { isLdapUser, verifyCredential, LDAP_SENTINEL_HASH } = await import('../ldap-identity.js');

const localUser = { username: 'RB0001', role: 'OPERATOR', authSource: 'local', passwordHash: '$2b$12$realhash' };
const adUser = { username: 'EMP1234', role: 'SUPERVISOR', authSource: 'ldap', passwordHash: LDAP_SENTINEL_HASH };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({ enabled: true });
});

describe('isLdapUser', () => {
  it('recognises an authSource=ldap account', () => {
    expect(isLdapUser(adUser)).toBe(true);
  });

  it('recognises a sentinel hash even when authSource disagrees', () => {
    // Physical state wins over stated intent: there is no local password here
    // regardless of what the column says, so the directory path is the only one
    // that can possibly authenticate this row.
    expect(isLdapUser({ role: 'OPERATOR', authSource: 'local', passwordHash: LDAP_SENTINEL_HASH })).toBe(true);
  });

  it('treats a normal local account as local', () => {
    expect(isLdapUser(localUser)).toBe(false);
  });

  it('NEVER treats SUPER_ADMIN as a directory account', () => {
    // The break-glass account must stay locally authenticated so it still works
    // when the directory is unreachable. mapGroupsToRole also refuses to
    // provision one, so this should be unreachable in practice — belt and braces.
    expect(isLdapUser({ role: 'SUPER_ADMIN', authSource: 'ldap', passwordHash: LDAP_SENTINEL_HASH })).toBe(false);
  });
});

describe('verifyCredential', () => {
  it('uses bcrypt for a local user and does NOT touch the directory', async () => {
    mockVerifyPassword.mockResolvedValue(true);
    const result = await verifyCredential(localUser, 'Admin@123');
    expect(result).toMatchObject({ ok: true, via: 'local', lockoutDelegated: false });
    expect(mockAuthenticateUser).not.toHaveBeenCalled();
  });

  it('reports a wrong local password without delegating lockout', async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const result = await verifyCredential(localUser, 'wrong');
    expect(result).toMatchObject({ ok: false, via: 'local', lockoutDelegated: false });
  });

  // ── the bug ──
  it('authenticates a directory user by LDAP bind, not bcrypt', async () => {
    mockAuthenticateUser.mockResolvedValue({ success: true, userDn: 'CN=E,DC=x', attributes: {}, groups: [] });
    const result = await verifyCredential(adUser, 'TheirADPassword');

    expect(result.ok).toBe(true);
    expect(result.via).toBe('ldap');
    expect(mockAuthenticateUser).toHaveBeenCalledWith('EMP1234', 'TheirADPassword');
    // The whole point: bcrypt must never be consulted for these users, because
    // comparing against the sentinel is a guaranteed false.
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });

  it('delegates lockout to the directory on a failed bind', async () => {
    mockAuthenticateUser.mockResolvedValue(null);
    const result = await verifyCredential(adUser, 'wrong');
    expect(result).toMatchObject({ ok: false, via: 'ldap', lockoutDelegated: true });
  });

  it('fails closed — and explains itself — when LDAP is disabled', async () => {
    mockGetConfig.mockResolvedValue({ enabled: false });
    const result = await verifyCredential(adUser, 'anything');
    expect(result.ok).toBe(false);
    expect(result.unavailableReason).toMatch(/disabled/i);
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });

  it('fails closed when the directory server errors, rather than throwing', async () => {
    // A caller mid-login must get a verdict, not an exception that escapes as a
    // 500 and tells an attacker the directory is down.
    mockAuthenticateUser.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await verifyCredential(adUser, 'anything');
    expect(result).toMatchObject({ ok: false, lockoutDelegated: true });
    expect(result.unavailableReason).toContain('ECONNREFUSED');
  });

  it('does not let the sentinel become a free pass', async () => {
    // Regression cover for the shape of audit finding C1: if any future edit
    // makes the directory branch fall through to bcrypt, this fails.
    mockGetConfig.mockResolvedValue({ enabled: false });
    mockVerifyPassword.mockResolvedValue(true); // pretend bcrypt says yes
    const result = await verifyCredential(adUser, 'LDAP_EXTERNAL_AUTH');
    expect(result.ok).toBe(false);
  });
});
