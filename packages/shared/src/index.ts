// Types
export { ROLES, DEFAULT_ROLES, ROLE_HIERARCHY, DEFAULT_ROLE_HIERARCHY, CREATABLE_ROLES, USER_STATUS } from './types/roles.js';
export type { Role, UserStatus, RoleData } from './types/roles.js';

export { AUDIT_ACTIONS } from './types/audit-actions.js';
export type { AuditAction } from './types/audit-actions.js';

export { PERMISSIONS, MANAGE_PERMISSION_SUFFIXES, hasEffectivePermission } from './types/permissions.js';
export type { Permission } from './types/permissions.js';

export { PERMISSION_CATEGORIES } from './types/permission-categories.js';
export type { PermissionItem } from './types/permission-categories.js';

export { FEATURE_PRIVILEGES, FEATURE_PRIVILEGE_CATEGORIES, FEATURE_TO_PERMISSION_MAP } from './types/feature-privileges.js';
export type { FeaturePrivilege } from './types/feature-privileges.js';

export { SIDEBAR_ITEMS } from './types/sidebar-items.js';
export type { SidebarItem } from './types/sidebar-items.js';

export { SIDEBAR_PRIVILEGE_MAP, getPrivilegesForSection } from './types/sidebar-privilege-map.js';
export type { SidebarSection } from './types/sidebar-privilege-map.js';

export {
  PERMISSION_TREE,
  deriveFeaturePrivileges,
  deriveFeatureToPermissionMap,
  deriveSidebarPrivilegeMap,
  resolveNodePermissions,
  resolveNodeGate,
  resolveNodeGateRoles,
} from './types/permission-tree.js';
export type { PermissionNode, SidebarGroup } from './types/permission-tree.js';

export { REAUTH_ACTIONS, REAUTH_ACTION_CATEGORIES } from './types/reauth-actions.js';
export type { ReauthAction, ReauthActionCategory } from './types/reauth-actions.js';

export { AUDIT_TEMPLATE_DEFAULTS, AUDIT_TEMPLATE_CATEGORIES, getDefaultTemplates } from './types/audit-templates.js';
export type { AuditTemplateDefinition, AuditTemplateCategory } from './types/audit-templates.js';

export type {
  TapeQuestion,
  TapeStage,
  TapeConnection,
  TapeInstrument,
  TapeCycle,
  TapePinnedProfile,
  TapePinnedEquipmentGroup,
  TapeChecklistProfile,
  TapeChecklistEvent,
  TapeInput,
  ActionKind,
  OperatingRangeMap,
  AdvanceToStageAction,
  SubmitChecklistAction,
  SubmitDryerReadingsAction,
  SetDryerDurationAction,
  BypassStageAction,
  TerminateCycleAction,
  CompleteCycleAction,
  Action,
  ActionTape,
  StaleTapeError,
} from './types/action-tape.js';

// Schemas
export { loginSchema, passwordChangeSchema } from './schemas/auth.js';
export type { LoginInput, PasswordChangeInput } from './schemas/auth.js';

export { createUserSchema, updateUserSchema, resetPasswordSchema, userQuerySchema, bulkDeleteUsersSchema } from './schemas/users.js';
export type { CreateUserInput, UpdateUserInput, ResetPasswordInput, UserQueryInput, BulkDeleteUsersInput } from './schemas/users.js';

export { brandingConfigSchema, passwordPolicySchema, loginSecuritySchema, sessionConfigSchema, datetimeConfigSchema, userIdConfigSchema, auditTemplatesSchema, paginationConfigSchema, offlineCacheConfigSchema, exportLimitConfigSchema, EXPORT_LIMIT_HARD_CEILING, EXPORT_LIMIT_DEFAULT_MAX, EXPORT_LIMIT_DEFAULT_MESSAGE } from './schemas/config.js';
export type { BrandingConfig, PasswordPolicyConfig, LoginSecurityConfig, SessionConfig, DatetimeConfig, UserIdConfig, AuditTemplatesConfig, PaginationConfig, OfflineCacheConfig, ExportLimitConfig } from './schemas/config.js';

export { auditQuerySchema } from './schemas/audit.js';
export type { AuditQueryInput } from './schemas/audit.js';

export { actionReauthConfigSchema } from './schemas/action-reauth.js';
export type { ActionReauthConfig } from './schemas/action-reauth.js';

export {
  ATTRIBUTE_DATA_TYPES, TELEMETRY_DATA_TYPES, RELATIONSHIP_TYPES, IDENTIFIER_TYPES, TEMPLATE_CATEGORIES,
  ASSET_STATUSES, INVERSE_RELATIONSHIP_MAP, CHECKLIST_QUESTION_TYPES,
  createAssetTemplateSchema, createAssetTemplateValidated, updateAssetTemplateSchema,
  createAssetInstanceSchema, updateAssetInstanceSchema,
  createAssetRelationshipSchema, createAssetIdentifierSchema,
  assetQuerySchema, templateQuerySchema,
  SYSTEM_TEMPLATE_KIND_CODES,
} from './schemas/assets.js';
export type {
  CreateAssetTemplateInput, UpdateAssetTemplateInput,
  CreateAssetInstanceInput, UpdateAssetInstanceInput,
  CreateAssetRelationshipInput, CreateAssetIdentifierInput,
  AssetQueryInput, TemplateQueryInput,
  SystemTemplateKindCode,
} from './schemas/assets.js';

// Pipeline executor (Phase 8.4c scaffold; 8.5 fills in guard bodies).
export * from './pipeline-executor/index.js';
