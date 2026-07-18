import { describe, it, expect } from 'vitest';
import { sanitizeAuditValue } from './audit-diff.js';

describe('sanitizeAuditValue', () => {
  it('drops sensitive keys at any depth, keeps the rest', () => {
    const input = { name: 'F1', password: 'x', passwordHash: 'y', nested: { token: 't', ok: 1 } };
    expect(sanitizeAuditValue(input)).toEqual({ name: 'F1', nested: { ok: 1 } });
  });

  it('returns primitives and null unchanged', () => {
    expect(sanitizeAuditValue('hello')).toBe('hello');
    expect(sanitizeAuditValue(42)).toBe(42);
    expect(sanitizeAuditValue(null)).toBe(null);
  });

  it('sanitizes objects inside arrays', () => {
    expect(sanitizeAuditValue([{ token: 'a', keep: 1 }])).toEqual([{ keep: 1 }]);
  });
});
