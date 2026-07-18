import { describe, it, expect } from 'vitest';
import { loginSchema, passwordChangeSchema } from './auth.js';

describe('loginSchema', () => {
  it('accepts valid credentials', () => {
    const result = loginSchema.safeParse({ username: 'admin', password: 'Admin@123' });
    expect(result.success).toBe(true);
  });

  it('rejects empty username', () => {
    const result = loginSchema.safeParse({ username: '', password: 'Admin@123' });
    expect(result.success).toBe(false);
  });

  it('rejects empty password', () => {
    const result = loginSchema.safeParse({ username: 'admin', password: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(loginSchema.safeParse({}).success).toBe(false);
    expect(loginSchema.safeParse({ username: 'admin' }).success).toBe(false);
    expect(loginSchema.safeParse({ password: 'pass' }).success).toBe(false);
  });
});

describe('passwordChangeSchema', () => {
  it('accepts valid password change', () => {
    const result = passwordChangeSchema.safeParse({
      currentPassword: 'OldPass@1',
      newPassword: 'NewPass@1',
      confirmPassword: 'NewPass@1',
    });
    expect(result.success).toBe(true);
  });

  it('allows optional currentPassword (for temp password users)', () => {
    const result = passwordChangeSchema.safeParse({
      newPassword: 'NewPass@1',
      confirmPassword: 'NewPass@1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when passwords do not match', () => {
    const result = passwordChangeSchema.safeParse({
      newPassword: 'NewPass@1',
      confirmPassword: 'Different@1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('confirmPassword');
    }
  });

  it('rejects short newPassword', () => {
    const result = passwordChangeSchema.safeParse({
      newPassword: 'Abc@1',
      confirmPassword: 'Abc@1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty confirmPassword', () => {
    const result = passwordChangeSchema.safeParse({
      newPassword: 'NewPass@1',
      confirmPassword: '',
    });
    expect(result.success).toBe(false);
  });
});

