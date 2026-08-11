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

export {
  TELEMETRY_SLOTS,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  STATUS_RANK,
  parseTelemetryAliases,
  resolveSlot,
  computeInstrumentStatus,
  worstStatus,
} from './types/telemetry-slots.js';
export type { TelemetrySlot, InstrumentStatus, RoomLimits } from './types/telemetry-slots.js';

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

export { brandingConfigSchema, passwordPolicySchema, loginSecuritySchema, sessionConfigSchema, datetimeConfigSchema, userIdConfigSchema, auditTemplatesSchema, paginationConfigSchema, offlineCacheConfigSchema, exportLimitConfigSchema, EXPORT_LIMIT_HARD_CEILING, EXPORT_LIMIT_DEFAULT_MAX, EXPORT_LIMIT_DEFAULT_MESSAGE, instrumentAttributesConfigSchema, INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT, INSTRUMENT_PLACEMENT_COLUMNS, placementColumnFor, parseInstrumentAttributeKeys, instrumentActivityConfigSchema, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN, INSTRUMENT_ACTIVE_INTERVAL_SLACK, isInstrumentReporting } from './schemas/config.js';
export type { BrandingConfig, PasswordPolicyConfig, LoginSecurityConfig, SessionConfig, DatetimeConfig, UserIdConfig, AuditTemplatesConfig, PaginationConfig, OfflineCacheConfig, ExportLimitConfig } from './schemas/config.js';

export { createInstrumentProfileSchema, updateInstrumentProfileSchema } from './schemas/instrument-profiles.js';
export type { CreateInstrumentProfileInput, UpdateInstrumentProfileInput } from './schemas/instrument-profiles.js';

export { auditQuerySchema } from './schemas/audit.js';
export type { AuditQueryInput } from './schemas/audit.js';

export { actionReauthConfigSchema } from './schemas/action-reauth.js';
export type { ActionReauthConfig } from './schemas/action-reauth.js';

export { TRANSPORTS, TOKEN_PREFIX_LEN, createInstrumentSchema, updateInstrumentSchema, instrumentQuerySchema, bulkCreateInstrumentsSchema, setInstrumentTokenSchema, setInstrumentAttributeSchema, updateInstrumentAttributeSchema } from './schemas/instruments.js';
export type { Transport, CreateInstrumentInput, UpdateInstrumentInput, InstrumentQueryInput, BulkCreateInstrumentsInput, SetInstrumentTokenInput, SetInstrumentAttributeInput, UpdateInstrumentAttributeInput } from './schemas/instruments.js';

// Pipeline executor (Phase 8.4c scaffold; 8.5 fills in guard bodies).
export * from './pipeline-executor/index.js';
