/**
 * Unit tests for escapeLdapFilterValue (RFC 4515 §3 assertion-value escaping).
 *
 * These tests pin the escape table so that any future regression in the
 * substitution order (\ must come first) is caught immediately.
 *
 * Audit finding: L-1 (Medium-LATENT) — LDAP filter injection.
 */
import { describe, it, expect } from 'vitest';
import { escapeLdapFilterValue } from '../ldap.service.js';

describe('escapeLdapFilterValue', () => {
  it('escapes * (wildcard)', () => {
    expect(escapeLdapFilterValue('star*')).toBe('star\\2a');
  });

  it('escapes ( and ) (parentheses)', () => {
    expect(escapeLdapFilterValue('(uid=*)')).toBe('\\28uid=\\2a\\29');
  });

  it('escapes \\ (backslash) without double-escaping subsequent substitutions', () => {
    // If \\ were processed after *, "star\2a" would produce "star\\5c2a" — wrong.
    expect(escapeLdapFilterValue('C:\\file')).toBe('C:\\5cfile');
  });

  it('escapes NUL byte', () => {
    expect(escapeLdapFilterValue('a\0b')).toBe('a\\00b');
  });

  it('escapes injection payload *)(uid=*)', () => {
    // Classic LDAP filter injection attempt
    expect(escapeLdapFilterValue('*)(uid=*)')).toBe('\\2a\\29\\28uid=\\2a\\29');
  });

  it('does not modify safe usernames', () => {
    expect(escapeLdapFilterValue('john.doe')).toBe('john.doe');
    expect(escapeLdapFilterValue('user123')).toBe('user123');
  });

  it('escapes all five RFC 4515 special characters in one string', () => {
    // \, *, (, ), NUL all present
    expect(escapeLdapFilterValue('\\ * ( ) \0')).toBe('\\5c \\2a \\28 \\29 \\00');
  });

  it('backslash is escaped before * to avoid double-escaping', () => {
    // If order were wrong: * → \2a, then \ → \5c produces \5c2a instead of \5c\2a
    const result = escapeLdapFilterValue('\\*');
    expect(result).toBe('\\5c\\2a');
  });
});
