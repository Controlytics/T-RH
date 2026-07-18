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

// Keep ROLES export for backward compatibility
export const ROLES = DEFAULT_ROLES;

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

// Keep ROLE_HIERARCHY export for backward compatibility
export const ROLE_HIERARCHY = DEFAULT_ROLE_HIERARCHY;

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
