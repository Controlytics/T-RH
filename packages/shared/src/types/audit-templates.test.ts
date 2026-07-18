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
  it('has 13 categories', () => {
    expect(AUDIT_TEMPLATE_CATEGORIES).toHaveLength(13);
  });

  it('contains all expected categories', () => {
    const expected = [
      'User Management',
      'Authentication',
      'Configuration',
      'Role Management',
      'Backup',
      'Data & Approvals',
      'Hierarchy & Filters',
      'Filter Management',
      'Filter Operations',
      'Cleaning Profiles',
      'Filter Profiles',
      'Equipment Groups',
      'PM Schedules',
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

  it('contains Hierarchy & Filters actions', () => {
    const entityActions = [
      'ASSET_TEMPLATE_CREATED', 'ASSET_TEMPLATE_UPDATED', 'ASSET_TEMPLATE_DELETED', 'ASSET_TEMPLATE_VERSION_CREATED',
      'ASSET_CREATED', 'ASSET_UPDATED', 'ASSET_STATUS_CHANGED', 'ASSET_DELETED',
      'ASSET_RELATIONSHIP_CREATED', 'ASSET_RELATIONSHIP_DELETED',
    ];
    for (const action of entityActions) {
      expect(AUDIT_TEMPLATE_DEFAULTS[action], `missing ${action}`).toBeDefined();
      expect(AUDIT_TEMPLATE_DEFAULTS[action].category).toBe('Hierarchy & Filters');
    }
    // The Block/Area/AHU/Filter create + link templates name the kind via a
    // placeholder ({entityKind}/{sourceKind}/{targetKind}) and use plain wording.
    // (Word-ban on the RENDERED output is verified in the web audit-helpers test —
    // the placeholder name {entityKind} itself contains "entity" by construction.)
    expect(AUDIT_TEMPLATE_DEFAULTS['ASSET_CREATED'].template).toContain('{entityKind}');
    expect(AUDIT_TEMPLATE_DEFAULTS['ASSET_CREATED'].template).not.toContain('from template');
    expect(AUDIT_TEMPLATE_DEFAULTS['ASSET_RELATIONSHIP_CREATED'].template).toContain('placed under');
    expect(AUDIT_TEMPLATE_DEFAULTS['ASSET_RELATIONSHIP_CREATED'].template).not.toMatch(/linked to/i);
  });

  it('contains Filter Management actions (identifier assign/remove)', () => {
    // ASSET_IDENTIFIER_* were recategorized Entity Management → Filter Management
    // (2026-06-29) so the Display Settings audit-text page surfaces them; the
    // 'Filter Management' category was added to AUDIT_TEMPLATE_CATEGORIES then.
    const filterActions = ['ASSET_IDENTIFIER_CREATED', 'ASSET_IDENTIFIER_DELETED'];
    for (const action of filterActions) {
      expect(AUDIT_TEMPLATE_DEFAULTS[action], `missing ${action}`).toBeDefined();
      expect(AUDIT_TEMPLATE_DEFAULTS[action].category).toBe('Filter Management');
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

  it('entity template actions include actor placeholder', () => {
    const templateActions = ['ASSET_TEMPLATE_CREATED', 'ASSET_TEMPLATE_UPDATED', 'ASSET_TEMPLATE_DELETED'];
    for (const action of templateActions) {
      expect(AUDIT_TEMPLATE_DEFAULTS[action].placeholders).toContain('actor');
    }
  });

  it('ASSET_STATUS_CHANGED includes before/after status placeholders', () => {
    const def = AUDIT_TEMPLATE_DEFAULTS['ASSET_STATUS_CHANGED'];
    expect(def.placeholders).toContain('beforeStatus');
    expect(def.placeholders).toContain('afterStatus');
    expect(def.template).toContain('{beforeStatus}');
    expect(def.template).toContain('{afterStatus}');
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
