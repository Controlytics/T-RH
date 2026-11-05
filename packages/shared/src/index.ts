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
  parseLayoutForWrite, PANEL_WIDTHS, PANEL_HEIGHTS, namedWidth, namedHeight,
} from './types/dashboard-layout.js';
export type { DashboardLayout, LayoutItem } from './types/dashboard-layout.js';

export {
  DASHBOARD_DOCUMENT_VERSION, DASHBOARD_SOURCE_INSTRUMENTS_MAX, DEFAULT_DASHBOARD_WINDOW,
  dashboardSourceSchema, dashboardTimeWindowSchema, emptyDashboardDocument,
  parseDashboardDocument, readDashboardDocument, diffWidgets,
} from './types/dashboard-document.js';
export type {
  DashboardSource, DashboardTimeWindow, DashboardDocument, StoredDashboardDocument,
  DashboardSourceSummary, DashboardSummary, DashboardDetail,
} from './types/dashboard-document.js';

export {
  CUSTOM_WIDGETS_PANEL, WIDGET_ITEM_PREFIX, WIDGET_TYPES, WIDGETS_PER_LAYOUT_MAX, WIDGET_INSTRUMENTS_MAX,
  WIDGET_KEYS_MAX, TREND_SERIES_MAX, VALUE_CARDS_SHOWN_MAX, WIDGET_COLOR_COUNT, WIDGET_PAGE_SIZES,
  GAUGES_SHOWN_MAX, BAR_SERIES_MAX, TEXT_CARD_MAX, WIDGET_BAR_BUCKETS, WIDGET_BAR_AGGS, WIDGET_BAR_GROUPS, WIDGET_PIE_SUBJECTS,
  WIDGET_TYPE_SPECS, widgetPanelGate,
  WIDGET_ALARM_STATUSES, widgetKeySchema, widgetSourceSchema, customWidgetSchema, widgetItemId, widgetIdOf, isWidgetItem, widgetsEqual,
} from './types/dashboard-widgets.js';
export type { WidgetType, WidgetKey, WidgetSource, CustomWidget, WidgetTypeSpec, WidgetOptionName } from './types/dashboard-widgets.js';

export {
  PROFILE_DISPLAY_KEYS_MAX, profileDisplayKeySchema, profileDisplayKeysSchema, coerceProfileDisplayKeys, displayKeysEqual,
} from './types/profile-display-keys.js';

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
  privilegeTogglesFromPermissions,
  primaryPermissionsForSidebarItem,
  rebuildRolePermissions,
  resolveNodePermissions,
  resolveNodeGate,
  resolveNodeGateRoles,
} from './types/permission-tree.js';
export type { PermissionNode, SidebarGroup, RebuildRolePermissionsInput } from './types/permission-tree.js';

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
  isMktEnabled, isMktOn, mktFromExpMean, mktCelsius,
} from './types/mkt.js';
export {
  MEASUREMENT_CODES_PHASE1, MEASUREMENT_CODE_RE, RESERVED_MEASUREMENT_CODE,
  profileMeasurementSchema, profileMeasurementsSchema, DEFAULT_PROFILE_MEASUREMENTS,
  coerceProfileMeasurements, slotConfigFromMeasurements, measurementsEquivalent,
} from './types/profile-measurements.js';
export type { MeasurementType, ProfileMeasurement, InstrumentSlotConfig } from './types/profile-measurements.js';
export {
  DATA_KEY_SOURCES, DATA_KEY_MAX, DATA_KEYS_INSTRUMENTS_MAX, DATA_KEYS_PER_REQUEST_MAX,
  dataKeyRefSchema, latestValuesRequestSchema,
} from './types/data-keys.js';
export type {
  DataKeySource, DataKeyRef, LatestValuesRequest, DataKeyMeasurement, DataKeyInfo,
  DataKeyJudged, LatestKeyValue, LatestValuesRow,
} from './types/data-keys.js';
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
  alarmTypeKeyFor, alarmTypeName, ruleAlarmTypeName,
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
  effectiveAttributeAccess,
} from './types/attribute-access.js';
export type { AttributeAccess, AttributeAccessMode } from './types/attribute-access.js';


// Schemas
export { loginSchema, passwordChangeSchema } from './schemas/auth.js';
export type { LoginInput, PasswordChangeInput } from './schemas/auth.js';

export { createUserSchema, updateUserSchema, resetPasswordSchema, userQuerySchema, bulkDeleteUsersSchema } from './schemas/users.js';
export type { CreateUserInput, UpdateUserInput, ResetPasswordInput, UserQueryInput, BulkDeleteUsersInput } from './schemas/users.js';

export { brandingConfigSchema, BRANDING_TAB_TITLE_DEFAULT, passwordPolicySchema, loginSecuritySchema, sessionConfigSchema, datetimeConfigSchema, userIdConfigSchema, auditTemplatesSchema, paginationConfigSchema, offlineCacheConfigSchema, exportLimitConfigSchema, EXPORT_LIMIT_HARD_CEILING, EXPORT_LIMIT_DEFAULT_MAX, EXPORT_LIMIT_DEFAULT_MESSAGE, instrumentAttributesConfigSchema, INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT, INSTRUMENT_PLACEMENT_COLUMNS, placementColumnFor, parseInstrumentAttributeKeys, instrumentActivityConfigSchema, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN, INSTRUMENT_ACTIVE_INTERVAL_SLACK, isInstrumentReporting, effectiveExpectedIntervalSec } from './schemas/config.js';
export type { BrandingConfig, PasswordPolicyConfig, LoginSecurityConfig, SessionConfig, DatetimeConfig, UserIdConfig, AuditTemplatesConfig, PaginationConfig, OfflineCacheConfig, ExportLimitConfig } from './schemas/config.js';

export { createInstrumentProfileSchema, updateInstrumentProfileSchema, PROFILE_READING_MOVED_MESSAGE } from './schemas/instrument-profiles.js';
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
  REPORT_TEMPLATE_DOCUMENT_VERSION, REPORT_TEMPLATE_NAME_MAX, REPORT_TEMPLATE_LOGO_MAX, REPORT_TEMPLATE_COLUMNS_MAX,
  REPORT_TEMPLATE_LOGO_IMAGE_KB, REPORT_TEMPLATE_LOGO_TOO_LARGE,
  REPORT_TEMPLATE_INFO_ROWS_MAX, REPORT_TEMPLATE_HEADING_MAX, REPORT_TEMPLATE_TITLE_MAX, REPORT_TEMPLATE_TEXT_MAX,
  REPORT_TEMPLATE_LEGEND_MAX, REPORT_FIELD_ID_MAX, REPORT_VALUE_MISSING, REPORT_LOGO_MODES,
  WIDGET_REPORT_FIELDS, REPORTABLE_WIDGET_TYPES, REPORT_PLACEHOLDERS, isPlaceholder, substitutePlaceholders,
  reportLogoFormat, reportTemplateDocumentSchema, builtinReportTemplate, coerceReportTemplateDocument, keyRowsCollapse,
  reportTemplateCreateSchema, reportTemplateUpdateSchema, WIDGET_REPORT_KIND, widgetReportType,
  widgetTypeTakesProfileFields, REPORT_TEMPLATE_RESOLVE_IDS_MAX,
  PAGE_TEMPLATE_KINDS, TEMPLATE_KINDS, isTemplateKind, isPageTemplateKind, templateKindOf,
  PAGE_REPORT_FIELDS, REPORT_TEMPLATE_FIELDS, TEMPLATE_KIND_SPECS, templateKindTakesProfileFields,
  templateKindScope, templateKindLabel,
} from './types/report-templates.js';
export type {
  ReportField, ReportFieldGroup, ReportFieldKind, Placeholder, ReportLogoMode, ReportTemplateColumn,
  ReportTemplateInfoRow, ReportTemplateDocument, ReportTemplateCreate, ReportTemplateUpdate, WidgetReportKind,
  ReportTemplateRow, PageTemplateKind, TemplateKind, TemplateKindScope, TemplateProfileFields, TemplateKindSpec,
} from './types/report-templates.js';
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
export { MODBUS_CONNECTIONS, MODBUS_INTERVAL, MODBUS_UNIT_ID, MODBUS_UNIT_ID_MESSAGE, MODBUS_INTERVAL_MESSAGE, modbusUnitIdSchema, modbusIntervalSchema, isModbusReadInterval, BULK_TCPIP_HEADINGS, MODBUS_PORT_DEFAULT, MODBUS_MAX_KEYS, MODBUS_MAX_REGISTERS_PER_REQUEST, MODBUS_DATA_TYPES, MODBUS_BYTE_ORDERS, PAYLOAD_META_KEYS, DEVICE_NETWORKS_DEFAULT, modbusRegisterSchema, modbusRegisterMapSchema, coerceModbusRegisterMap, parseModiconRef, registersFor, modbusHostSchema, parseDeviceNetworks, ipInNetworks, fromDesktopKeysFile } from './types/modbus.js';
export type { ModbusConnection, ModbusDataType, ModbusByteOrder, ModbusRegister, ModbusRegisterMap } from './types/modbus.js';
export { MODBUS_BYTE_ORDER_LABELS, MODBUS_QUANTITY_TYPES, registerRange } from './types/modbus.js';

// Rule chains (2026-11-03): the ThingsBoard node catalogue and the chain document.
export {
  RULE_NODE_GROUPS, UNSUPPORTED_NODE_TYPE,
  RULE_RELATION_SUCCESS, RULE_RELATION_FAILURE, RULE_RELATION_TRUE, RULE_RELATION_FALSE, RULE_RELATION_OTHER,
  RULE_ORIGINATOR_TYPES, RULE_ORIGINATOR_TYPE_LABELS, TB_ENTITY_TYPE_ALIASES, toRuleOriginatorType,
  RULE_DEBUG_MODES, RULE_NODE_NAME_MAX, RULE_CHAIN_NAME_MAX, RULE_CHAIN_NODES_MAX, RULE_RELATION_MAX,
  RULE_SCRIPT_MAX, RULE_TEMPLATE_MAX, RULE_KEY_MAX, RULE_KEYS_MAX,
  RULE_MESSAGE_TYPES, MESSAGE_TYPE_SWITCH_LABELS, messageTypeSwitchLabel,
  RULE_ALARM_STATUSES, RULE_MATH_OPERATIONS, RULE_ORIGINATOR_FIELDS,
  RULE_NODE_TYPES, RULE_NODE_TYPE_BY_ID, RULE_NODE_TYPE_BY_TB_CLASS, BUILT_RULE_NODE_TYPES,
  toRuleNodeTypeDescriptor, newRuleNodeConfig, ruleNodeConfigWithDefaults, visibleRuleNodeFields, coerceThingsboardScalars,
  upgradeThingsboardConfig, fromThingsboardConfig, toThingsboardConfig,
} from './types/rule-nodes.js';
export type {
  RuleNodeGroup, RuleNodeStatus, RuleOriginatorType, RuleDebugMode, RuleMessageType,
  RuleNodeFieldType, RuleNodeFieldOption, RuleNodeConfigField, RuleNodeTypeSpec, RuleNodeTypeDescriptor,
  ThingsboardConfigUpgrade, ThingsboardConfigImport,
} from './types/rule-nodes.js';
export {
  RULE_CHAIN_DOCUMENT_VERSION, RULE_CHAIN_CONNECTIONS_MAX, DEFAULT_ROOT_CHAIN_NAME, DEFAULT_ROOT_CHAIN_NODE_IDS,
  parseRuleChainDocument, readRuleChainDocument, emptyRuleChainDocument, defaultRootChainDocument,
  toThingsboardExport, fromThingsboardExport, ruleChainsEqual,
} from './types/rule-chain-document.js';
export type {
  RuleChainNode, RuleChainConnection, RuleChainDocument, UnsupportedNodeConfig,
  ThingsboardNodeExport, ThingsboardRuleChainExport, ThingsboardImportResult,
} from './types/rule-chain-document.js';
