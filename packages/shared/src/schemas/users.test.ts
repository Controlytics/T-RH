import { describe, it, expect } from 'vitest';
import {
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
  userQuerySchema,
  bulkDeleteUsersSchema,
} from './users.js';

describe('createUserSchema', () => {
  const validUser = {
    username: 'testuser',
    fullName: 'Test User',
    email: 'test@example.com',
    role: 'OPERATOR',
    password: 'StrongP@ss1',
    confirmPassword: 'StrongP@ss1',
  };

  it('accepts valid user data', () => {
    const result = createUserSchema.safeParse(validUser);
    expect(result.success).toBe(true);
  });

  it('accepts with optional department', () => {
    const result = createUserSchema.safeParse({ ...validUser, department: 'Engineering' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.department).toBe('Engineering');
  });

  it('defaults status to ENABLED', () => {
    const result = createUserSchema.safeParse(validUser);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe('ENABLED');
  });

  it('rejects username shorter than 6 characters', () => {
    const result = createUserSchema.safeParse({ ...validUser, username: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects username longer than 50 characters', () => {
    const result = createUserSchema.safeParse({ ...validUser, username: 'a'.repeat(51) });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email', () => {
    const result = createUserSchema.safeParse({ ...validUser, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects password shorter than 8 characters', () => {
    const result = createUserSchema.safeParse({ ...validUser, password: 'Ab@1', confirmPassword: 'Ab@1' });
    expect(result.success).toBe(false);
  });

  it('rejects mismatching passwords', () => {
    const result = createUserSchema.safeParse({ ...validUser, confirmPassword: 'DifferentP@ss1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty role', () => {
    const result = createUserSchema.safeParse({ ...validUser, role: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid status', () => {
    const result = createUserSchema.safeParse({ ...validUser, status: 'LOCKED' });
    expect(result.success).toBe(false);
  });
});

describe('updateUserSchema', () => {
  it('accepts partial updates', () => {
    expect(updateUserSchema.safeParse({ fullName: 'New Name' }).success).toBe(true);
    expect(updateUserSchema.safeParse({ email: 'new@test.com' }).success).toBe(true);
    expect(updateUserSchema.safeParse({ role: 'ADMIN' }).success).toBe(true);
    expect(updateUserSchema.safeParse({ status: 'DISABLED' }).success).toBe(true);
  });

  it('accepts empty object', () => {
    expect(updateUserSchema.safeParse({}).success).toBe(true);
  });

  it('rejects invalid email', () => {
    expect(updateUserSchema.safeParse({ email: 'bad' }).success).toBe(false);
  });

  // Email is OPTIONAL on update — an emailless user's edit form submits '' or
  // null. Both must pass so a role-only change isn't blocked by the email field.
  it('accepts empty-string email', () => {
    expect(updateUserSchema.safeParse({ email: '' }).success).toBe(true);
  });

  it('accepts null email', () => {
    expect(updateUserSchema.safeParse({ email: null }).success).toBe(true);
  });

  it('accepts a role change with a blank/null email (the reported bug)', () => {
    expect(updateUserSchema.safeParse({ role: 'ADMIN', email: '' }).success).toBe(true);
    expect(updateUserSchema.safeParse({ role: 'ADMIN', email: null }).success).toBe(true);
  });

  it('rejects invalid status value', () => {
    expect(updateUserSchema.safeParse({ status: 'LOCKED' }).success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  it('accepts valid password', () => {
    expect(resetPasswordSchema.safeParse({ newPassword: 'NewPass@123' }).success).toBe(true);
  });

  it('rejects short password', () => {
    expect(resetPasswordSchema.safeParse({ newPassword: 'Ab@1' }).success).toBe(false);
  });
});

describe('userQuerySchema', () => {
  it('applies defaults', () => {
    const result = userQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('coerces string page/limit to numbers', () => {
    const result = userQuerySchema.safeParse({ page: '3', limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(50);
    }
  });

  it('accepts valid status filter', () => {
    expect(userQuerySchema.safeParse({ status: 'ENABLED' }).success).toBe(true);
    expect(userQuerySchema.safeParse({ status: 'LOCKED' }).success).toBe(true);
    expect(userQuerySchema.safeParse({ status: 'EXPIRED' }).success).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(userQuerySchema.safeParse({ status: 'DELETED' }).success).toBe(false);
  });

  it('accepts limit up to 500 (recipient pickers request the whole user list)', () => {
    expect(userQuerySchema.safeParse({ limit: '500' }).success).toBe(true);
  });

  it('rejects limit over 500', () => {
    expect(userQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
  });
});

describe('bulkDeleteUsersSchema', () => {
  it('accepts array of UUIDs', () => {
    const result = bulkDeleteUsersSchema.safeParse({
      userIds: ['550e8400-e29b-41d4-a716-446655440000'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty array', () => {
    expect(bulkDeleteUsersSchema.safeParse({ userIds: [] }).success).toBe(false);
  });

  it('rejects non-UUID strings', () => {
    expect(bulkDeleteUsersSchema.safeParse({ userIds: ['not-a-uuid'] }).success).toBe(false);
  });

  it('rejects more than 50 user IDs', () => {
    const ids = Array(51).fill('550e8400-e29b-41d4-a716-446655440000');
    expect(bulkDeleteUsersSchema.safeParse({ userIds: ids }).success).toBe(false);
  });
});
