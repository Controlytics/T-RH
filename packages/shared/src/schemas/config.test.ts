import { describe, it, expect } from 'vitest';
import {
  brandingConfigSchema,
  passwordPolicySchema,
  loginSecuritySchema,
  sessionConfigSchema,
  datetimeConfigSchema,
  userIdConfigSchema,
  paginationConfigSchema,
} from './config.js';

describe('brandingConfigSchema', () => {
  it('applies all defaults', () => {
    const result = brandingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appName).toBe('DigiLog');
      expect(result.data.logoText).toBe('DL');
      expect(result.data.primaryColor).toBe('#1e3a5f');
    }
  });

  it('accepts valid hex colors', () => {
    const result = brandingConfigSchema.safeParse({
      primaryColor: '#ff00aa',
      secondaryColor: '#00ff00',
      accentColor: '#0000ff',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid hex colors', () => {
    expect(brandingConfigSchema.safeParse({ primaryColor: 'red' }).success).toBe(false);
    expect(brandingConfigSchema.safeParse({ primaryColor: '#xyz' }).success).toBe(false);
    expect(brandingConfigSchema.safeParse({ primaryColor: '#12345' }).success).toBe(false);
  });

  it('rejects empty appName', () => {
    expect(brandingConfigSchema.safeParse({ appName: '' }).success).toBe(false);
  });

  it('rejects logoText over 5 chars', () => {
    expect(brandingConfigSchema.safeParse({ logoText: 'ABCDEF' }).success).toBe(false);
  });
});

describe('passwordPolicySchema', () => {
  it('applies defaults', () => {
    const result = passwordPolicySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minLength).toBe(8);
      expect(result.data.maxLength).toBe(128);
      expect(result.data.requireUppercase).toBe(true);
      expect(result.data.preventReuseCount).toBe(12);
      expect(result.data.idleTimeoutMinutes).toBe(15);
    }
  });

  it('rejects minLength below 8', () => {
    expect(passwordPolicySchema.safeParse({ minLength: 5 }).success).toBe(false);
  });

  it('rejects maxLength below 32', () => {
    expect(passwordPolicySchema.safeParse({ maxLength: 20 }).success).toBe(false);
  });

  it('accepts custom values within range', () => {
    const result = passwordPolicySchema.safeParse({
      minLength: 12,
      maxLength: 64,
      requireSpecialChars: false,
      passwordExpiryDays: 30,
    });
    expect(result.success).toBe(true);
  });

  it('rejects passwordExpiryDays over 365', () => {
    expect(passwordPolicySchema.safeParse({ passwordExpiryDays: 400 }).success).toBe(false);
  });
});

describe('loginSecuritySchema', () => {
  it('applies defaults', () => {
    const result = loginSecuritySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lockoutType).toBe('TEMPORARY');
      expect(result.data.lockoutDurationMinutes).toBe(30);
    }
  });

  it('rejects invalid lockoutType', () => {
    expect(loginSecuritySchema.safeParse({ lockoutType: 'NONE' }).success).toBe(false);
  });
});

describe('sessionConfigSchema', () => {
  it('applies defaults', () => {
    const result = sessionConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionDurationHours).toBe(8);
      expect(result.data.autoLogoutEnabled).toBe(true);
      expect(result.data.idleTimeoutMinutes).toBe(15);
      expect(result.data.warningMinutes).toBe(2);
    }
  });

  it('rejects sessionDurationHours over 24', () => {
    expect(sessionConfigSchema.safeParse({ sessionDurationHours: 25 }).success).toBe(false);
  });

  it('rejects idle timeout below 5', () => {
    expect(sessionConfigSchema.safeParse({ idleTimeoutMinutes: 2 }).success).toBe(false);
  });
});

describe('datetimeConfigSchema', () => {
  it('applies defaults', () => {
    const result = datetimeConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateFormat).toBe('DD/MM/YYYY');
      expect(result.data.timeFormat).toBe('24-hour');
      expect(result.data.timezone).toBe('Asia/Kolkata');
    }
  });

  it('accepts all valid date formats', () => {
    const formats = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY', 'MMM DD, YYYY'] as const;
    for (const fmt of formats) {
      expect(datetimeConfigSchema.safeParse({ dateFormat: fmt }).success).toBe(true);
    }
  });

  it('rejects invalid date format', () => {
    expect(datetimeConfigSchema.safeParse({ dateFormat: 'YYYY/DD/MM' }).success).toBe(false);
  });

  it('only allows Asia/Kolkata timezone', () => {
    expect(datetimeConfigSchema.safeParse({ timezone: 'UTC' }).success).toBe(false);
  });
});

describe('userIdConfigSchema', () => {
  it('applies defaults', () => {
    const result = userIdConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.format).toBe('LETTERS_NUMBERS');
      expect(result.data.length).toBe(6);
      expect(result.data.letterCase).toBe('UPPERCASE');
      expect(result.data.autoGenerate).toBe(false);
      expect(result.data.prefixSeparator).toBe('-');
    }
  });

  it('accepts all format types', () => {
    const formats = [
      'NUMBERS_ONLY', 'LETTERS_ONLY', 'LETTERS_NUMBERS',
      'PREFIX_NUMBERS', 'PREFIX_LETTERS', 'PREFIX_LETTERS_NUMBERS',
      'CUSTOM_PATTERN',
    ] as const;
    for (const fmt of formats) {
      expect(userIdConfigSchema.safeParse({ format: fmt }).success).toBe(true);
    }
  });

  it('rejects length below 3', () => {
    expect(userIdConfigSchema.safeParse({ length: 2 }).success).toBe(false);
  });

  it('rejects length above 20', () => {
    expect(userIdConfigSchema.safeParse({ length: 21 }).success).toBe(false);
  });

  it('rejects invalid separator', () => {
    expect(userIdConfigSchema.safeParse({ prefixSeparator: '.' }).success).toBe(false);
  });

  it('accepts all valid separators', () => {
    for (const sep of ['-', '_', '', '/']) {
      expect(userIdConfigSchema.safeParse({ prefixSeparator: sep }).success).toBe(true);
    }
  });
});

describe('paginationConfigSchema', () => {
  it('applies defaults', () => {
    const result = paginationConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toEqual([10, 25, 50]);
    }
  });

  it('accepts custom options', () => {
    const result = paginationConfigSchema.safeParse({ options: [5, 20, 100] });
    expect(result.success).toBe(true);
  });

  it('rejects options below 5', () => {
    expect(paginationConfigSchema.safeParse({ options: [3, 10, 50] }).success).toBe(false);
  });

  it('rejects options above 100', () => {
    expect(paginationConfigSchema.safeParse({ options: [10, 50, 200] }).success).toBe(false);
  });

  it('requires between 2 and 10 options', () => {
    // Schema is .min(2).max(10) (was previously .length(3)). Test now
    // documents the relaxed bounds rather than the old fixed length.
    expect(paginationConfigSchema.safeParse({ options: [10] }).success).toBe(false);
    expect(paginationConfigSchema.safeParse({ options: Array(11).fill(10) }).success).toBe(false);
    expect(paginationConfigSchema.safeParse({ options: [10, 50] }).success).toBe(true);
    expect(paginationConfigSchema.safeParse({ options: [10, 25, 50, 100] }).success).toBe(true);
  });
});
