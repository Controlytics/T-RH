/**
 * How the seed writes a default role — pure, so it can be tested without a
 * database and bundled with the seed (`build-bundle.ps1` folds local imports
 * into `seed.mjs`, as it does `./default-roles`).
 *
 * THE RULE (audit 2026-10-03, DATA-4): an EXISTING role keeps its
 * `permissions` and `hierarchyLevel`. Those are what Roles & Access
 * administers, and every customer upgrade runs "migrate deploy + seed"
 * (`scripts/upgrade.ps1`, `scripts/linux/digilog-lib.sh`); the upsert used to
 * write the shipped permission set over whatever had been granted since the
 * install, with no audit row and the toggles still showing on. Only the
 * presentation fields (display name, description, colour, the system flag)
 * are refreshed on an existing row; a role that does not exist is created
 * with everything, as before.
 */
import { defaultRoles } from './default-roles.js';

export type SeedRole = (typeof defaultRoles)[number];

export function roleUpsertArgs(role: SeedRole) {
  return {
    where: { name: role.name },
    update: {
      displayName: role.displayName,
      description: role.description,
      color: role.color,
      isSystem: role.isSystem,
    },
    create: {
      name: role.name,
      displayName: role.displayName,
      description: role.description,
      hierarchyLevel: role.hierarchyLevel,
      permissions: role.permissions,
      color: role.color,
      isSystem: role.isSystem,
      createdBy: 'system',
    },
  };
}
