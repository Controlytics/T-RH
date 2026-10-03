import { describe, it, expect } from 'vitest';
import { roleUpsertArgs } from '../../../prisma/seed-roles.js';
import { defaultRoles } from '../../../prisma/default-roles.js';

/**
 * Audit 2026-10-03, DATA-4: every customer upgrade runs "migrate deploy +
 * seed", and the seed's role upsert wrote the SHIPPED permission set over
 * whatever Roles & Access had granted since the install — silently, with no
 * audit row, while the toggles still showed on. An existing role must keep
 * its authorisation fields; only presentation is refreshed. A missing role
 * is still created whole.
 */
describe('roleUpsertArgs', () => {
  it('never rewrites permissions or hierarchy level on an existing role', () => {
    for (const role of defaultRoles) {
      const { update } = roleUpsertArgs(role);
      expect(Object.keys(update)).not.toContain('permissions');
      expect(Object.keys(update)).not.toContain('hierarchyLevel');
    }
  });

  it('still refreshes the presentation fields on an existing role', () => {
    const { update } = roleUpsertArgs(defaultRoles[0]);
    expect(update).toEqual({
      displayName: defaultRoles[0].displayName,
      description: defaultRoles[0].description,
      color: defaultRoles[0].color,
      isSystem: defaultRoles[0].isSystem,
    });
  });

  it('creates a missing role with everything, including its permissions and level', () => {
    const r = defaultRoles.find((x) => x.name === 'OPERATOR')!;
    const { where, create } = roleUpsertArgs(r);
    expect(where).toEqual({ name: 'OPERATOR' });
    expect(create).toMatchObject({
      name: 'OPERATOR', hierarchyLevel: r.hierarchyLevel, permissions: r.permissions, createdBy: 'system',
    });
  });
});
