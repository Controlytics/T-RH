import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
}));

vi.mock('./prisma.js', () => ({
  prisma: {
    systemConfig: { findUnique: mockFindUnique },
  },
}));

// Use the real userIdConfigSchema (it applies zod defaults like
// format: 'LETTERS_NUMBERS' when fields are missing). The previous mock
// just passed config through unchanged, which broke the "no config in DB"
// case where the impl needs zod-applied defaults to populate cfg.format.

import { validateUserId } from './user-id-validator.js';

// ── Helpers ─────────────────────────────────────────────────

function mockConfig(overrides: Record<string, unknown> = {}) {
  mockFindUnique.mockResolvedValue({
    configValue: {
      length: 8,
      format: 'LETTERS_NUMBERS',
      letterCase: 'MIXED',
      prefix: '',
      prefixSeparator: '',
      ...overrides,
    },
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('validateUserId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Length validation ──
  describe('length validation', () => {
    it('passes when userId matches configured length', async () => {
      mockConfig({ length: 6, format: 'LETTERS_NUMBERS' });
      const result = await validateUserId('ABC123');
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('fails when userId is too short', async () => {
      mockConfig({ length: 8 });
      const result = await validateUserId('ABC');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('exactly 8 characters');
    });

    it('fails when userId is too long', async () => {
      mockConfig({ length: 4 });
      const result = await validateUserId('ABCDEF');
      expect(result.valid).toBe(false);
    });
  });

  // ── Format: NUMBERS_ONLY ──
  describe('NUMBERS_ONLY format', () => {
    it('passes for all digits', async () => {
      mockConfig({ length: 5, format: 'NUMBERS_ONLY' });
      const result = await validateUserId('12345');
      expect(result.valid).toBe(true);
    });

    it('fails for letters mixed with digits', async () => {
      mockConfig({ length: 5, format: 'NUMBERS_ONLY' });
      const result = await validateUserId('123AB');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('only numbers')]));
    });
  });

  // ── Format: LETTERS_ONLY ──
  describe('LETTERS_ONLY format', () => {
    it('passes for all letters', async () => {
      mockConfig({ length: 5, format: 'LETTERS_ONLY' });
      const result = await validateUserId('ABCDE');
      expect(result.valid).toBe(true);
    });

    it('fails for digits', async () => {
      mockConfig({ length: 5, format: 'LETTERS_ONLY' });
      const result = await validateUserId('ABC12');
      expect(result.valid).toBe(false);
    });
  });

  // ── Format: LETTERS_NUMBERS ──
  describe('LETTERS_NUMBERS format', () => {
    it('passes for alphanumeric', async () => {
      mockConfig({ length: 6, format: 'LETTERS_NUMBERS' });
      const result = await validateUserId('ABC123');
      expect(result.valid).toBe(true);
    });

    it('fails for special characters', async () => {
      mockConfig({ length: 6, format: 'LETTERS_NUMBERS' });
      const result = await validateUserId('AB@#12');
      expect(result.valid).toBe(false);
    });
  });

  // ── Prefix validation ──
  describe('prefix validation', () => {
    it('passes when userId starts with correct prefix', async () => {
      mockConfig({ length: 7, format: 'PREFIX_NUMBERS', prefix: 'EMP', prefixSeparator: '-' });
      const result = await validateUserId('EMP-001');
      expect(result.valid).toBe(true);
    });

    it('fails when userId does not start with prefix', async () => {
      mockConfig({ length: 7, format: 'PREFIX_NUMBERS', prefix: 'EMP', prefixSeparator: '-' });
      const result = await validateUserId('USR-001');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('must start with')]));
    });
  });

  // ── Format: PREFIX_NUMBERS ──
  describe('PREFIX_NUMBERS format', () => {
    it('validates digits after prefix', async () => {
      mockConfig({ length: 7, format: 'PREFIX_NUMBERS', prefix: 'EMP', prefixSeparator: '-' });
      const result = await validateUserId('EMP-ABC');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('numbers after prefix')]));
    });
  });

  // ── Format: PREFIX_LETTERS ──
  describe('PREFIX_LETTERS format', () => {
    it('validates letters after prefix', async () => {
      mockConfig({ length: 6, format: 'PREFIX_LETTERS', prefix: 'ID', prefixSeparator: '-' });
      const result = await validateUserId('ID-ABC');
      expect(result.valid).toBe(true);
    });

    it('fails for digits after prefix', async () => {
      mockConfig({ length: 6, format: 'PREFIX_LETTERS', prefix: 'ID', prefixSeparator: '-' });
      const result = await validateUserId('ID-123');
      expect(result.valid).toBe(false);
    });
  });

  // ── Letter case ──
  describe('letter case validation', () => {
    it('passes UPPERCASE when all uppercase', async () => {
      mockConfig({ length: 5, format: 'LETTERS_ONLY', letterCase: 'UPPERCASE' });
      const result = await validateUserId('ABCDE');
      expect(result.valid).toBe(true);
    });

    it('fails UPPERCASE when has lowercase', async () => {
      mockConfig({ length: 5, format: 'LETTERS_ONLY', letterCase: 'UPPERCASE' });
      const result = await validateUserId('ABcDE');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('uppercase')]));
    });

    it('passes LOWERCASE when all lowercase', async () => {
      mockConfig({ length: 5, format: 'LETTERS_ONLY', letterCase: 'LOWERCASE' });
      const result = await validateUserId('abcde');
      expect(result.valid).toBe(true);
    });

    it('fails LOWERCASE when has uppercase', async () => {
      mockConfig({ length: 5, format: 'LETTERS_ONLY', letterCase: 'LOWERCASE' });
      const result = await validateUserId('abcDE');
      expect(result.valid).toBe(false);
    });

    it('passes ANY case for mixed case', async () => {
      mockConfig({ length: 5, format: 'LETTERS_ONLY', letterCase: 'MIXED' });
      const result = await validateUserId('AbCdE');
      expect(result.valid).toBe(true);
    });
  });

  // ── Custom pattern ──
  describe('CUSTOM_PATTERN format', () => {
    it('passes when regex matches', async () => {
      mockConfig({
        length: 6,
        format: 'CUSTOM_PATTERN',
        customPattern: '[A-Z]{2}\\d{4}',
      });
      const result = await validateUserId('AB1234');
      expect(result.valid).toBe(true);
    });

    it('fails when regex does not match', async () => {
      mockConfig({
        length: 6,
        format: 'CUSTOM_PATTERN',
        customPattern: '[A-Z]{2}\\d{4}',
        customPatternDescription: 'Must be 2 letters + 4 digits',
      });
      const result = await validateUserId('123456');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('2 letters + 4 digits')]));
    });
  });

  // ── Default config ──
  describe('default config', () => {
    it('uses defaults when no config in DB', async () => {
      mockFindUnique.mockResolvedValue(null);
      // Should not throw — uses default config from schema
      const result = await validateUserId('test');
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
    });
  });
});
