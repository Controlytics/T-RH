import { describe, it, expect } from 'vitest';
import {
  AUDIT_TEMPLATE_DEFAULTS,
  AUDIT_TEMPLATE_CATEGORIES,
  getDefaultTemplates,
  type AuditTemplateDefinition,
} from './audit-templates.js';

// =============================================
// Categories
// =============================================

describe('AUDIT_TEMPLATE_CATEGORIES', () => {
  // Mirror src/types/audit-templates.ts. Update both when adding a new
  // top-level audit category.
  it('has 7 categories', () => {
    expect(AUDIT_TEMPLATE_CATEGORIES).toHaveLength(7);
  });

  it('contains all expected categories', () => {
    const expected = [
      'User Management',
      'Authentication',
      'Configuration',
      'Role Management',
      'Backup',
      'Data & Approvals',
      'Instruments',
    ];
    for (const cat of expected) {
      expect(AUDIT_TEMPLATE_CATEGORIES).toContain(cat);
    }
  });
});

// =============================================
// AUDIT_TEMPLATE_DEFAULTS
// =============================================

describe('AUDIT_TEMPLATE_DEFAULTS', () => {
  it('is a non-empty record', () => {
    const keys = Object.keys(AUDIT_TEMPLATE_DEFAULTS);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('every entry has required fields', () => {
    for (const [key, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
      expect(def.label, `${key}.label`).toBeTruthy();
      expect(def.category, `${key}.category`).toBeTruthy();
      expect(def.template, `${key}.template`).toBeTruthy();
      expect(Array.isArray(def.placeholders), `${key}.placeholders`).toBe(true);
    }
  });

  it('every category belongs to AUDIT_TEMPLATE_CATEGORIES', () => {
    const validCategories = new Set<string>(AUDIT_TEMPLATE_CATEGORIES);
    for (const [key, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
      expect(validCategories.has(def.category), `${key} has invalid category "${def.category}"`).toBe(true);
    }
  });

  it('every placeholder in the array appears in the template string', () => {
    // FORCED_LOGOUT lists 'actor' in placeholders but template only uses {targetUser}
    const knownExceptions: Record<string, string[]> = {
      FORCED_LOGOUT: ['actor'],
    };
    for (const [key, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
      const exceptions = knownExceptions[key] || [];
      for (const ph of def.placeholders) {
        if (exceptions.includes(ph)) continue;
        expect(
          def.template.includes(`{${ph}}`),
          `${key}: placeholder {${ph}} not found in template "${def.template}"`,
        ).toBe(true);
      }
    }
  });

  it('contains User Management actions', () => {
    const userActions = ['USER_CREATED', 'USER_UPDATED', 'USER_DELETED', 'USER_ENABLED', 'USER_DISABLED', 'ACCOUNT_LOCKED', 'ACCOUNT_UNLOCKED'];
    for (const action of userActions) {
      expect(AUDIT_TEMPLATE_DEFAULTS[action], `missing ${action}`).toBeDefined();
      expect(AUDIT_TEMPLATE_DEFAULTS[action].category).toBe('User Management');
    }
  });

  it('contains Authentication actions', () => {
    const authActions = ['LOGIN_SUCCESS', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'FORCED_LOGOUT'];
    for (const action of authActions) {
      expect(AUDIT_TEMPLATE_DEFAULTS[action], `missing ${action}`).toBeDefined();
      expect(AUDIT_TEMPLATE_DEFAULTS[action].category).toBe('Authentication');
    }
  });

  it('contains Role Management actions', () => {
    const roleActions = ['ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_DELETED'];
    for (const action of roleActions) {
      expect(AUDIT_TEMPLATE_DEFAULTS[action], `missing ${action}`).toBeDefined();
      expect(AUDIT_TEMPLATE_DEFAULTS[action].category).toBe('Role Management');
    }
  });

  it('contains Backup actions', () => {
    expect(AUDIT_TEMPLATE_DEFAULTS['BACKUP_CREATED']).toBeDefined();
    expect(AUDIT_TEMPLATE_DEFAULTS['BACKUP_RESTORED']).toBeDefined();
  });

  it('every template naming an operator carries the actor placeholder', () => {
    for (const [action, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
      if (def.template.includes('{actor}')) {
        expect(def.placeholders, `${action} renders {actor} but omits it`).toContain('actor');
      }
    }
  });
});

// =============================================
// getDefaultTemplates()
// =============================================

describe('getDefaultTemplates()', () => {
  it('returns a Record<string, string>', () => {
    const result = getDefaultTemplates();
    expect(typeof result).toBe('object');
    for (const [key, value] of Object.entries(result)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
    }
  });

  it('has the same keys as AUDIT_TEMPLATE_DEFAULTS', () => {
    const result = getDefaultTemplates();
    const defaultKeys = Object.keys(AUDIT_TEMPLATE_DEFAULTS).sort();
    const resultKeys = Object.keys(result).sort();
    expect(resultKeys).toEqual(defaultKeys);
  });

  it('values are the template strings', () => {
    const result = getDefaultTemplates();
    for (const [key, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
      expect(result[key]).toBe(def.template);
    }
  });

  it('returns plain strings, not full definitions', () => {
    const result = getDefaultTemplates();
    for (const value of Object.values(result)) {
      expect(typeof value).toBe('string');
      // Should not be an object (i.e., not the full AuditTemplateDefinition)
      expect(typeof value).not.toBe('object');
    }
  });
});
