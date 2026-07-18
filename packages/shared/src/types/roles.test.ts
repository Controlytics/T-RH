import { describe, it, expect } from 'vitest';
import { DEFAULT_ROLE_HIERARCHY } from './roles.js';

describe('DEFAULT_ROLE_HIERARCHY', () => {
  it('matches the seed.ts hierarchy levels exactly', () => {
    expect(DEFAULT_ROLE_HIERARCHY).toEqual({
      SUPER_ADMIN: 6,
      ADMIN: 5,
      SUPERVISOR: 4,
      MAINTENANCE: 3,
      OPERATOR: 2,
      VIEWER: 1,
    });
  });
});
