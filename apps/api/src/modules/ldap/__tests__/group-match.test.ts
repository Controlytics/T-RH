import { describe, it, expect } from 'vitest';
import { ldapService } from '../ldap.service.js';

/**
 * Regression cover for the enterprise-audit finding "over-broad substring group
 * matching" (2026-07-13). `mapGroupsToRole` used to match with
 * `g.toLowerCase().includes(ldapGroupLower)`, so a mapping for "admin" also
 * matched "CN=BackupAdmins,..." and handed the admin role to anyone in a group
 * whose name merely contained the word.
 */
describe('matchesLdapGroup', () => {
  const match = (group: string, configured: string) =>
    ldapService.matchesLdapGroup(group, configured.toLowerCase());

  it('matches an exact full DN', () => {
    expect(match('CN=Cleanroom Admins,OU=Groups,DC=corp,DC=local', 'CN=Cleanroom Admins,OU=Groups,DC=corp,DC=local')).toBe(true);
  });

  it('matches a CN component — how operators actually configure this', () => {
    expect(match('CN=Cleanroom Admins,OU=Groups,DC=corp,DC=local', 'Cleanroom Admins')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(match('CN=CLEANROOM ADMINS,OU=Groups,DC=corp,DC=local', 'cleanroom admins')).toBe(true);
  });

  it('matches a non-CN RDN value', () => {
    expect(match('CN=Ops,OU=Cleanroom,DC=corp,DC=local', 'Cleanroom')).toBe(true);
  });

  it('matches a bare group name with no DN structure', () => {
    expect(match('Operators', 'Operators')).toBe(true);
  });

  // ── the actual bug ──
  it('does NOT substring-match a longer group name', () => {
    expect(match('CN=BackupAdmins,OU=Groups,DC=corp,DC=local', 'admin')).toBe(false);
  });

  it('does NOT match a partial CN', () => {
    expect(match('CN=Cleanroom Admins,OU=Groups,DC=corp,DC=local', 'Cleanroom Admin')).toBe(false);
  });

  it('does NOT match a substring of an OU', () => {
    expect(match('CN=Ops,OU=Contractors,DC=corp,DC=local', 'contract')).toBe(false);
  });

  it('tolerates whitespace around RDNs', () => {
    expect(match('CN=Ops, OU=Cleanroom, DC=corp', 'Cleanroom')).toBe(true);
  });
});

describe('mapGroupsToRole', () => {
  const cfg = (roleMappings: { ldapGroup: string; role: string }[]) =>
    ({ roleMappings, defaultRole: 'OPERATOR' } as any);

  it('falls back to defaultRole when nothing matches', () => {
    expect(ldapService.mapGroupsToRole(['CN=Nobody,DC=x'], cfg([{ ldapGroup: 'Admins', role: 'ADMIN' }]))).toBe('OPERATOR');
  });

  it('resolves a matching mapping by CN', () => {
    expect(ldapService.mapGroupsToRole(['CN=Admins,DC=x'], cfg([{ ldapGroup: 'Admins', role: 'ADMIN' }]))).toBe('ADMIN');
  });

  it('no longer escalates a BackupAdmins member via an "admin" mapping', () => {
    expect(ldapService.mapGroupsToRole(['CN=BackupAdmins,DC=x'], cfg([{ ldapGroup: 'admin', role: 'ADMIN' }]))).toBe('OPERATOR');
  });

  it('never confers SUPER_ADMIN, even on an exact match', () => {
    expect(
      ldapService.mapGroupsToRole(['CN=Admins,DC=x'], cfg([{ ldapGroup: 'Admins', role: 'SUPER_ADMIN' }])),
    ).toBe('OPERATOR');
  });

  it('skips a SUPER_ADMIN mapping but still honours a later valid one', () => {
    expect(
      ldapService.mapGroupsToRole(
        ['CN=Admins,DC=x'],
        cfg([{ ldapGroup: 'Admins', role: 'SUPER_ADMIN' }, { ldapGroup: 'Admins', role: 'ADMIN' }]),
      ),
    ).toBe('ADMIN');
  });
});
