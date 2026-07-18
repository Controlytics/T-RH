import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password utilities', () => {
  it('hashes a password and produces a bcrypt hash', async () => {
    const hash = await hashPassword('TestPass@123');
    expect(hash).toBeTruthy();
    expect(hash).toMatch(/^\$2[aby]\$\d+\$/);
  });

  it('produces different hashes for the same password (salted)', async () => {
    const hash1 = await hashPassword('SamePass@1');
    const hash2 = await hashPassword('SamePass@1');
    expect(hash1).not.toBe(hash2);
  });

  it('verifies correct password against hash', async () => {
    const password = 'MySecure@Pass1';
    const hash = await hashPassword(password);
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it('rejects incorrect password', async () => {
    const hash = await hashPassword('Correct@Pass1');
    const isValid = await verifyPassword('Wrong@Pass1', hash);
    expect(isValid).toBe(false);
  });

  it('rejects empty password against valid hash', async () => {
    const hash = await hashPassword('Valid@Pass1');
    const isValid = await verifyPassword('', hash);
    expect(isValid).toBe(false);
  });

  it('handles special characters in password', async () => {
    const password = 'P@$$w0rd!#%^&*()';
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it('handles unicode characters in password', async () => {
    const password = 'Passw0rd@日本語';
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });
});
