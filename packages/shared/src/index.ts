// Types
export { DEFAULT_ROLES, DEFAULT_ROLE_HIERARCHY, CREATABLE_ROLES, USER_STATUS } from './types/roles.js';
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

export {
  PANELS, PANEL_KEYS, PANEL_PAGES, isPanelKey, normalizePanels, resolvePanels, panelVisible,
} from './types/panels.js';
export type { PanelDefinition, PanelKey, PanelPage } from './types/panels.js';

export {
  DEFAULT_DASHBOARD_LAYOUT, LAYOUT_VERSION, GRID_COLUMNS, normalizeLayout, resolveLayout,
  PANEL_WIDTHS, PANEL_HEIGHTS, namedWidth, namedHeight,
} from './types/dashboard-layout.js';
export type { DashboardLayout, LayoutItem } from './types/dashboard-layout.js';

export {
  PANEL_TINTS, PANEL_SIZES, PANEL_PADDINGS,
  DEFAULT_TINT, DEFAULT_SIZE, DEFAULT_PADDING, MAX_PANEL_TITLE,
  isTintKey, tintFor, sizeFor, paddingFor, normalizePanelStyle, contrastRatio,
} from './types/panel-style.js';
export type { PanelStyle, PanelTint, PanelSize, PanelPadding } from './types/panel-style.js';

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
export {
  SENSOR_OFFSETS_CONFIG_KEY, SENSOR_OFFSET_KEYS_DEFAULT, SENSOR_OFFSET_VALUE_MESSAGE,
  coerceSensorOffsetConfig, isOffsetAttributeKey, parseOffsetValue, formatOffsetValue, applyOffset, offsetReadings,
} from './types/sensor-offsets.js';
export type { SensorOffsetConfig } from './types/sensor-offsets.js';

export {
  TELEMETRY_DECIMALS_KEYS_DEFAULT,
  TELEMETRY_VALUED_KEYS_DEFAULT,
  slotForAttributeKey,
  TELEMETRY_DECIMALS_FALLBACK,
  TELEMETRY_DECIMALS_MAX,
  parseDecimalsValue,
  resolveDecimals,
  clampDecimals,
  formatDecimals,
} from './types/telemetry-decimals.js';

export {
  PERIOD_PRESETS,
  INTERVALS,
  DEFAULT_PERIOD,
  DEFAULT_INTERVAL,
  MAX_SERIES_POINTS,
  intervalSpec,
  isIntervalKey,
  isPeriodPreset,
  resolvePeriod,
  chooseInterval,
  describeRange,
} from './types/telemetry-period.js';
export type {
  PeriodPreset,
  PeriodPresetSpec,
  IntervalKey,
  IntervalSpec,
  ResolvedRange,
} from './types/telemetry-period.js';

export { ALL_RECORDS, ALL_RECORDS_PARAM } from './types/all-records.js';
export { lttb } from './types/telemetry-downsample.js';
export type { DownsamplePoint } from './types/telemetry-downsample.js';

export {
  LIMIT_BOUNDS,
  ALARM_LIMIT_KEYS_DEFAULT,
  ALARM_LIMIT_ENABLE_KEYS_DEFAULT,
  ALARM_STATUS_TEXT_DEFAULT,
  LIMIT_DISABLED_TEXT_DEFAULT,
  parseEnableFlag,
  resolveEnableFlag,
  parseLimitKeys,
  parseLimitValue,
  limitDisplayText,
  resolveLimit,
} from './types/alarm-limits.js';

export {
  MKT_ATTRIBUTE_KEY, MKT_DELTA_H_OVER_R_K, KELVIN_OFFSET,
  isMktEnabled, mktFromExpMean, mktCelsius,
} from './types/mkt.js';
export type { LimitBound } from './types/alarm-limits.js';

export {
  POLYGON_MIN_CORNERS, POLYGON_MAX_CORNERS, POLYGON_MIN_AREA, SHARED_EDGE_TOL, WALL_EDGE,
  rectanglePoints, boundingBox, polygonArea, signedArea, polygonEdges, isSimplePolygon,
  validatePolygon, pointInPolygon, sharedEdges, mirrorOpening, largestInscribedRect, inscribedRects,
  doorEdge, centroid, isRectilinear, unionRectilinear,
  segmentOnEdge, splitDoor, SEGMENT_SNAP_TOL,
} from './types/floorplan-geometry.js';
export type { Point, Box, Segment, Polygon, EdgeOpening, SharedEdge } from './types/floorplan-geometry.js';

export {
  INACTIVITY_ALARMS_DEFAULT, INACTIVITY_GRACE_MIN, INACTIVITY_GRACE_MAX,
  INACTIVITY_TYPE_LABEL, describeInactivity, inactivityLimitText,
  INACTIVITY_TEXT_DEFAULT, INACTIVITY_MINUTES_TOKEN,
} from './types/inactivity-alarms.js';
export type {
  InactivityAlarmConfig, InactivitySnapshot,
  InactivityColumnTexts,
} from './types/inactivity-alarms.js';

export {
  RS485_ALARMS_DEFAULT, RS485_TYPE_LABEL, RS485_LIMIT_TEXT, RS485_RAW_VALUE_MAX,
  RS485_FAILURE_TEXT_DEFAULT, RS485_FAILURE_TEXT_MAX,
  describeRs485, isSensorFailureValue, renderRawValue, failureText, coerceReading,
} from './types/rs485-alarms.js';
export type {
  Rs485AlarmConfig, Rs485Metric, Rs485Snapshot,
} from './types/rs485-alarms.js';

export {
  SENSOR_RANGE_KEYS_DEFAULT, SENSOR_RANGE_TEXT_DEFAULT, SENSOR_RANGE_TEXT_MAX,
  SENSOR_RANGE_TYPE_LABEL, rangeText, isOutOfRange, describeRangeFault, rangeLimitText,
} from './types/sensor-range.js';
export type {
  SensorRangeConfig, SensorRangeBounds, SensorRangeSnapshot, RangeMetric,
  RangeBound,
} from './types/sensor-range.js';

// Severity is no longer administered anywhere; this is the ONE value new alarms
// are stamped with, so the retained §11 column keeps a legal value. See the file.
export { ALARM_SEVERITY_FALLBACK } from './types/alarm-severity.js';

export {
  ALARM_TYPE_KEYS, ALARM_TYPE_NAME_DEFAULT, ALARM_TYPE_NAME_MAX,
  alarmTypeKeyFor, alarmTypeName,
} from './types/alarm-type-names.js';
export type { AlarmTypeKey, AlarmTypeNames } from './types/alarm-type-names.js';

export {
  ATTRIBUTE_ACCESS_MODES,
  ATTRIBUTE_REMARK_MIN,
  ATTRIBUTE_REMARK_MAX,
  parseAttributeAccess,
  canEditAttributeKey,
  canAddAttribute,
  attributeWriteNeedsReauth,
  validateAttributeRemark,
} from './types/attribute-access.js';
export type { AttributeAccess, AttributeAccessMode } from './types/attribute-access.js';


// Schemas
export { loginSchema, passwordChangeSchema } from './schemas/auth.js';
export type { LoginInput, PasswordChangeInput } from './schemas/auth.js';

export { createUserSchema, updateUserSchema, resetPasswordSchema, userQuerySchema, bulkDeleteUsersSchema } from './schemas/users.js';
export type { CreateUserInput, UpdateUserInput, ResetPasswordInput, UserQueryInput, BulkDeleteUsersInput } from './schemas/users.js';

export { brandingConfigSchema, BRANDING_TAB_TITLE_DEFAULT, passwordPolicySchema, loginSecuritySchema, sessionConfigSchema, datetimeConfigSchema, userIdConfigSchema, auditTemplatesSchema, paginationConfigSchema, offlineCacheConfigSchema, exportLimitConfigSchema, EXPORT_LIMIT_HARD_CEILING, EXPORT_LIMIT_DEFAULT_MAX, EXPORT_LIMIT_DEFAULT_MESSAGE, instrumentAttributesConfigSchema, INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT, INSTRUMENT_PLACEMENT_COLUMNS, placementColumnFor, parseInstrumentAttributeKeys, instrumentActivityConfigSchema, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN, INSTRUMENT_ACTIVE_INTERVAL_SLACK, isInstrumentReporting } from './schemas/config.js';
export type { BrandingConfig, PasswordPolicyConfig, LoginSecurityConfig, SessionConfig, DatetimeConfig, UserIdConfig, AuditTemplatesConfig, PaginationConfig, OfflineCacheConfig, ExportLimitConfig } from './schemas/config.js';

export { createInstrumentProfileSchema, updateInstrumentProfileSchema } from './schemas/instrument-profiles.js';
export type { CreateInstrumentProfileInput, UpdateInstrumentProfileInput } from './schemas/instrument-profiles.js';

export { auditQuerySchema } from './schemas/audit.js';
export type { AuditQueryInput } from './schemas/audit.js';

export { actionReauthConfigSchema } from './schemas/action-reauth.js';
export { ldapConfigFormSchema, notificationRecipientSchema, notificationRuleFormSchema, notificationTemplateFormSchema, helpArticleFormSchema, helpArticleEditSchema, instrumentCreateFormSchema, formFieldErrors } from './schemas/admin-forms.js';
export type { FormFieldErrors } from './schemas/admin-forms.js';
export type { ActionReauthConfig } from './schemas/action-reauth.js';

export { TRANSPORTS, TOKEN_PREFIX_LEN, createInstrumentSchema, updateInstrumentSchema, instrumentQuerySchema, bulkCreateInstrumentsSchema, setInstrumentTokenSchema, setInstrumentAttributeSchema, updateInstrumentAttributeSchema } from './schemas/instruments.js';
export type { Transport, CreateInstrumentInput, UpdateInstrumentInput, InstrumentQueryInput, BulkCreateInstrumentsInput, SetInstrumentTokenInput, SetInstrumentAttributeInput, UpdateInstrumentAttributeInput } from './schemas/instruments.js';

export {
  ALARM_WEBHOOK_EVENTS,
  ALARM_WEBHOOK_METHODS,
  ALARM_WEBHOOK_DELIVERY_STATUSES,
  ALARM_WEBHOOK_VARIABLES,
  DEFAULT_WEBHOOK_BODY_TEMPLATE,
} from './types/alarm-webhook.js';
export type {
  AlarmWebhookEvent,
  AlarmWebhookMethod,
  AlarmWebhookDeliveryStatus,
  AlarmWebhookScope,
  AlarmWebhookTargetShape,
} from './types/alarm-webhook.js';


export {
  TREND_WIDGET_IDS, TREND_WIDGET_LABEL_KEYS, TREND_WIDGET_LABEL_DEFAULT,
  TREND_WIDGET_LABEL_MAX, TREND_WIDGET_DATE_FORMATS, TREND_WIDGET_TIME_FORMATS,
  TREND_WIDGET_FORMAT_INHERIT, TREND_WIDGET_FIELDS, TREND_WIDGET_FIELD_LABEL,
  trendWidgetLabel, trendWidgetFormat, resolveTrendWidgetTexts, coerceTrendWidgetTexts,
  trendWidgetDateFormatKey, trendWidgetTimeFormatKey,
} from './types/trend-widgets.js';
export {
  REPORT_APPROVERS_CONFIG_KEY, REPORT_APPROVERS_NONE_MESSAGE, coerceApproverRoles,
  coerceApproverUserIds, coerceReportApprovers,
} from './types/report-approvers.js';
export type { ReportApproversConfig } from './types/report-approvers.js';
export {
  REPORT_DOWNLOADS_CONFIG_KEY, REPORT_KINDS, REPORT_KIND_POLICY_DEFAULT,
  isReportKind, reportKindSettingKeys, coerceReportDownloads, coerceReportDownloadsResponse, reportKindLabel,
  reportDownloadsRow, reportTypeMatchesKind,
} from './types/report-downloads.js';
export type {
  ReportKind, ReportDownloadMode, ReportKindPolicy, ReportDownloadsPolicy,
} from './types/report-downloads.js';
export {
  ATTRIBUTE_LABELS_CONFIG_KEY, ATTRIBUTE_LABEL_MAX, ATTRIBUTE_LABEL_KEY_MAX,
  coerceAttributeLabels, attributeLabel,
  SETTINGS_HIDDEN_NONE, coerceSettingsHidden, isHiddenInSettings,
} from './types/attribute-labels.js';
export type { AttributeLabels, AttributeLabelsConfig, SettingsHidden } from './types/attribute-labels.js';
export type {
  TrendWidgetId, TrendWidgetLabelKey, TrendWidgetConfig,
  TrendWidgetFormat, TrendWidgetTexts,
} from './types/trend-widgets.js';
