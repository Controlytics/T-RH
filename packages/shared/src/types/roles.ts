// Default system roles - these are created during seed
// Actual roles are now stored in the database and managed dynamically
export const DEFAULT_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  MAINTENANCE: 'MAINTENANCE',
  OPERATOR: 'OPERATOR',
  VIEWER: 'VIEWER',
} as const;

// `ROLES` alias removed 2026-08-29 (audit L9). It was kept "for backward
// compatibility" with a caller that no longer exists — a whole-repo grep for
// an import of it returns nothing. Two names for one symbol means a
// find-all-usages search returns half the truth, which on the ROLE table is
// exactly where that hurts.

// Role is now a string type to support dynamic roles
export type Role = string;

// Interface for role data from the database
export interface RoleData {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  hierarchyLevel: number;
  permissions: string[];
  color: string;
  isSystem: boolean;
  isActive: boolean;
}

// Default hierarchy levels for system roles
export const DEFAULT_ROLE_HIERARCHY: Record<string, number> = {
  SUPER_ADMIN: 6,
  ADMIN: 5,
  SUPERVISOR: 4,
  MAINTENANCE: 3,
  OPERATOR: 2,
  VIEWER: 1,
};

// `ROLE_HIERARCHY` alias removed 2026-08-29 (audit L9) — same reasoning as
// the DEFAULT_ROLES alias above; no importer anywhere in the repo.

/**
 * @deprecated Use API endpoint /api/roles/:name/creatable instead
 */
export const CREATABLE_ROLES: Record<string, string[]> = {
  SUPER_ADMIN: ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'MAINTENANCE', 'OPERATOR', 'VIEWER'],
  ADMIN: ['ADMIN', 'SUPERVISOR', 'MAINTENANCE', 'OPERATOR', 'VIEWER'],
};

export const USER_STATUS = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
  LOCKED: 'LOCKED',
  EXPIRED: 'EXPIRED',
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
