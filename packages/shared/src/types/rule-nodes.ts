/**
 * The RULE NODE catalogue — rule chains (2026-11-03).
 *
 * Design: docs/superpowers/specs/2026-11-03-rule-chains-design.md §4, §5, §7.
 *
 * Every rule node ThingsBoard documents, with ThingsBoard's group, label,
 * relation labels, Java class (`tbClass`, for import / export) and — for the
 * nodes built here — its configuration fields under ThingsBoard's own key names,
 * ThingsBoard's own defaults, and a zod schema for them. The API's registry
 * (handlers), the editor's palette and settings forms, and the import/export
 * all read THIS list; none keeps a second one.
 *
 * Sources, read 2026-11-03: the six group pages of
 * thingsboard.io/docs/user-guide/rule-engine-2-0 (names, groups, which are PE /
 * deprecated) and the `@RuleNode` annotations + `*Configuration.defaultConfiguration()`
 * of github.com/thingsboard/thingsboard master (classes, relation types, config
 * keys and defaults). The documentation pages carry no class names; every
 * `tbClass` below was read off the source tree, `TbAssignToCustomerNode` /
 * `TbUnassignFromCustomerNode` off tag v4.2 (they are gone from master).
 *
 * THE COUNT IS 86, not the spec's 87: ThingsBoard lists 12 filter nodes, and the
 * spec's 13th filter row is its own note that "Originator type filter/switch" are
 * older names of Entity type filter/switch — the same two classes. Status:
 *   built (47) — a handler exists (Tasks 4-6). Three are narrowed here: Check
 *                relation presence and Related device attributes know only the
 *                gateway link; Tenant attributes / details read the APPLICATION.
 *                Device profile (deprecated) is a pass-through (2026-11-04): it is
 *                the ENTRY of every ThingsBoard v3.6–v4.2 root chain.
 *   later (10) — a counterpart exists but needs a feature this system lacks.
 *   none  (29) — ThingsBoard-specific (customers, assets, entity views, edge,
 *                entity groups, Cassandra, cloud vendors, PE reports, Twilio).
 * A `later` / `none` node imports and saves (it passes the message to Failure);
 * it has no fields, no handler, and accepts any configuration object, so a
 * chain exported from ThingsBoard round-trips without losing it.
 *
 * Configuration VALUES stay ThingsBoard's (`SERVER_SCOPE`, `METADATA`, `DEVICE`
 * where ThingsBoard says DEVICE …) so an export goes back into ThingsBoard; the
 * LABELS read "instrument". A key a schema does not model is KEPT (`passthrough`)
 * — real exports carry `scriptLang: 'TBEL'`, `tbelScript`, `processingSettings`.
 * A key the schema marks optional and the config omits means ThingsBoard's
 * default: read a node's config through `ruleNodeConfigWithDefaults`.
 */
import { z } from 'zod';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export type RuleNodeGroup = 'filter' | 'enrichment' | 'transformation' | 'action' | 'external' | 'flow';
export type RuleNodeStatus = 'built' | 'later' | 'none';

/** ThingsBoard's palette order and group names. */
export const RULE_NODE_GROUPS: readonly { id: RuleNodeGroup; label: string }[] = [
  { id: 'filter', label: 'Filter' },
  { id: 'enrichment', label: 'Enrichment' },
  { id: 'transformation', label: 'Transformation' },
  { id: 'action', label: 'Action' },
  { id: 'external', label: 'External' },
  { id: 'flow', label: 'Flow' },
];

export const UNSUPPORTED_NODE_TYPE = 'tb:unsupported';

export const RULE_RELATION_SUCCESS = 'Success';
export const RULE_RELATION_FAILURE = 'Failure';
export const RULE_RELATION_TRUE = 'True';
export const RULE_RELATION_FALSE = 'False';
export const RULE_RELATION_OTHER = 'Other';

export const RULE_ORIGINATOR_TYPES = ['INSTRUMENT', 'ALARM', 'USER', 'SYSTEM', 'RULE_NODE'] as const;
export type RuleOriginatorType = (typeof RULE_ORIGINATOR_TYPES)[number];

/** What the Entity type switch names each originator type (its relation labels). */
export const RULE_ORIGINATOR_TYPE_LABELS: Readonly<Record<RuleOriginatorType, string>> = {
  INSTRUMENT: 'Instrument',
  ALARM: 'Alarm',
  USER: 'User',
  SYSTEM: 'System',
  RULE_NODE: 'Rule node',
};

/** ThingsBoard entity-type names that mean one of ours ("device" = instrument). */
export const TB_ENTITY_TYPE_ALIASES: Readonly<Record<string, RuleOriginatorType>> = {
  DEVICE: 'INSTRUMENT',
  TENANT: 'SYSTEM',
};

/** One of ours, a ThingsBoard alias of one of ours, or null (ASSET, CUSTOMER … never match here). */
export function toRuleOriginatorType(value: string): RuleOriginatorType | null {
  if ((RULE_ORIGINATOR_TYPES as readonly string[]).includes(value)) return value as RuleOriginatorType;
  return Object.prototype.hasOwnProperty.call(TB_ENTITY_TYPE_ALIASES, value) ? TB_ENTITY_TYPE_ALIASES[value] : null;
}

export const RULE_DEBUG_MODES = ['off', 'all', 'failures'] as const;
export type RuleDebugMode = (typeof RULE_DEBUG_MODES)[number];

export const RULE_NODE_NAME_MAX = 80;
export const RULE_CHAIN_NAME_MAX = 120;
export const RULE_CHAIN_NODES_MAX = 300;
/** A connection's relation label. */
export const RULE_RELATION_MAX = 128;
export const RULE_SCRIPT_MAX = 20_000;
export const RULE_TEMPLATE_MAX = 4_000;
/** One key name (message key, attribute key, metadata key). */
export const RULE_KEY_MAX = 128;
/** Entries in one key list or key → value map. */
export const RULE_KEYS_MAX = 100;

/** The message types this system raises (spec §5). A Script transform may set any other. */
export const RULE_MESSAGE_TYPES = [
  'POST_TELEMETRY_REQUEST', 'POST_ATTRIBUTES_REQUEST', 'ATTRIBUTES_UPDATED', 'ATTRIBUTES_DELETED',
  'ALARM', 'ALARM_CLEAR', 'ALARM_ACK', 'INACTIVITY_EVENT', 'ACTIVITY_EVENT',
  'ENTITY_CREATED', 'ENTITY_UPDATED', 'ENTITY_DELETED', 'REST_API_REQUEST', 'GENERATOR_NODE_SELF_MSG', 'SEND_EMAIL',
] as const;
export type RuleMessageType = (typeof RULE_MESSAGE_TYPES)[number];

/**
 * The Message Type Switch's relation label per message type — ThingsBoard's
 * `TbMsgType` table verbatim (master, 2026-11-03), including the types this
 * system never raises, so a chain written for ThingsBoard routes the same way.
 * A type absent here (no label in ThingsBoard either — GENERATOR_NODE_SELF_MSG,
 * SEND_EMAIL — or a custom one) routes to `Other`: use `messageTypeSwitchLabel`.
 */
export const MESSAGE_TYPE_SWITCH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  POST_ATTRIBUTES_REQUEST: 'Post attributes',
  POST_TELEMETRY_REQUEST: 'Post telemetry',
  TO_SERVER_RPC_REQUEST: 'RPC Request from Device',
  ACTIVITY_EVENT: 'Activity Event',
  INACTIVITY_EVENT: 'Inactivity Event',
  CONNECT_EVENT: 'Connect Event',
  DISCONNECT_EVENT: 'Disconnect Event',
  ENTITY_CREATED: 'Entity Created',
  ENTITY_UPDATED: 'Entity Updated',
  ENTITY_DELETED: 'Entity Deleted',
  ENTITY_ASSIGNED: 'Entity Assigned',
  ENTITY_UNASSIGNED: 'Entity Unassigned',
  ATTRIBUTES_UPDATED: 'Attributes Updated',
  ATTRIBUTES_DELETED: 'Attributes Deleted',
  ALARM: 'Alarm',
  ALARM_CREATED: 'Alarm Created',
  ALARM_UPDATED: 'Alarm Updated',
  ALARM_SEVERITY_UPDATED: 'Alarm Severity Updated',
  ALARM_ACK: 'Alarm Acknowledged',
  ALARM_CLEAR: 'Alarm Cleared',
  ALARM_ASSIGNED: 'Alarm Assigned',
  ALARM_UNASSIGNED: 'Alarm Unassigned',
  COMMENT_CREATED: 'Comment Created',
  COMMENT_UPDATED: 'Comment Updated',
  RPC_CALL_FROM_SERVER_TO_DEVICE: 'RPC Request to Device',
  ENTITY_ASSIGNED_FROM_TENANT: 'Entity Assigned From Tenant',
  ENTITY_ASSIGNED_TO_TENANT: 'Entity Assigned To Tenant',
  TIMESERIES_UPDATED: 'Timeseries Updated',
  TIMESERIES_DELETED: 'Timeseries Deleted',
  RPC_QUEUED: 'RPC Queued',
  RPC_SENT: 'RPC Sent',
  RPC_DELIVERED: 'RPC Delivered',
  RPC_SUCCESSFUL: 'RPC Successful',
  RPC_TIMEOUT: 'RPC Timeout',
  RPC_EXPIRED: 'RPC Expired',
  RPC_FAILED: 'RPC Failed',
  RPC_DELETED: 'RPC Deleted',
  RELATION_ADD_OR_UPDATE: 'Relation Added or Updated',
  RELATION_DELETED: 'Relation Deleted',
  RELATIONS_DELETED: 'All Relations Deleted',
  OWNER_CHANGED: 'Owner changed',
  ADDED_TO_ENTITY_GROUP: 'Added to Group',
  REMOVED_FROM_ENTITY_GROUP: 'Removed from Group',
  // ThingsBoard spells this one with a lower-case "request".
  REST_API_REQUEST: 'REST API request',
  generateReport: 'Generate Report',
});

/** The Message Type Switch's rule: the type's ThingsBoard label, else `Other`. */
export function messageTypeSwitchLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(MESSAGE_TYPE_SWITCH_LABELS, type)
    ? MESSAGE_TYPE_SWITCH_LABELS[type]
    : RULE_RELATION_OTHER;
}

/** The Alarm status filter's statuses (ThingsBoard `AlarmStatus`). */
export const RULE_ALARM_STATUSES = ['ACTIVE_UNACK', 'ACTIVE_ACK', 'CLEARED_UNACK', 'CLEARED_ACK'] as const;

/** ThingsBoard `TbRuleNodeMathFunctionType`, with its argument counts. */
export const RULE_MATH_OPERATIONS: readonly { value: string; minArgs: number; maxArgs: number }[] = [
  ...['ADD', 'SUB', 'MULT', 'DIV'].map((value) => ({ value, minArgs: 2, maxArgs: 2 })),
  ...['SIN', 'SINH', 'COS', 'COSH', 'TAN', 'TANH', 'ACOS', 'ASIN', 'ATAN'].map((value) => ({ value, minArgs: 1, maxArgs: 1 })),
  { value: 'ATAN2', minArgs: 2, maxArgs: 2 },
  ...['EXP', 'EXPM1', 'SQRT', 'CBRT', 'GET_EXP'].map((value) => ({ value, minArgs: 1, maxArgs: 1 })),
  { value: 'HYPOT', minArgs: 2, maxArgs: 2 },
  ...['LOG', 'LOG10', 'LOG1P', 'CEIL', 'FLOOR'].map((value) => ({ value, minArgs: 1, maxArgs: 1 })),
  ...['FLOOR_DIV', 'FLOOR_MOD'].map((value) => ({ value, minArgs: 2, maxArgs: 2 })),
  { value: 'ABS', minArgs: 1, maxArgs: 1 },
  ...['MIN', 'MAX', 'POW'].map((value) => ({ value, minArgs: 2, maxArgs: 2 })),
  ...['SIGNUM', 'RAD', 'DEG'].map((value) => ({ value, minArgs: 1, maxArgs: 1 })),
  { value: 'CUSTOM', minArgs: 0, maxArgs: 16 },
];

/** The fields Originator fields can read off an instrument (`dataMapping` source keys). */
export const RULE_ORIGINATOR_FIELDS = [
  'id', 'name', 'code', 'label', 'type', 'profileName', 'functionalLocation', 'isGateway', 'createdTime', 'additionalInfo',
] as const;

// ─── Spec shape ──────────────────────────────────────────────────────────────

export type RuleNodeFieldType =
  | 'text' | 'number' | 'boolean' | 'select' | 'multiselect' | 'keys' | 'map' | 'template' | 'script' | 'json'
  | 'instrument' | 'notification-template' | 'targets' | 'message-types' | 'relations' | 'chain';

export interface RuleNodeFieldOption { value: string; label: string }

export interface RuleNodeConfigField {
  /** The configuration key — ThingsBoard's name for it. */
  key: string;
  label: string;
  type: RuleNodeFieldType;
  options?: readonly RuleNodeFieldOption[];
  required?: boolean;
  min?: number;
  max?: number;
  help?: string;
  scriptKind?: 'filter' | 'switch' | 'transform' | 'generator' | 'log' | 'details';
  /** Show the field only while another field of the same node holds this value. */
  showWhen?: { key: string; equals: unknown };
}

export interface RuleNodeTypeSpec {
  /** `tb:<group>:<kebab-name>` — the name of ThingsBoard's documentation page for the node. */
  id: string;
  /** ThingsBoard's Java class, as its exports carry it. */
  tbClass: string;
  group: RuleNodeGroup;
  /** ThingsBoard's name for the node. */
  label: string;
  description: string;
  status: RuleNodeStatus;
  /** The relation labels the node can return; `dynamic` = named at run time (switch, profile, chain). */
  relations: readonly string[] | 'dynamic';
  fields: readonly RuleNodeConfigField[];
  /** ThingsBoard's `defaultConfiguration()`. Never mutate it — copy with `newRuleNodeConfig`. */
  defaultConfig: Record<string, unknown>;
  configSchema: z.ZodTypeAny;
  /**
   * The ThingsBoard `configurationVersion` this entry's fields, defaults and
   * schema model — ThingsBoard master's `@RuleNode(version = …)` (2026-11-04).
   * An export writes it; an import of an older version is upgraded
   * (`upgradeThingsboardConfig`) or warned about. `null` for a later / none node:
   * nothing is modelled, its configuration is kept as it came.
   */
  tbConfigurationVersion: number | null;
}

/** A spec without its zod schema — what `GET /api/rule-chains/node-types` serves. */
export type RuleNodeTypeDescriptor = Omit<RuleNodeTypeSpec, 'configSchema'>;

export function toRuleNodeTypeDescriptor(spec: RuleNodeTypeSpec): RuleNodeTypeDescriptor {
  const { configSchema: _schema, ...rest } = spec;
  return cloneJson(rest);
}

// ─── Schema and field helpers ────────────────────────────────────────────────

const TB = 'org.thingsboard.rule.engine.';

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A config object: the modelled keys checked, every other key kept. */
const cfg = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const anyObject = z.object({}).passthrough();
const emptyConfig = cfg({ version: z.number().int().optional() });

const nonBlank = (max: number) => z.string().max(max).refine((s) => s.trim() !== '', { message: 'Required' });
const keyList = z.array(z.string().max(RULE_KEY_MAX).refine((s) => s.trim() !== '', { message: 'A key may not be blank' })).max(RULE_KEYS_MAX);
const stringMap = z.record(z.string().max(RULE_KEY_MAX), z.string().max(RULE_TEMPLATE_MAX))
  .refine((m) => Object.keys(m).length <= RULE_KEYS_MAX, { message: `At most ${RULE_KEYS_MAX} entries` });
const template = z.string().max(RULE_TEMPLATE_MAX);
const script = nonBlank(RULE_SCRIPT_MAX);
const scriptLang = z.enum(['JS', 'TBEL']).optional();
const tbelScript = z.string().max(RULE_SCRIPT_MAX).nullable().optional();
const fetchTo = z.enum(['DATA', 'METADATA']);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const FETCH_TO_OPTIONS = [{ value: 'METADATA', label: 'Message metadata' }, { value: 'DATA', label: 'Message data' }];
const SOURCE_OPTIONS = [{ value: 'DATA', label: 'Message data' }, { value: 'METADATA', label: 'Message metadata' }];
const SCOPE_OPTIONS = [
  { value: 'SERVER_SCOPE', label: 'Server attributes' },
  { value: 'SHARED_SCOPE', label: 'Shared attributes' },
  { value: 'CLIENT_SCOPE', label: 'Client attributes' },
];
const SCOPES_HELP = 'ThingsBoard\'s three scopes are one attribute table here; the scope is kept for export.';
const TIME_UNIT_OPTIONS = ['MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS', 'DAYS'].map((value) => ({ value, label: value.charAt(0) + value.slice(1).toLowerCase() }));
const TIME_UNITS = z.enum(['MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS', 'DAYS']);
const TEMPLATE_HELP = '${metadataKey} reads message metadata, $[dataKey] reads message data.';

const scriptField = (scriptKind: RuleNodeConfigField['scriptKind'], label: string, help: string, key = 'jsScript'): RuleNodeConfigField =>
  ({ key, label, type: 'script', required: true, scriptKind, help });

const ALARM_DETAILS_JS =
  'var details = {};\n' +
  'if (metadata.prevAlarmDetails) {\n' +
  '    details = JSON.parse(metadata.prevAlarmDetails);\n' +
  '    //remove prevAlarmDetails from metadata\n' +
  '    delete metadata.prevAlarmDetails;\n' +
  '    //now metadata is the same as it comes IN this rule node\n' +
  '}\n' +
  '\n' +
  '\n' +
  'return details;';

const LOG_JS = "return '\\nIncoming message:\\n' + JSON.stringify(msg) + '\\nIncoming metadata:\\n' + JSON.stringify(metadata);";

const SWITCH_JS =
  "function nextRelation(metadata, msg) {\n" +
  "    return ['one','nine'];\n" +
  "}\n" +
  "if(msgType === 'POST_TELEMETRY_REQUEST') {\n" +
  "    return ['two'];\n" +
  "}\n" +
  'return nextRelation(metadata, msg);';

const GENERATOR_JS =
  'var msg = { temp: 42, humidity: 77 };\n' +
  'var metadata = { data: 40 };\n' +
  'var msgType = "POST_TELEMETRY_REQUEST";\n\n' +
  'return { msg: msg, metadata: metadata, msgType: msgType };';

const ALARM_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
/** ThingsBoard's other two severities — accepted, and read as MINOR (spec §7). */
const ALARM_SEVERITIES_TB = [...ALARM_SEVERITIES, 'WARNING', 'INDETERMINATE'] as const;

const MATH_ARG_TYPES = ['ATTRIBUTE', 'TIME_SERIES', 'MESSAGE_BODY', 'MESSAGE_METADATA', 'CONSTANT'] as const;
const MATH_RESULT_TYPES = ['ATTRIBUTE', 'TIME_SERIES', 'MESSAGE_BODY', 'MESSAGE_METADATA'] as const;

const clientCredentials = z.discriminatedUnion('type', [
  cfg({ type: z.literal('anonymous') }),
  cfg({ type: z.literal('basic'), username: z.string().max(256), password: z.string().max(256).optional() }),
  cfg({ type: z.literal('cert.PEM'), caCert: z.string().optional(), cert: z.string().optional(), privateKey: z.string().optional(), password: z.string().optional() }),
]);
const CREDENTIALS_HELP = '{"type":"anonymous"}, {"type":"basic","username":"…","password":"…"} or {"type":"cert.PEM", …} — ThingsBoard\'s shape. Masked in exports.';

const ATTRIBUTE_FETCH_FIELDS: readonly RuleNodeConfigField[] = [
  { key: 'clientAttributeNames', label: 'Client attributes', type: 'keys', help: SCOPES_HELP },
  { key: 'sharedAttributeNames', label: 'Shared attributes', type: 'keys' },
  { key: 'serverAttributeNames', label: 'Server attributes', type: 'keys' },
  { key: 'latestTsKeyNames', label: 'Latest readings', type: 'keys', help: 'Keys from the latest-readings table.' },
  { key: 'fetchTo', label: 'Add to', type: 'select', options: FETCH_TO_OPTIONS },
  { key: 'tellFailureIfAbsent', label: 'Failure if a key is missing', type: 'boolean' },
  { key: 'getLatestValueWithTs', label: 'Latest reading with its timestamp', type: 'boolean' },
];
const attributeFetchShape = {
  clientAttributeNames: keyList.optional(),
  sharedAttributeNames: keyList.optional(),
  serverAttributeNames: keyList.optional(),
  latestTsKeyNames: keyList.optional(),
  fetchTo: fetchTo.optional(),
  tellFailureIfAbsent: z.boolean().optional(),
  getLatestValueWithTs: z.boolean().optional(),
};
const ATTRIBUTE_FETCH_DEFAULT = {
  clientAttributeNames: [], sharedAttributeNames: [], serverAttributeNames: [], latestTsKeyNames: [],
  tellFailureIfAbsent: true, getLatestValueWithTs: false, fetchTo: 'METADATA',
};

const FS = [RULE_RELATION_SUCCESS, RULE_RELATION_FAILURE] as const;
const TFF = [RULE_RELATION_TRUE, RULE_RELATION_FALSE, RULE_RELATION_FAILURE] as const;

/**
 * The configuration version each built node models: ThingsBoard master's
 * `@RuleNode(version = …)` for its class (read 2026-11-04). A built node not
 * listed is version 0.
 */
const TB_CONFIG_VERSIONS: Readonly<Record<string, number>> = {
  'tb:filter:check-relation-presence': 1,
  'tb:enrichment:calculate-delta': 1,
  'tb:enrichment:originator-attributes': 1,
  'tb:enrichment:originator-fields': 1,
  'tb:enrichment:originator-telemetry': 2,
  'tb:enrichment:related-device-attributes': 1,
  'tb:enrichment:tenant-attributes': 1,
  'tb:enrichment:tenant-details': 1,
  'tb:transformation:change-originator': 1,
  'tb:transformation:copy-key-value-pairs': 2,
  'tb:transformation:deduplication': 1,
  'tb:transformation:delete-key-value-pairs': 2,
  'tb:transformation:rename-keys': 2,
  'tb:action:device-profile': 1,
  'tb:action:generator': 2,
  'tb:action:save-attributes': 3,
  'tb:action:save-timeseries': 1,
  'tb:external:mqtt': 2,
  'tb:external:rest-api-call': 4,
  'tb:flow:checkpoint': 1,
  'tb:flow:rule-chain': 1,
};

function built(s: Omit<RuleNodeTypeSpec, 'status' | 'tbConfigurationVersion'>): RuleNodeTypeSpec {
  return { ...s, status: 'built', tbConfigurationVersion: TB_CONFIG_VERSIONS[s.id] ?? 0 };
}

function notBuilt(group: RuleNodeGroup, slug: string, label: string, tbClass: string, status: 'later' | 'none', description: string): RuleNodeTypeSpec {
  return {
    id: `tb:${group}:${slug}`, tbClass: TB + tbClass, group, label, description, status,
    relations: [RULE_RELATION_FAILURE], fields: [], defaultConfig: {}, configSchema: anyObject, tbConfigurationVersion: null,
  };
}

const LATER = 'Later — ';
const NONE = 'No counterpart here — ';
const PE = 'No counterpart here — a ThingsBoard Professional Edition node.';

// ─── The catalogue ───────────────────────────────────────────────────────────

const FILTER: RuleNodeTypeSpec[] = [
  built({
    id: 'tb:filter:alarm-status-filter', tbClass: `${TB}filter.TbCheckAlarmStatusNode`, group: 'filter', label: 'Alarm status filter',
    description: 'True when the originator alarm\'s status is one of the chosen ones (ACTIVE / CLEARED from its state, ACK / UNACK from whether it was acknowledged).',
    relations: TFF,
    fields: [{
      key: 'alarmStatusList', label: 'Alarm statuses', type: 'multiselect', required: true,
      options: RULE_ALARM_STATUSES.map((value) => ({ value, label: value.replace('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) })),
    }],
    defaultConfig: { alarmStatusList: ['ACTIVE_ACK', 'ACTIVE_UNACK'] },
    configSchema: cfg({ alarmStatusList: z.array(z.enum(RULE_ALARM_STATUSES)).min(1, 'Pick at least one status') }),
  }),
  notBuilt('filter', 'asset-profile-switch', 'Asset profile switch', 'filter.TbAssetTypeSwitchNode', 'none', `${NONE}there are no assets.`),
  built({
    id: 'tb:filter:check-fields-presence', tbClass: `${TB}filter.TbCheckMessageNode`, group: 'filter', label: 'Check fields presence',
    description: 'True when the chosen message data keys and metadata keys are present — all of them, or at least one.',
    relations: TFF,
    fields: [
      { key: 'messageNames', label: 'Message data keys', type: 'keys' },
      { key: 'metadataNames', label: 'Metadata keys', type: 'keys' },
      { key: 'checkAllKeys', label: 'All keys must be present', type: 'boolean', help: 'Off: one present key is enough.' },
    ],
    defaultConfig: { messageNames: [], metadataNames: [], checkAllKeys: true },
    configSchema: cfg({ messageNames: keyList.optional(), metadataNames: keyList.optional(), checkAllKeys: z.boolean().optional() }),
  }),
  built({
    id: 'tb:filter:check-relation-presence', tbClass: `${TB}filter.TbCheckRelationNode`, group: 'filter', label: 'Check relation presence',
    description: 'True when the originator instrument has the gateway link in the chosen direction. The gateway link is the only relation here; other relations are later.',
    relations: TFF,
    fields: [
      { key: 'direction', label: 'Direction', type: 'select', options: [
        { value: 'FROM', label: 'From the originator (a gateway with instruments)' },
        { value: 'TO', label: 'To the originator (an instrument on a gateway)' },
      ] },
      { key: 'relationType', label: 'Relation type', type: 'text', help: 'Kept for export; the gateway link answers every type.' },
      { key: 'checkForSingleEntity', label: 'Check one particular instrument', type: 'boolean' },
      { key: 'entityType', label: 'Entity type', type: 'select', options: [{ value: 'DEVICE', label: 'Instrument' }], showWhen: { key: 'checkForSingleEntity', equals: true } },
      { key: 'entityId', label: 'Instrument', type: 'instrument', showWhen: { key: 'checkForSingleEntity', equals: true } },
    ],
    defaultConfig: { direction: 'FROM', relationType: 'Contains', checkForSingleEntity: true },
    configSchema: cfg({
      direction: z.enum(['FROM', 'TO']).optional(),
      relationType: z.string().max(RULE_KEY_MAX).optional(),
      checkForSingleEntity: z.boolean().optional(),
      entityType: z.string().max(64).nullable().optional(),
      entityId: z.string().max(64).nullable().optional(),
    }),
  }),
  built({
    id: 'tb:filter:device-profile-switch', tbClass: `${TB}filter.TbDeviceTypeSwitchNode`, group: 'filter', label: 'Device profile switch',
    description: 'Routes by the originator instrument\'s profile name — one relation per profile.',
    relations: 'dynamic', fields: [], defaultConfig: { version: 0 }, configSchema: emptyConfig,
  }),
  built({
    id: 'tb:filter:entity-type-filter', tbClass: `${TB}filter.TbOriginatorTypeFilterNode`, group: 'filter', label: 'Entity type filter',
    description: 'True when the originator\'s type is one of the chosen types (instrument, alarm, user, system, rule node).',
    relations: TFF,
    fields: [{
      key: 'originatorTypes', label: 'Originator types', type: 'multiselect', required: true,
      options: RULE_ORIGINATOR_TYPES.map((value) => ({ value, label: RULE_ORIGINATOR_TYPE_LABELS[value] })),
      help: 'ThingsBoard\'s DEVICE and TENANT read as Instrument and System.',
    }],
    defaultConfig: { originatorTypes: ['INSTRUMENT'] },
    configSchema: cfg({ originatorTypes: z.array(z.string().min(1).max(64)).min(1, 'Pick at least one type') }),
  }),
  built({
    id: 'tb:filter:entity-type-switch', tbClass: `${TB}filter.TbOriginatorTypeSwitchNode`, group: 'filter', label: 'Entity type switch',
    description: 'Routes by the originator\'s type: Instrument, Alarm, User, System or Rule node.',
    relations: [...RULE_ORIGINATOR_TYPES.map((t) => RULE_ORIGINATOR_TYPE_LABELS[t]), RULE_RELATION_FAILURE],
    fields: [], defaultConfig: { version: 0 }, configSchema: emptyConfig,
  }),
  notBuilt('filter', 'gps-geofencing-filter', 'GPS geofencing filter', 'geo.TbGpsGeofencingFilterNode', 'later', `${LATER}needs latitude / longitude keys on instruments.`),
  built({
    id: 'tb:filter:message-type-filter', tbClass: `${TB}filter.TbMsgTypeFilterNode`, group: 'filter', label: 'Message type filter',
    description: 'True when the message type is one of the chosen types.',
    relations: TFF,
    fields: [{ key: 'messageTypes', label: 'Message types', type: 'message-types', required: true }],
    defaultConfig: { messageTypes: ['POST_ATTRIBUTES_REQUEST', 'POST_TELEMETRY_REQUEST'] },
    configSchema: cfg({ messageTypes: z.array(z.string().min(1).max(RULE_KEY_MAX)).min(1, 'Pick at least one message type').max(RULE_KEYS_MAX) }),
  }),
  built({
    id: 'tb:filter:message-type-switch', tbClass: `${TB}filter.TbMsgTypeSwitchNode`, group: 'filter', label: 'Message type switch',
    description: 'Routes by message type under ThingsBoard\'s labels (Post telemetry, Post attributes, Alarm …); any other type goes to Other.',
    relations: [...new Set(Object.values(MESSAGE_TYPE_SWITCH_LABELS)), RULE_RELATION_OTHER, RULE_RELATION_FAILURE],
    fields: [], defaultConfig: { version: 0 }, configSchema: emptyConfig,
  }),
  built({
    id: 'tb:filter:script', tbClass: `${TB}filter.TbJsFilterNode`, group: 'filter', label: 'Script',
    description: 'A JavaScript function of msg, metadata and msgType returning true or false.',
    relations: TFF,
    fields: [scriptField('filter', 'Filter function', 'Return true or false.')],
    defaultConfig: { scriptLang: 'JS', jsScript: 'return msg.temperature > 20;' },
    configSchema: cfg({ scriptLang, jsScript: script, tbelScript }),
  }),
  built({
    id: 'tb:filter:switch', tbClass: `${TB}filter.TbJsSwitchNode`, group: 'filter', label: 'Switch',
    description: 'A JavaScript function returning one relation name or an array of them; the message goes down each.',
    relations: 'dynamic',
    fields: [scriptField('switch', 'Switch function', 'Return a relation name or an array of names.')],
    defaultConfig: { scriptLang: 'JS', jsScript: SWITCH_JS },
    configSchema: cfg({ scriptLang, jsScript: script, tbelScript }),
  }),
];

const ENRICHMENT: RuleNodeTypeSpec[] = [
  built({
    id: 'tb:enrichment:calculate-delta', tbClass: `${TB}metadata.CalculateDeltaNode`, group: 'enrichment', label: 'Calculate delta',
    description: 'Adds the difference between this value of a key and the originator\'s previous one.',
    relations: [RULE_RELATION_SUCCESS, RULE_RELATION_FAILURE, RULE_RELATION_OTHER],
    fields: [
      { key: 'inputValueKey', label: 'Input value key', type: 'text', required: true },
      { key: 'outputValueKey', label: 'Output value key', type: 'text', required: true },
      { key: 'round', label: 'Decimals', type: 'number', min: 0, max: 15, help: 'Blank: not rounded.' },
      { key: 'useCache', label: 'Keep the previous value in memory', type: 'boolean' },
      { key: 'tellFailureIfDeltaIsNegative', label: 'Failure if the delta is negative', type: 'boolean' },
      { key: 'excludeZeroDeltas', label: 'Leave out a zero delta', type: 'boolean' },
      { key: 'addPeriodBetweenMsgs', label: 'Add the period between messages', type: 'boolean' },
      { key: 'periodValueKey', label: 'Period key', type: 'text', showWhen: { key: 'addPeriodBetweenMsgs', equals: true } },
    ],
    defaultConfig: {
      inputValueKey: 'pulseCounter', outputValueKey: 'delta', useCache: true, addPeriodBetweenMsgs: false,
      periodValueKey: 'periodInMs', tellFailureIfDeltaIsNegative: true, excludeZeroDeltas: false,
    },
    configSchema: cfg({
      inputValueKey: nonBlank(RULE_KEY_MAX), outputValueKey: nonBlank(RULE_KEY_MAX),
      round: int(0, 15).nullable().optional(), useCache: z.boolean().optional(),
      tellFailureIfDeltaIsNegative: z.boolean().optional(), excludeZeroDeltas: z.boolean().optional(),
      addPeriodBetweenMsgs: z.boolean().optional(), periodValueKey: z.string().max(RULE_KEY_MAX).nullable().optional(),
    }),
  }),
  notBuilt('enrichment', 'customer-attributes', 'Customer attributes', 'metadata.TbGetCustomerAttributeNode', 'none', `${NONE}there are no customers.`),
  notBuilt('enrichment', 'customer-details', 'Customer details', 'metadata.TbGetCustomerDetailsNode', 'none', `${NONE}there are no customers.`),
  notBuilt('enrichment', 'fetch-device-credentials', 'Fetch device credentials', 'metadata.TbFetchDeviceCredentialsNode', 'none', `${NONE}instrument tokens are stored hashed; there is nothing to fetch.`),
  built({
    id: 'tb:enrichment:originator-attributes', tbClass: `${TB}metadata.TbGetAttributesNode`, group: 'enrichment', label: 'Originator attributes',
    description: 'Adds the originator instrument\'s attributes and latest readings to the message data or metadata.',
    relations: FS, fields: ATTRIBUTE_FETCH_FIELDS,
    defaultConfig: { ...ATTRIBUTE_FETCH_DEFAULT },
    configSchema: cfg(attributeFetchShape),
  }),
  built({
    id: 'tb:enrichment:originator-fields', tbClass: `${TB}metadata.TbGetOriginatorFieldsNode`, group: 'enrichment', label: 'Originator fields',
    description: 'Adds fields of the originator instrument (name, code, profile, functional location …) to the message data or metadata.',
    relations: FS,
    fields: [
      { key: 'dataMapping', label: 'Field → key', type: 'map', required: true, help: `Fields: ${RULE_ORIGINATOR_FIELDS.join(', ')}.` },
      { key: 'ignoreNullStrings', label: 'Leave out empty fields', type: 'boolean' },
      { key: 'fetchTo', label: 'Add to', type: 'select', options: FETCH_TO_OPTIONS },
    ],
    defaultConfig: { dataMapping: { name: 'originatorName', type: 'originatorType' }, ignoreNullStrings: false, fetchTo: 'METADATA' },
    configSchema: cfg({ dataMapping: stringMap, ignoreNullStrings: z.boolean().optional(), fetchTo: fetchTo.optional() }),
  }),
  built({
    id: 'tb:enrichment:originator-telemetry', tbClass: `${TB}metadata.TbGetTelemetryNode`, group: 'enrichment', label: 'Originator telemetry',
    description: 'Adds the originator instrument\'s readings from a time window: the first, the last, all of them, or an aggregate.',
    relations: FS,
    fields: [
      { key: 'latestTsKeyNames', label: 'Keys', type: 'keys', required: true },
      { key: 'fetchMode', label: 'Fetch', type: 'select', options: [{ value: 'FIRST', label: 'First' }, { value: 'LAST', label: 'Last' }, { value: 'ALL', label: 'All' }] },
      { key: 'aggregation', label: 'Aggregation', type: 'select', showWhen: { key: 'fetchMode', equals: 'ALL' },
        options: ['NONE', 'AVG', 'MIN', 'MAX', 'SUM', 'COUNT'].map((value) => ({ value, label: value === 'NONE' ? 'None' : value })) },
      { key: 'orderBy', label: 'Order', type: 'select', showWhen: { key: 'fetchMode', equals: 'ALL' }, options: [{ value: 'ASC', label: 'Oldest first' }, { value: 'DESC', label: 'Newest first' }] },
      { key: 'limit', label: 'At most', type: 'number', min: 2, max: 1000, showWhen: { key: 'fetchMode', equals: 'ALL' } },
      { key: 'useMetadataIntervalPatterns', label: 'Window from message metadata', type: 'boolean' },
      { key: 'startInterval', label: 'Window starts … ago', type: 'number', min: 0, showWhen: { key: 'useMetadataIntervalPatterns', equals: false } },
      { key: 'startIntervalTimeUnit', label: 'Start unit', type: 'select', options: TIME_UNIT_OPTIONS, showWhen: { key: 'useMetadataIntervalPatterns', equals: false } },
      { key: 'endInterval', label: 'Window ends … ago', type: 'number', min: 0, showWhen: { key: 'useMetadataIntervalPatterns', equals: false } },
      { key: 'endIntervalTimeUnit', label: 'End unit', type: 'select', options: TIME_UNIT_OPTIONS, showWhen: { key: 'useMetadataIntervalPatterns', equals: false } },
      { key: 'startIntervalPattern', label: 'Start (ms epoch) pattern', type: 'template', help: TEMPLATE_HELP, showWhen: { key: 'useMetadataIntervalPatterns', equals: true } },
      { key: 'endIntervalPattern', label: 'End (ms epoch) pattern', type: 'template', help: TEMPLATE_HELP, showWhen: { key: 'useMetadataIntervalPatterns', equals: true } },
    ],
    defaultConfig: {
      latestTsKeyNames: [], fetchMode: 'FIRST', startIntervalTimeUnit: 'MINUTES', startInterval: 2,
      endIntervalTimeUnit: 'MINUTES', endInterval: 1, useMetadataIntervalPatterns: false,
      startIntervalPattern: '', endIntervalPattern: '', orderBy: 'ASC', aggregation: 'NONE', limit: 1000,
    },
    configSchema: cfg({
      latestTsKeyNames: keyList.optional(),
      fetchMode: z.enum(['FIRST', 'LAST', 'ALL']).optional(),
      aggregation: z.enum(['NONE', 'AVG', 'MIN', 'MAX', 'SUM', 'COUNT']).optional(),
      orderBy: z.enum(['ASC', 'DESC']).optional(),
      limit: int(2, 1000).optional(),
      useMetadataIntervalPatterns: z.boolean().optional(),
      startInterval: z.number().int().min(0).optional(), startIntervalTimeUnit: TIME_UNITS.optional(),
      endInterval: z.number().int().min(0).optional(), endIntervalTimeUnit: TIME_UNITS.optional(),
      startIntervalPattern: template.nullable().optional(), endIntervalPattern: template.nullable().optional(),
    }),
  }),
  built({
    id: 'tb:enrichment:related-device-attributes', tbClass: `${TB}metadata.TbGetDeviceAttrNode`, group: 'enrichment', label: 'Related device attributes',
    description: 'Adds the attributes and latest readings of the originator instrument\'s GATEWAY — the one relation here; general relations are later.',
    relations: FS, fields: ATTRIBUTE_FETCH_FIELDS,
    defaultConfig: {
      ...ATTRIBUTE_FETCH_DEFAULT,
      // TO the originator = its GATEWAY (the link runs gateway → instrument), as the
      // description says; ThingsBoard's default is FROM (ruled 2026-11-04).
      deviceRelationsQuery: { direction: 'TO', maxLevel: 1, relationType: 'Contains', deviceTypes: ['default'], fetchLastLevelOnly: false },
    },
    configSchema: cfg({ ...attributeFetchShape, deviceRelationsQuery: anyObject.nullable().optional() }),
  }),
  notBuilt('enrichment', 'related-entity-data', 'Related entity data', 'metadata.TbGetRelatedAttributeNode', 'later', `${LATER}needs relations between instruments beyond the gateway link.`),
  built({
    id: 'tb:enrichment:tenant-attributes', tbClass: `${TB}metadata.TbGetTenantAttributeNode`, group: 'enrichment', label: 'Tenant attributes',
    description: 'Application attributes: adds values from the key / value list under Configuration → Rule Engine (ThingsBoard reads the tenant\'s attributes).',
    relations: FS,
    fields: [
      { key: 'dataMapping', label: 'Application attribute → key', type: 'map', required: true },
      { key: 'fetchTo', label: 'Add to', type: 'select', options: FETCH_TO_OPTIONS },
    ],
    defaultConfig: { dataMapping: { alarmThreshold: 'threshold' }, dataToFetch: 'ATTRIBUTES', fetchTo: 'METADATA' },
    configSchema: cfg({ dataMapping: stringMap, dataToFetch: z.enum(['ATTRIBUTES', 'LATEST_TELEMETRY', 'FIELDS']).optional(), fetchTo: fetchTo.optional() }),
  }),
  built({
    id: 'tb:enrichment:tenant-details', tbClass: `${TB}metadata.TbGetTenantDetailsNode`, group: 'enrichment', label: 'Tenant details',
    description: 'Application details: adds the company name, application name, server name and version (ThingsBoard reads the tenant\'s details).',
    relations: FS,
    fields: [
      { key: 'detailsList', label: 'Details', type: 'multiselect', options: [
        { value: 'TITLE', label: 'Company name' },
        { value: 'APP_NAME', label: 'Application name' },
        { value: 'SERVER_NAME', label: 'Server name' },
        { value: 'SERVER_VERSION', label: 'Server version' },
      ] },
      { key: 'fetchTo', label: 'Add to', type: 'select', options: FETCH_TO_OPTIONS },
    ],
    defaultConfig: { detailsList: [], fetchTo: 'DATA' },
    configSchema: cfg({ detailsList: z.array(z.string().min(1).max(64)).max(RULE_KEYS_MAX).optional(), fetchTo: fetchTo.optional() }),
  }),
];

const TRANSFORMATION: RuleNodeTypeSpec[] = [
  built({
    id: 'tb:transformation:change-originator', tbClass: `${TB}transform.TbChangeOriginatorNode`, group: 'transformation', label: 'Change originator',
    description: 'Makes another entity the originator: the alarm\'s instrument, an instrument found by code, the gateway, or the system.',
    relations: FS,
    fields: [
      { key: 'originatorSource', label: 'New originator', type: 'select', required: true, options: [
        { value: 'ALARM_ORIGINATOR', label: 'The alarm\'s instrument' },
        { value: 'ENTITY', label: 'An instrument, by code' },
        { value: 'RELATED', label: 'The instrument\'s gateway' },
        { value: 'TENANT', label: 'The system' },
      ] },
      { key: 'entityType', label: 'Entity type', type: 'select', options: [{ value: 'DEVICE', label: 'Instrument' }], showWhen: { key: 'originatorSource', equals: 'ENTITY' } },
      { key: 'entityNamePattern', label: 'Instrument code', type: 'template', help: TEMPLATE_HELP, showWhen: { key: 'originatorSource', equals: 'ENTITY' } },
    ],
    defaultConfig: {
      originatorSource: 'ALARM_ORIGINATOR',
      // RELATED = the gateway: the link runs gateway → instrument, so from the
      // instrument it is reached TO the originator (ThingsBoard's default is FROM).
      relationsQuery: { direction: 'TO', maxLevel: 1, filters: [{ relationType: 'Contains', entityTypes: [] }], fetchLastLevelOnly: false },
      preserveOriginatorIfCustomer: false,
    },
    configSchema: cfg({
      // CUSTOMER is ThingsBoard's default; it is accepted (an import keeps it) and fails at run time — there are no customers.
      originatorSource: z.enum(['CUSTOMER', 'TENANT', 'RELATED', 'ALARM_ORIGINATOR', 'ENTITY']),
      entityType: z.string().max(64).nullable().optional(),
      entityNamePattern: template.nullable().optional(),
      relationsQuery: anyObject.nullable().optional(),
      preserveOriginatorIfCustomer: z.boolean().optional(),
    }),
  }),
  built({
    id: 'tb:transformation:copy-key-value-pairs', tbClass: `${TB}transform.TbCopyKeysNode`, group: 'transformation', label: 'Copy key-value pairs',
    description: 'Copies keys from the message data to its metadata, or the other way.',
    relations: FS,
    fields: [
      { key: 'copyFrom', label: 'Copy from', type: 'select', options: SOURCE_OPTIONS },
      { key: 'keys', label: 'Keys', type: 'keys', help: 'A key may be a regular expression.' },
    ],
    defaultConfig: { keys: [], copyFrom: 'DATA' },
    configSchema: cfg({ copyFrom: fetchTo.optional(), keys: keyList.optional() }),
  }),
  built({
    id: 'tb:transformation:deduplication', tbClass: `${TB}deduplication.TbMsgDeduplicationNode`, group: 'transformation', label: 'Deduplication',
    description: 'Within each interval per originator, passes on the first message, the last one, or all of them merged into one.',
    relations: FS,
    fields: [
      { key: 'interval', label: 'Interval (seconds)', type: 'number', required: true, min: 1 },
      { key: 'strategy', label: 'Strategy', type: 'select', options: [{ value: 'FIRST', label: 'First' }, { value: 'LAST', label: 'Last' }, { value: 'ALL', label: 'All' }] },
      { key: 'outMsgType', label: 'Output message type', type: 'text', showWhen: { key: 'strategy', equals: 'ALL' } },
      { key: 'maxPendingMsgs', label: 'Pending messages per originator', type: 'number', min: 1, max: 1000 },
      { key: 'maxRetries', label: 'Retries', type: 'number', min: 0, max: 100 },
    ],
    defaultConfig: { interval: 60, strategy: 'FIRST', maxPendingMsgs: 100, maxRetries: 3 },
    configSchema: cfg({
      interval: z.number().int().min(1),
      strategy: z.enum(['FIRST', 'LAST', 'ALL']).optional(),
      outMsgType: z.string().max(RULE_KEY_MAX).nullable().optional(),
      maxPendingMsgs: int(1, 1000).optional(),
      maxRetries: int(0, 100).optional(),
    }),
  }),
  built({
    id: 'tb:transformation:delete-key-value-pairs', tbClass: `${TB}transform.TbDeleteKeysNode`, group: 'transformation', label: 'Delete key-value pairs',
    description: 'Deletes keys from the message data or metadata.',
    relations: FS,
    fields: [
      { key: 'deleteFrom', label: 'Delete from', type: 'select', options: SOURCE_OPTIONS },
      { key: 'keys', label: 'Keys', type: 'keys', help: 'A key may be a regular expression.' },
    ],
    defaultConfig: { keys: [], deleteFrom: 'DATA' },
    configSchema: cfg({ deleteFrom: fetchTo.optional(), keys: keyList.optional() }),
  }),
  built({
    id: 'tb:transformation:json-path', tbClass: `${TB}transform.TbJsonPathNode`, group: 'transformation', label: 'JSON path',
    description: 'Replaces the message data with the result of a JSONPath expression.',
    relations: FS,
    fields: [{ key: 'jsonPath', label: 'JSONPath', type: 'text', required: true, help: 'e.g. $.values.temperature' }],
    defaultConfig: { jsonPath: '$' },
    configSchema: cfg({ jsonPath: nonBlank(RULE_TEMPLATE_MAX) }),
  }),
  built({
    id: 'tb:transformation:rename-keys', tbClass: `${TB}transform.TbRenameKeysNode`, group: 'transformation', label: 'Rename keys',
    description: 'Renames keys in the message data or metadata.',
    relations: FS,
    fields: [
      { key: 'renameIn', label: 'Rename in', type: 'select', options: SOURCE_OPTIONS },
      { key: 'renameKeysMapping', label: 'Key → new key', type: 'map', required: true },
    ],
    defaultConfig: { renameKeysMapping: { temperatureCelsius: 'temperature' }, renameIn: 'DATA' },
    configSchema: cfg({ renameIn: fetchTo.optional(), renameKeysMapping: stringMap }),
  }),
  built({
    id: 'tb:transformation:script', tbClass: `${TB}transform.TbTransformMsgNode`, group: 'transformation', label: 'Script',
    description: 'A JavaScript function returning { msg, metadata, msgType } — or an array of them for several messages.',
    relations: FS,
    fields: [scriptField('transform', 'Transform function', 'Return { msg, metadata, msgType } or an array of them.')],
    defaultConfig: { scriptLang: 'JS', jsScript: 'return {msg: msg, metadata: metadata, msgType: msgType};' },
    configSchema: cfg({ scriptLang, jsScript: script, tbelScript }),
  }),
  built({
    id: 'tb:transformation:split-array-msg', tbClass: `${TB}transform.TbSplitArrayMsgNode`, group: 'transformation', label: 'Split array msg',
    description: 'Splits a message whose data is an array into one message per element.',
    relations: FS, fields: [], defaultConfig: { version: 0 }, configSchema: emptyConfig,
  }),
  built({
    id: 'tb:transformation:to-email', tbClass: `${TB}mail.TbMsgToEmailNode`, group: 'transformation', label: 'To email',
    description: 'Builds an email (a SEND_EMAIL message) from templates; Send email sends it.',
    relations: FS,
    fields: [
      { key: 'fromTemplate', label: 'From', type: 'template', required: true, help: TEMPLATE_HELP },
      { key: 'toTemplate', label: 'To', type: 'template', required: true, help: 'Comma-separated addresses.' },
      { key: 'ccTemplate', label: 'Cc', type: 'template' },
      { key: 'bccTemplate', label: 'Bcc', type: 'template' },
      { key: 'subjectTemplate', label: 'Subject', type: 'template', required: true },
      { key: 'mailBodyType', label: 'Body type', type: 'select', options: [
        { value: 'false', label: 'Plain text' }, { value: 'true', label: 'HTML' }, { value: 'dynamic', label: 'From a template' },
      ] },
      { key: 'isHtmlTemplate', label: 'HTML? (true / false)', type: 'template', showWhen: { key: 'mailBodyType', equals: 'dynamic' } },
      { key: 'bodyTemplate', label: 'Body', type: 'template', required: true },
    ],
    defaultConfig: {
      fromTemplate: 'info@testmail.org', toTemplate: '${userEmail}',
      subjectTemplate: 'Instrument ${instrumentCode} temperature high',
      bodyTemplate: 'Instrument ${instrumentCode} has high temperature $[temperature]', mailBodyType: 'false',
    },
    configSchema: cfg({
      fromTemplate: nonBlank(RULE_TEMPLATE_MAX), toTemplate: nonBlank(RULE_TEMPLATE_MAX),
      ccTemplate: template.nullable().optional(), bccTemplate: template.nullable().optional(),
      subjectTemplate: nonBlank(RULE_TEMPLATE_MAX), bodyTemplate: nonBlank(RULE_TEMPLATE_MAX),
      mailBodyType: z.enum(['false', 'true', 'dynamic']).optional(), isHtmlTemplate: template.nullable().optional(),
    }),
  }),
  notBuilt('transformation', 'duplicate-to-group', 'Duplicate to group', 'transform.TbDuplicateMsgToGroupNode', 'none', PE),
  notBuilt('transformation', 'duplicate-to-group-by-name', 'Duplicate to group by name', 'transform.TbDuplicateMsgToGroupByNameNode', 'none', PE),
  notBuilt('transformation', 'duplicate-to-related', 'Duplicate to related', 'transform.TbDuplicateMsgToRelatedNode', 'none', PE),
];

const alarmDetailsField: RuleNodeConfigField = scriptField('details', 'Alarm details', 'Return the details object stored on the alarm.', 'alarmDetailsBuildJs');

const ACTION: RuleNodeTypeSpec[] = [
  notBuilt('action', 'calculated-fields', 'Calculated fields', 'telemetry.TbCalculatedFieldsNode', 'none', `${NONE}ThingsBoard's calculated fields have no counterpart; use Math function or Script.`),
  built({
    id: 'tb:action:clear-alarm', tbClass: `${TB}action.TbClearAlarmNode`, group: 'action', label: 'Clear alarm',
    description: 'Clears the originator\'s active alarm of the given type: Cleared, or False when there is none.',
    relations: ['Cleared', RULE_RELATION_FALSE, RULE_RELATION_FAILURE],
    fields: [{ key: 'alarmType', label: 'Alarm type', type: 'template', required: true, help: TEMPLATE_HELP }, alarmDetailsField],
    defaultConfig: { scriptLang: 'JS', alarmDetailsBuildJs: ALARM_DETAILS_JS, alarmType: 'General Alarm' },
    configSchema: cfg({ alarmType: nonBlank(RULE_KEY_MAX), scriptLang, alarmDetailsBuildJs: script, alarmDetailsBuildTbel: tbelScript }),
  }),
  notBuilt('action', 'copy-to-view', 'Copy to view', 'action.TbCopyAttributesToEntityViewNode', 'none', `${NONE}there are no entity views.`),
  built({
    id: 'tb:action:create-alarm', tbClass: `${TB}action.TbCreateAlarmNode`, group: 'action', label: 'Create alarm',
    description: 'Raises an alarm of the given type on the originator instrument, or updates the active one: Created / Updated. It shows on the Alarms page like any other alarm.',
    relations: ['Created', 'Updated', RULE_RELATION_FALSE, RULE_RELATION_FAILURE],
    fields: [
      { key: 'alarmType', label: 'Alarm type', type: 'template', required: true, help: TEMPLATE_HELP },
      { key: 'useMessageAlarmData', label: 'Use the alarm data in the message', type: 'boolean' },
      { key: 'overwriteAlarmDetails', label: 'Overwrite the alarm details', type: 'boolean', showWhen: { key: 'useMessageAlarmData', equals: true } },
      { key: 'dynamicSeverity', label: 'Severity from a template', type: 'boolean' },
      { key: 'severity', label: 'Severity', type: 'select', required: true, showWhen: { key: 'dynamicSeverity', equals: false },
        options: ALARM_SEVERITIES.map((value) => ({ value, label: value.charAt(0) + value.slice(1).toLowerCase() })),
        help: 'ThingsBoard\'s Warning and Indeterminate read as Minor.' },
      // The SAME key while the severity is dynamic — ThingsBoard stores the pattern in `severity` too.
      // Never shown together with the select (see visibleRuleNodeFields).
      { key: 'severity', label: 'Severity pattern', type: 'template', required: true, showWhen: { key: 'dynamicSeverity', equals: true },
        help: `e.g. \${severity}; it must come out as Critical, Major or Minor (Warning / Indeterminate read as Minor). ${TEMPLATE_HELP}` },
      { key: 'propagate', label: 'Propagate to related entities', type: 'boolean', help: 'Kept for export; there are no related entities to propagate to.' },
      { ...alarmDetailsField, showWhen: { key: 'useMessageAlarmData', equals: false } },
    ],
    defaultConfig: {
      scriptLang: 'JS', alarmDetailsBuildJs: ALARM_DETAILS_JS, alarmType: 'General Alarm', severity: 'CRITICAL',
      propagate: false, propagateToOwner: false, propagateToOwnerHierarchy: false, propagateToTenant: false,
      useMessageAlarmData: false, overwriteAlarmDetails: false, relationTypes: [], dynamicSeverity: false,
    },
    configSchema: cfg({
      alarmType: nonBlank(RULE_KEY_MAX), scriptLang, alarmDetailsBuildJs: script.optional(), alarmDetailsBuildTbel: tbelScript,
      severity: nonBlank(RULE_KEY_MAX), dynamicSeverity: z.boolean().optional(),
      propagate: z.boolean().optional(), propagateToOwner: z.boolean().optional(), propagateToOwnerHierarchy: z.boolean().optional(),
      propagateToTenant: z.boolean().optional(), relationTypes: keyList.nullable().optional(),
      useMessageAlarmData: z.boolean().optional(), overwriteAlarmDetails: z.boolean().optional(),
    }).superRefine((c, ctx) => {
      if (c.dynamicSeverity !== true && !(ALARM_SEVERITIES_TB as readonly string[]).includes(c.severity)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['severity'], message: `Severity must be one of ${ALARM_SEVERITIES.join(', ')}` });
      }
    }),
  }),
  notBuilt('action', 'create-relation', 'Create relation', 'action.TbCreateRelationNode', 'later', `${LATER}needs relations between instruments beyond the gateway link.`),
  built({
    id: 'tb:action:delay', tbClass: `${TB}delay.TbMsgDelayNode`, group: 'action', label: 'Delay (deprecated)',
    description: 'Holds each message for a period, then passes it on. Durable here — it survives a restart (ThingsBoard\'s does not).',
    relations: FS,
    fields: [
      { key: 'useMetadataPeriodInSecondsPatterns', label: 'Period from message metadata', type: 'boolean' },
      { key: 'periodInSeconds', label: 'Period (seconds)', type: 'number', min: 1, showWhen: { key: 'useMetadataPeriodInSecondsPatterns', equals: false } },
      { key: 'periodInSecondsPattern', label: 'Period pattern', type: 'template', help: TEMPLATE_HELP, showWhen: { key: 'useMetadataPeriodInSecondsPatterns', equals: true } },
      { key: 'maxPendingMsgs', label: 'Pending messages at most', type: 'number', min: 1, max: 100_000 },
    ],
    defaultConfig: { periodInSeconds: 60, maxPendingMsgs: 1000, useMetadataPeriodInSecondsPatterns: false },
    configSchema: cfg({
      periodInSeconds: z.number().int().min(1).optional(), maxPendingMsgs: int(1, 100_000).optional(),
      useMetadataPeriodInSecondsPatterns: z.boolean().optional(), periodInSecondsPattern: template.nullable().optional(),
    }),
  }),
  built({
    id: 'tb:action:delete-attributes', tbClass: `${TB}telemetry.TbMsgDeleteAttributesNode`, group: 'action', label: 'Delete attributes',
    description: 'Deletes attributes of the originator instrument (audited, as an attribute delete on the Settings page is).',
    relations: FS,
    fields: [
      { key: 'keys', label: 'Keys', type: 'keys', required: true, help: TEMPLATE_HELP },
      { key: 'scope', label: 'Scope', type: 'select', options: SCOPE_OPTIONS, help: SCOPES_HELP },
      { key: 'sendAttributesDeletedNotification', label: 'Send an Attributes Deleted message', type: 'boolean' },
      { key: 'notifyDevice', label: 'Tell the instrument', type: 'boolean' },
    ],
    defaultConfig: { scope: 'SERVER_SCOPE', keys: [], sendAttributesDeletedNotification: false, notifyDevice: false },
    configSchema: cfg({
      scope: z.enum(['SERVER_SCOPE', 'SHARED_SCOPE', 'CLIENT_SCOPE']).optional(), keys: keyList.optional(),
      sendAttributesDeletedNotification: z.boolean().optional(), notifyDevice: z.boolean().optional(),
    }),
  }),
  notBuilt('action', 'delete-relation', 'Delete relation', 'action.TbDeleteRelationNode', 'later', `${LATER}needs relations between instruments beyond the gateway link.`),
  // BUILT as a pass-through (2026-11-04, ruling): every ThingsBoard release v3.6–v4.2 ships
  // its root chain with this node as the ENTRY, so an imported root chain was dead here.
  // ThingsBoard's two settings are accepted and ignored.
  built({
    id: 'tb:action:device-profile', tbClass: `${TB}profile.TbDeviceProfileNode`, group: 'action', label: 'Device profile (deprecated)',
    description: 'Passes the message on unchanged — profile alarm rules are this system\'s instrument-limit alarms (Configuration → Instrument Limit Alarms).',
    relations: FS, fields: [],
    defaultConfig: { persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: false },
    configSchema: cfg({ persistAlarmRulesState: z.boolean().optional(), fetchAlarmRulesStateOnStart: z.boolean().optional() }),
  }),
  notBuilt('action', 'device-state', 'Device state', 'action.TbDeviceStateNode', 'later', `${LATER}needs the activity tracker to accept an event; only ingest marks an instrument active today.`),
  built({
    id: 'tb:action:generator', tbClass: `${TB}debug.TbMsgGeneratorNode`, group: 'action', label: 'Generator',
    description: 'Generates a message from a script every period while the chain holds this node; re-armed when the server starts.',
    relations: FS,
    fields: [
      { key: 'msgCount', label: 'Messages (0 = no limit)', type: 'number', min: 0 },
      { key: 'periodInSeconds', label: 'Period (seconds)', type: 'number', required: true, min: 1 },
      { key: 'originatorType', label: 'Originator', type: 'select', options: [{ value: 'RULE_NODE', label: 'This rule node' }, { value: 'INSTRUMENT', label: 'An instrument' }] },
      { key: 'originatorId', label: 'Instrument', type: 'instrument', showWhen: { key: 'originatorType', equals: 'INSTRUMENT' } },
      scriptField('generator', 'Generator function', 'Return { msg, metadata, msgType }; prevMsg / prevMetadata / prevMsgType hold the last one.'),
    ],
    defaultConfig: { msgCount: 0, periodInSeconds: 1, originatorType: 'RULE_NODE', scriptLang: 'JS', jsScript: GENERATOR_JS },
    configSchema: cfg({
      msgCount: z.number().int().min(0).optional(), periodInSeconds: z.number().int().min(1),
      originatorType: z.string().min(1).max(64).optional(), originatorId: z.string().max(64).nullable().optional(),
      scriptLang, jsScript: script, tbelScript,
    }),
  }),
  notBuilt('action', 'gps-geofencing-events', 'GPS geofencing events', 'geo.TbGpsGeofencingActionNode', 'later', `${LATER}needs latitude / longitude keys on instruments.`),
  built({
    id: 'tb:action:log', tbClass: `${TB}action.TbLogNode`, group: 'action', label: 'Log',
    description: 'Writes the string the script returns to the API log.',
    relations: FS,
    fields: [scriptField('log', 'To string function', 'Return the text to log.')],
    defaultConfig: { scriptLang: 'JS', jsScript: LOG_JS },
    configSchema: cfg({ scriptLang, jsScript: script, tbelScript }),
  }),
  built({
    id: 'tb:action:math-function', tbClass: `${TB}math.TbMathNode`, group: 'action', label: 'Math function',
    description: 'Applies a math operation to values from the message data, metadata, attributes or readings, and stores the result.',
    relations: FS,
    fields: [
      { key: 'operation', label: 'Operation', type: 'select', required: true, options: RULE_MATH_OPERATIONS.map((o) => ({ value: o.value, label: o.value })) },
      { key: 'customFunction', label: 'Expression', type: 'text', showWhen: { key: 'operation', equals: 'CUSTOM' }, help: 'Arguments by name, e.g. (x - 32) / 1.8' },
      { key: 'arguments', label: 'Arguments', type: 'json', required: true,
        help: `[{ "name": "x", "type": "${MATH_ARG_TYPES.join(' | ')}", "key": "temperature", "defaultValue"?: 0 }]` },
      { key: 'result', label: 'Result', type: 'json', required: true,
        help: `{ "type": "${MATH_RESULT_TYPES.join(' | ')}", "key": "result", "resultValuePrecision": 2 }` },
    ],
    defaultConfig: {
      operation: 'CUSTOM', customFunction: '(x - 32) / 1.8',
      arguments: [{ name: 'x', type: 'MESSAGE_BODY', key: 'temperature' }],
      result: { type: 'MESSAGE_BODY', key: 'temperatureCelsius', resultValuePrecision: 2, addToBody: false, addToMetadata: false, attributeScope: null },
    },
    configSchema: cfg({
      operation: z.enum(RULE_MATH_OPERATIONS.map((o) => o.value) as [string, ...string[]]),
      customFunction: z.string().max(RULE_TEMPLATE_MAX).nullable().optional(),
      arguments: z.array(cfg({
        name: z.string().max(RULE_KEY_MAX).nullable().optional(),
        type: z.enum(MATH_ARG_TYPES),
        key: z.string().max(RULE_KEY_MAX),
        defaultValue: z.number().nullable().optional(),
        attributeScope: z.string().max(64).nullable().optional(),
      })).max(16),
      result: cfg({
        type: z.enum(MATH_RESULT_TYPES),
        key: nonBlank(RULE_KEY_MAX),
        resultValuePrecision: int(0, 15).optional(),
        addToBody: z.boolean().optional(),
        addToMetadata: z.boolean().optional(),
        attributeScope: z.string().max(64).nullable().optional(),
      }),
    }).superRefine((c, ctx) => {
      const op = RULE_MATH_OPERATIONS.find((o) => o.value === c.operation);
      if (op && (c.arguments.length < op.minArgs || c.arguments.length > op.maxArgs)) {
        const want = op.minArgs === op.maxArgs ? String(op.minArgs) : `${op.minArgs} to ${op.maxArgs}`;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arguments'], message: `${c.operation} takes ${want} argument(s)` });
      }
      if (c.operation === 'CUSTOM' && !(c.customFunction ?? '').trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customFunction'], message: 'Required' });
      }
    }),
  }),
  built({
    id: 'tb:action:message-count', tbClass: `${TB}action.TbMsgCountNode`, group: 'action', label: 'Message count',
    description: 'Every interval, emits how many messages passed through, as a reading of a system originator.',
    relations: FS,
    fields: [
      { key: 'interval', label: 'Interval (seconds)', type: 'number', required: true, min: 1 },
      { key: 'telemetryPrefix', label: 'Reading key prefix', type: 'text', required: true },
    ],
    defaultConfig: { interval: 1, telemetryPrefix: 'messageCount' },
    configSchema: cfg({ interval: z.number().int().min(1), telemetryPrefix: nonBlank(RULE_KEY_MAX) }),
  }),
  notBuilt('action', 'push-to-edge', 'Push to edge', 'edge.TbMsgPushToEdgeNode', 'none', `${NONE}there is no ThingsBoard Edge.`),
  notBuilt('action', 'rest-call-reply', 'REST call reply', 'rest.TbSendRestApiCallReplyNode', 'later', `${LATER}needs a synchronous REST request route; the inject route answers at once.`),
  notBuilt('action', 'rpc-call-reply', 'RPC call reply', 'rpc.TbSendRPCReplyNode', 'later', `${LATER}needs device RPC; instruments here only report.`),
  notBuilt('action', 'rpc-call-request', 'RPC call request', 'rpc.TbSendRPCRequestNode', 'later', `${LATER}needs device RPC; instruments here only report.`),
  built({
    id: 'tb:action:save-attributes', tbClass: `${TB}telemetry.TbMsgAttributesNode`, group: 'action', label: 'Save attributes',
    description: 'Saves the message data as attributes of the originator instrument, through the writer the Settings page uses (audited).',
    relations: FS,
    fields: [
      { key: 'scope', label: 'Scope', type: 'select', options: SCOPE_OPTIONS, help: SCOPES_HELP },
      // TB-P 7 (2026-11-05): both toggles DO something, said here (21 CFR Part 11 keeps the writer change-only).
      { key: 'updateAttributesOnlyOnValueChange', label: 'Write only a changed value', type: 'boolean',
        help: 'An unchanged value is never written or audited again here (21 CFR Part 11), whatever this says. Off: the Attributes Updated message lists every key of the message, not only the changed ones.' },
      { key: 'notifyDevice', label: 'Tell the instrument', type: 'boolean', help: 'Publishes the attribute to the instrument, as an edit on the Settings page does.' },
      { key: 'sendAttributesUpdatedNotification', label: 'Send an Attributes Updated message', type: 'boolean',
        help: 'Sent only when a value changed, and never for the client scope (as in ThingsBoard). It enters a chain only while that chain\'s "Re-enter on rule-node writes" is on.' },
    ],
    defaultConfig: {
      processingSettings: { type: 'ON_EVERY_MESSAGE' }, scope: 'SERVER_SCOPE', notifyDevice: false,
      sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true,
    },
    configSchema: cfg({
      scope: z.enum(['SERVER_SCOPE', 'SHARED_SCOPE', 'CLIENT_SCOPE']).optional(),
      notifyDevice: z.boolean().optional(), sendAttributesUpdatedNotification: z.boolean().optional(),
      updateAttributesOnlyOnValueChange: z.boolean().optional(), processingSettings: anyObject.nullable().optional(),
    }),
  }),
  built({
    id: 'tb:action:save-timeseries', tbClass: `${TB}telemetry.TbMsgTimeseriesNode`, group: 'action', label: 'Save time series',
    description: 'Saves the message data as readings of the originator instrument, through the one ingest write path (sensor offsets are not applied again).',
    relations: FS,
    fields: [
      { key: 'useServerTs', label: 'Stamp with the server time', type: 'boolean' },
      { key: 'skipLatestPersistence', label: 'Do not update the latest readings', type: 'boolean',
        help: 'ThingsBoard 4.x keeps this as processing settings (latest: Skip); an import and an export convert between the two.' },
      { key: 'defaultTTL', label: 'Time to live (seconds)', type: 'number', min: 0, help: 'Kept for export; monthly partitions govern retention here.' },
    ],
    defaultConfig: { defaultTTL: 0, useServerTs: false, skipLatestPersistence: false, processingSettings: { type: 'ON_EVERY_MESSAGE' } },
    configSchema: cfg({
      defaultTTL: z.number().int().min(0).optional(), useServerTs: z.boolean().optional(),
      skipLatestPersistence: z.boolean().optional(), processingSettings: anyObject.nullable().optional(),
    }),
  }),
  notBuilt('action', 'assign-to-customer', 'Assign to customer', 'action.TbAssignToCustomerNode', 'none', `${NONE}there are no customers.`),
  notBuilt('action', 'unassign-from-customer', 'Unassign from customer', 'action.TbUnassignFromCustomerNode', 'none', `${NONE}there are no customers.`),
  notBuilt('action', 'push-to-cloud', 'Push to cloud', 'edge.TbMsgPushToCloudNode', 'none', `${NONE}a ThingsBoard Edge node.`),
  notBuilt('action', 'add-to-group', 'Add to group', 'action.TbAddToGroupNode', 'none', PE),
  notBuilt('action', 'change-owner', 'Change owner', 'action.TbChangeOwnerNode', 'none', PE),
  notBuilt('action', 'generate-dashboard-report', 'Generate dashboard report', 'report.TbGenerateReportNode', 'none', PE),
  notBuilt('action', 'generate-report', 'Generate report', 'report.TbGenerateReportV2Node', 'none', PE),
  notBuilt('action', 'integration-downlink', 'Integration downlink', 'integration.TbIntegrationDownlinkNode', 'none', PE),
  notBuilt('action', 'remove-from-group', 'Remove from group', 'action.TbRemoveFromGroupNode', 'none', PE),
  notBuilt('action', 'save-to-custom-table', 'Save to custom table', 'action.TbSaveToCustomCassandraTableNode', 'none', PE),
];

const EXTERNAL: RuleNodeTypeSpec[] = [
  notBuilt('external', 'ai-request', 'AI request', 'ai.TbAiNode', 'later', `${LATER}needs an AI provider configured.`),
  notBuilt('external', 'aws-lambda', 'AWS Lambda', 'aws.lambda.TbAwsLambdaNode', 'none', `${NONE}a vendor SDK this platform does not carry.`),
  notBuilt('external', 'aws-sns', 'AWS SNS', 'aws.sns.TbSnsNode', 'none', `${NONE}a vendor SDK this platform does not carry.`),
  notBuilt('external', 'aws-sqs', 'AWS SQS', 'aws.sqs.TbSqsNode', 'none', `${NONE}a vendor SDK this platform does not carry.`),
  notBuilt('external', 'azure-iot-hub', 'Azure IoT Hub', 'mqtt.azure.TbAzureIotHubNode', 'none', `${NONE}a vendor service this platform does not carry.`),
  notBuilt('external', 'gcp-pubsub', 'GCP Pub/Sub', 'gcp.pubsub.TbPubSubNode', 'none', `${NONE}a vendor SDK this platform does not carry.`),
  notBuilt('external', 'kafka', 'Kafka', 'kafka.TbKafkaNode', 'none', `${NONE}there is no Kafka here.`),
  built({
    id: 'tb:external:mqtt', tbClass: `${TB}mqtt.TbMqttNode`, group: 'external', label: 'MQTT',
    description: 'Publishes the message data to a topic on an MQTT broker.',
    relations: FS,
    fields: [
      { key: 'topicPattern', label: 'Topic', type: 'template', required: true, help: TEMPLATE_HELP },
      { key: 'host', label: 'Host', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'number', required: true, min: 1, max: 65535 },
      { key: 'connectTimeoutSec', label: 'Connect timeout (seconds)', type: 'number', min: 1, max: 200 },
      { key: 'clientId', label: 'Client id', type: 'text' },
      { key: 'appendClientIdSuffix', label: 'Add a suffix to the client id', type: 'boolean' },
      { key: 'protocolVersion', label: 'Protocol', type: 'select', options: [
        { value: 'MQTT_3_1', label: 'MQTT 3.1' }, { value: 'MQTT_3_1_1', label: 'MQTT 3.1.1' }, { value: 'MQTT_5', label: 'MQTT 5' },
      ] },
      { key: 'cleanSession', label: 'Clean session', type: 'boolean' },
      { key: 'retainedMessage', label: 'Retained', type: 'boolean' },
      { key: 'ssl', label: 'TLS', type: 'boolean' },
      { key: 'parseToPlainText', label: 'Publish a string as plain text', type: 'boolean' },
      { key: 'credentials', label: 'Credentials', type: 'json', help: CREDENTIALS_HELP },
    ],
    defaultConfig: {
      topicPattern: 'my-topic', host: '', port: 1883, connectTimeoutSec: 10, cleanSession: true, ssl: false,
      retainedMessage: false, parseToPlainText: false, protocolVersion: 'MQTT_3_1_1', credentials: { type: 'anonymous' },
    },
    configSchema: cfg({
      topicPattern: nonBlank(RULE_TEMPLATE_MAX), host: z.string().max(255).nullable().optional(), port: int(1, 65535),
      connectTimeoutSec: int(1, 200).optional(), clientId: z.string().max(256).nullable().optional(),
      appendClientIdSuffix: z.boolean().optional(), cleanSession: z.boolean().optional(), retainedMessage: z.boolean().optional(),
      ssl: z.boolean().optional(), parseToPlainText: z.boolean().optional(),
      protocolVersion: z.enum(['MQTT_3_1', 'MQTT_3_1_1', 'MQTT_5']).optional(), credentials: clientCredentials.optional(),
    }),
  }),
  notBuilt('external', 'rabbitmq', 'RabbitMQ', 'rabbitmq.TbRabbitMqNode', 'none', `${NONE}there is no RabbitMQ here.`),
  built({
    id: 'tb:external:rest-api-call', tbClass: `${TB}rest.TbRestApiCallNode`, group: 'external', label: 'REST API call',
    description: 'Sends the message to a REST endpoint; the response body becomes the message, its status goes in the metadata.',
    relations: FS,
    fields: [
      { key: 'restEndpointUrlPattern', label: 'URL', type: 'template', required: true, help: TEMPLATE_HELP },
      { key: 'requestMethod', label: 'Method', type: 'select', required: true,
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((value) => ({ value, label: value })) },
      { key: 'headers', label: 'Headers', type: 'map', help: TEMPLATE_HELP },
      { key: 'readTimeoutMs', label: 'Timeout (ms, 0 = the engine\'s)', type: 'number', min: 0 },
      { key: 'maxParallelRequestsCount', label: 'Parallel requests at most (0 = no limit)', type: 'number', min: 0 },
      { key: 'ignoreRequestBody', label: 'Send no body', type: 'boolean' },
      { key: 'parseToPlainText', label: 'Send a string as plain text', type: 'boolean' },
      { key: 'credentials', label: 'Credentials', type: 'json', help: CREDENTIALS_HELP },
    ],
    defaultConfig: {
      restEndpointUrlPattern: 'http://localhost/api', requestMethod: 'POST', headers: { 'Content-Type': 'application/json' },
      queryParams: [], readTimeoutMs: 0, maxParallelRequestsCount: 0, parseToPlainText: false, enableProxy: false,
      credentials: { type: 'anonymous' }, ignoreRequestBody: false, maxInMemoryBufferSizeInKb: 256,
    },
    configSchema: cfg({
      restEndpointUrlPattern: nonBlank(RULE_TEMPLATE_MAX),
      requestMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
      headers: stringMap.nullable().optional(),
      readTimeoutMs: z.number().int().min(0).optional(), maxParallelRequestsCount: z.number().int().min(0).optional(),
      ignoreRequestBody: z.boolean().optional(), parseToPlainText: z.boolean().optional(),
      enableProxy: z.boolean().optional(), credentials: clientCredentials.optional(),
    }),
  }),
  built({
    id: 'tb:external:send-email', tbClass: `${TB}mail.TbSendEmailNode`, group: 'external', label: 'Send email',
    description: 'Sends a SEND_EMAIL message (from To email) through the SMTP server configured under Configuration → Email.',
    relations: FS, fields: [],
    defaultConfig: {
      useSystemSmtpSettings: true, smtpHost: 'localhost', smtpProtocol: 'smtp', smtpPort: 25, timeout: 10000,
      enableTls: false, tlsVersion: 'TLSv1.2', enableProxy: false,
    },
    configSchema: cfg({ useSystemSmtpSettings: z.boolean().optional() }),
  }),
  built({
    id: 'tb:external:send-notification', tbClass: `${TB}notification.TbNotificationNode`, group: 'external', label: 'Send notification',
    description: 'Sends a notification template to the chosen roles and users, by email or SMS as the template says.',
    relations: FS,
    fields: [
      { key: 'templateId', label: 'Template', type: 'notification-template', required: true },
      { key: 'targets', label: 'Recipients', type: 'targets', required: true },
    ],
    defaultConfig: { templateId: null, targets: { roles: [], userIds: [] } },
    configSchema: cfg({
      templateId: z.string().max(64).nullable().optional(),
      // ThingsBoard's own targets are a list of its notification-target ids; an import keeps them (they fail at run time).
      targets: z.union([
        cfg({ roles: z.array(z.string().min(1).max(64)).max(RULE_KEYS_MAX), userIds: z.array(z.string().min(1).max(64)).max(RULE_KEYS_MAX) }),
        z.array(z.string()),
      ]).nullable().optional(),
    }),
  }),
  built({
    id: 'tb:external:send-sms', tbClass: `${TB}sms.TbSendSmsNode`, group: 'external', label: 'Send SMS',
    description: 'Sends an SMS through the SMS provider configured under Configuration → SMS.',
    relations: FS,
    fields: [
      { key: 'numbersToTemplate', label: 'Phone numbers', type: 'template', required: true, help: 'Comma-separated. ' + TEMPLATE_HELP },
      { key: 'smsMessageTemplate', label: 'Message', type: 'template', required: true, help: TEMPLATE_HELP },
    ],
    defaultConfig: {
      numbersToTemplate: '${userPhone}', smsMessageTemplate: 'Instrument ${instrumentCode} has high temperature $[temperature]',
      useSystemSmsSettings: true,
    },
    configSchema: cfg({
      numbersToTemplate: nonBlank(RULE_TEMPLATE_MAX), smsMessageTemplate: nonBlank(RULE_TEMPLATE_MAX),
      useSystemSmsSettings: z.boolean().optional(),
    }),
  }),
  built({
    id: 'tb:external:send-to-slack', tbClass: `${TB}notification.TbSlackNode`, group: 'external', label: 'Send to Slack',
    description: 'Posts a message to a Slack channel or user with a bot token (chat.postMessage).',
    relations: FS,
    fields: [
      { key: 'botToken', label: 'Bot token', type: 'text', required: true, help: 'xoxb-… Masked in exports.' },
      { key: 'conversationType', label: 'Post to', type: 'select', options: [
        { value: 'PUBLIC_CHANNEL', label: 'Public channel' }, { value: 'PRIVATE_CHANNEL', label: 'Private channel' }, { value: 'DIRECT', label: 'Direct message' },
      ] },
      { key: 'conversation', label: 'Channel or user id', type: 'text', required: true },
      { key: 'messageTemplate', label: 'Message', type: 'template', required: true, help: TEMPLATE_HELP },
    ],
    defaultConfig: {
      useSystemSettings: false, botToken: 'xoxb-', messageTemplate: 'Instrument ${instrumentCode}: temperature is $[temperature]',
      conversationType: 'PUBLIC_CHANNEL',
    },
    configSchema: cfg({
      botToken: z.string().max(512).nullable().optional(), useSystemSettings: z.boolean().optional(),
      messageTemplate: nonBlank(RULE_TEMPLATE_MAX),
      conversationType: z.enum(['PUBLIC_CHANNEL', 'PRIVATE_CHANNEL', 'DIRECT']).optional(),
      // ThingsBoard stores the conversation as an object ({ id, name, … }); a plain id is accepted too.
      conversation: z.union([z.string().max(256), cfg({ id: z.string().max(256) })]).nullable().optional(),
    }),
  }),
  notBuilt('external', 'twilio-sms', 'Twilio SMS', 'pe.twilio.TbTwilioSmsNode', 'none', PE),
  notBuilt('external', 'twilio-voice', 'Twilio Voice', 'pe.twilio.voice.TbTwilioVoiceNode', 'none', PE),
];

const FLOW: RuleNodeTypeSpec[] = [
  built({
    id: 'tb:flow:acknowledge', tbClass: `${TB}flow.TbAckNode`, group: 'flow', label: 'Acknowledge',
    description: 'Acknowledges the message (recorded in debug) and passes it on unchanged.',
    relations: FS, fields: [], defaultConfig: { version: 0 }, configSchema: emptyConfig,
  }),
  built({
    id: 'tb:flow:checkpoint', tbClass: `${TB}flow.TbCheckpointNode`, group: 'flow', label: 'Checkpoint',
    description: 'Hands the message to the durable queue, so it survives a restart, then continues.',
    relations: FS, fields: [], defaultConfig: { version: 0 }, configSchema: emptyConfig,
  }),
  built({
    id: 'tb:flow:rule-chain', tbClass: `${TB}flow.TbRuleChainInputNode`, group: 'flow', label: 'Rule chain',
    description: 'Sends the message to another rule chain; that chain\'s Output nodes return it here under their names.',
    relations: 'dynamic',
    fields: [{ key: 'ruleChainId', label: 'Rule chain', type: 'chain', required: true }],
    defaultConfig: { forwardMsgToDefaultRuleChain: false },
    configSchema: cfg({ ruleChainId: z.string().max(64).nullable().optional(), forwardMsgToDefaultRuleChain: z.boolean().optional() }),
  }),
  built({
    id: 'tb:flow:output', tbClass: `${TB}flow.TbRuleChainOutputNode`, group: 'flow', label: 'Output',
    description: 'Returns the message to the rule chain that called this one, under this node\'s name.',
    relations: [], fields: [], defaultConfig: { version: 0 }, configSchema: emptyConfig,
  }),
];

/** Every ThingsBoard rule node, grouped in palette order. */
export const RULE_NODE_TYPES: readonly RuleNodeTypeSpec[] = [...FILTER, ...ENRICHMENT, ...TRANSFORMATION, ...ACTION, ...EXTERNAL, ...FLOW];

export const RULE_NODE_TYPE_BY_ID: ReadonlyMap<string, RuleNodeTypeSpec> = new Map(RULE_NODE_TYPES.map((s) => [s.id, s]));
export const RULE_NODE_TYPE_BY_TB_CLASS: ReadonlyMap<string, RuleNodeTypeSpec> = new Map(RULE_NODE_TYPES.map((s) => [s.tbClass, s]));
export const BUILT_RULE_NODE_TYPES: readonly RuleNodeTypeSpec[] = RULE_NODE_TYPES.filter((s) => s.status === 'built');

/** A fresh, mutable copy of a node type's default configuration (`{}` for an unknown type). */
export function newRuleNodeConfig(type: string): Record<string, unknown> {
  const spec = RULE_NODE_TYPE_BY_ID.get(type);
  return spec ? cloneJson(spec.defaultConfig) : {};
}

/**
 * A node's configuration with ThingsBoard's default under every key it omits —
 * the ONE way a handler reads its config (an import from an older ThingsBoard
 * may lack a key added since). Shallow: a present key is taken whole.
 */
export function ruleNodeConfigWithDefaults(type: string, config: Record<string, unknown>): Record<string, unknown> {
  return { ...newRuleNodeConfig(type), ...config };
}

/**
 * The fields a settings form shows for a node's configuration right now: each
 * `showWhen` judged against the config WITH ThingsBoard's defaults (an imported
 * config may omit the switch a field depends on). The ONE rule the editor
 * renders by. Two fields may share a key — Create alarm's `severity` is a
 * select, or a template while `dynamicSeverity` is on — and are never visible
 * together, so a form keyed by the field's KEY plus its TYPE stays unique.
 */
export function visibleRuleNodeFields(type: string, config: Record<string, unknown>): RuleNodeConfigField[] {
  const spec = RULE_NODE_TYPE_BY_ID.get(type);
  if (!spec) return [];
  const resolved = ruleNodeConfigWithDefaults(type, config);
  return spec.fields.filter((f) => !f.showWhen || resolved[f.showWhen.key] === f.showWhen.equals);
}

/** A zod type with optional / nullable / default / refinement wrappers taken off. */
function baseZodType(t: z.ZodTypeAny): z.ZodTypeAny {
  let cur = t;
  for (let i = 0; i < 8; i++) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap();
    else if (cur instanceof z.ZodDefault) cur = cur.removeDefault();
    else if (cur instanceof z.ZodEffects) cur = cur.innerType();
    else break;
  }
  return cur;
}

const scalarKindsCache = new Map<string, ReadonlyMap<string, 'boolean' | 'number'>>();

/** The top-level keys of a node's config that hold a boolean or a number: its boolean / number FIELDS, and every key its schema models as one. */
function scalarKindsOf(spec: RuleNodeTypeSpec): ReadonlyMap<string, 'boolean' | 'number'> {
  const hit = scalarKindsCache.get(spec.id);
  if (hit) return hit;
  const kinds = new Map<string, 'boolean' | 'number'>();
  for (const f of spec.fields) if (f.type === 'boolean' || f.type === 'number') kinds.set(f.key, f.type);
  const shape = baseZodType(spec.configSchema);
  if (shape instanceof z.ZodObject) {
    for (const [key, t] of Object.entries(shape.shape as z.ZodRawShape)) {
      const b = baseZodType(t);
      if (b instanceof z.ZodBoolean) kinds.set(key, 'boolean');
      else if (b instanceof z.ZodNumber) kinds.set(key, 'number');
    }
  }
  scalarKindsCache.set(spec.id, kinds);
  return kinds;
}

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * ThingsBoard 3.6.0–3.6.3 exported some booleans and numbers as STRINGS
 * (`"notifyDevice": "false"`, `"defaultTTL": "0"`). Read them as what they are,
 * before validation, so such a node imports as itself rather than Unsupported:
 * at the TOP level of the config only, for a key the node's fields or schema
 * hold as a boolean / number, and only an exact `"true"` / `"false"` or a plain
 * decimal. Anything else is left for the schema to refuse. Returns a copy.
 */
export function coerceThingsboardScalars(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  const spec = RULE_NODE_TYPE_BY_ID.get(type);
  if (!spec) return out;
  for (const [key, kind] of scalarKindsOf(spec)) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    if (kind === 'boolean' && (v === 'true' || v === 'false')) out[key] = v === 'true';
    else if (kind === 'number' && PLAIN_DECIMAL.test(v)) out[key] = Number(v);
  }
  return out;
}

// ─── ThingsBoard configuration upgrades (ruling CV-1, 2026-11-04) ────────────

/** Jackson's `asText()` for the values a config holds: a string as is, a boolean / number spelled out. */
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return '';
}

/**
 * One ThingsBoard `upgrade(fromVersion, oldConfiguration)`, mirrored: the
 * configuration at the node's CURRENT version, or `null` where ThingsBoard
 * throws (a key it needs is missing or holds a value it does not know) — it
 * then keeps the configuration as it was, and so do we. Called ONCE with the
 * stored version, as `TbNodeUpgradeUtils` calls it.
 */
type TbUpgrade = (fromVersion: number, config: Record<string, unknown>) => Record<string, unknown> | null;

/** `TbCheckRelationNode.upgrade`: v0 → v1 flips the direction (the meaning of FROM / TO was inverted in v1). */
const checkRelationUpgrade: TbUpgrade = (from, c) => {
  if (from !== 0) return c;
  const d = asText(c.direction);
  if (d === 'TO') return { ...c, direction: 'FROM' };
  if (d === 'FROM') return { ...c, direction: 'TO' };
  return null;
};

/**
 * `TbAbstractTransformNodeWithTbMsgSource.upgrade` (Copy / Delete / Rename
 * keys → v2): v0 `fromMetadata` "true" / "false" → `<newKey>` METADATA / DATA;
 * v1 `<v1Key>` "METADATA" / "DATA" → `<newKey>`, unless `<newKey>` is already there.
 */
const msgSourceUpgrade = (newKey: string, v1Key: string): TbUpgrade => (from, c) => {
  const move = (oldKey: string, toValue: Record<string, string>) => {
    if (!(oldKey in c)) return null;
    const text = asText(c[oldKey]);
    const value = Object.prototype.hasOwnProperty.call(toValue, text) ? toValue[text] : null;
    if (!value) return null;
    const { [oldKey]: _gone, ...rest } = c;
    return { ...rest, [newKey]: value };
  };
  if (from === 0) return move('fromMetadata', { true: 'METADATA', false: 'DATA' });
  if (from === 1) return newKey in c ? c : move(v1Key, { METADATA: 'METADATA', DATA: 'DATA' });
  return c;
};

/** Jackson's `asBoolean()`: true only for `true`, the text "true" (trimmed) or a non-zero number. */
function asBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim() === 'true';
  if (typeof v === 'number') return v !== 0;
  return false;
}

/** `TbDeviceProfileNode.upgrade`: v0 → v1 — not persisting the alarm-rule state means not fetching it on start. */
const deviceProfileUpgrade: TbUpgrade = (from, c) => {
  if (from !== 0 || !('persistAlarmRulesState' in c)) return c;
  return asBoolean(c.persistAlarmRulesState) ? c : { ...c, fetchAlarmRulesStateOnStart: false };
};

// ─── Ruling CV-3 (2026-11-05): the other meaning-changing upgrades ──────────
// Read off ThingsBoard master, commit e48b5780 (2026-11-02). Where a node's
// `upgrade()` is a `switch` without `break`, an older version runs every later
// case too — mirrored as `from <= n`.

const hasOwn = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Jackson's `TextNode.asBoolean(default)`: the TRIMMED text "true" / "false", else the default. */
function textAsBoolean(text: string, dflt: boolean): boolean {
  const t = text.trim();
  return t === 'true' ? true : t === 'false' ? false : dflt;
}

/** ThingsBoard's `OnEveryMessage` processing settings, as `JacksonUtil.valueToTree` writes them. */
const ON_EVERY_MESSAGE_SETTINGS = { type: 'ON_EVERY_MESSAGE' } as const;
/**
 * What `TbMsgTimeseriesNode.upgrade` writes for `skipLatestPersistence: "true"`:
 * `new Advanced(onEveryMessage(), skip(), onEveryMessage(), onEveryMessage())`.
 */
const SKIP_LATEST_SETTINGS = {
  type: 'ADVANCED', timeseries: { type: 'ON_EVERY_MESSAGE' }, latest: { type: 'SKIP' },
  webSockets: { type: 'ON_EVERY_MESSAGE' }, calculatedFields: { type: 'ON_EVERY_MESSAGE' },
} as const;
/** Save time series' processing settings for a toggle value — ThingsBoard's own v0 → v1 output. */
const timeseriesSettingsFor = (skipLatest: boolean): Record<string, unknown> =>
  cloneJson(skipLatest ? SKIP_LATEST_SETTINGS : ON_EVERY_MESSAGE_SETTINGS) as Record<string, unknown>;

/** `TbMsgTimeseriesNode.upgrade`: v0 → v1 moves `skipLatestPersistence` ("true" by `asText`) into `processingSettings`. */
const saveTimeseriesUpgrade: TbUpgrade = (from, c) => {
  if (from !== 0) return c;
  const { skipLatestPersistence, ...rest } = c;
  return { ...rest, processingSettings: timeseriesSettingsFor(asText(skipLatestPersistence) === 'true') };
};

/**
 * `TbMsgAttributesNode.upgrade` (→ v3; the cases fall through): v0 without
 * `updateAttributesOnlyOnValueChange` → false (v0 never compared values); v0 / v1
 * each flag absent or null → its default (`notifyDevice` TRUE — "a while ago
 * node always notified devices"), a text flag → `TextNode.asBoolean(default)`;
 * v0 / v1 / v2 → `processingSettings` On every message (REPLACING any there).
 */
const saveAttributesUpgrade: TbUpgrade = (from, c) => {
  const out = { ...c };
  if (from === 0 && !hasOwn(out, 'updateAttributesOnlyOnValueChange')) out.updateAttributesOnlyOnValueChange = false;
  if (from <= 1) {
    const fix = (key: string, valueIfNull: boolean) => {
      const v = out[key];
      if (v === undefined || v === null) out[key] = valueIfNull;
      else if (typeof v === 'string') out[key] = textAsBoolean(v, valueIfNull);
    };
    fix('notifyDevice', true);
    fix('sendAttributesUpdatedNotification', false);
    fix('updateAttributesOnlyOnValueChange', true);
  }
  if (from <= 2) out.processingSettings = cloneJson(ON_EVERY_MESSAGE_SETTINGS);
  return out;
};

/**
 * `TbAbstractNodeWithFetchTo.upgradeConfigurationToUseFetchTo`: `<oldKey>` "true" /
 * "false" (`asText`) → `fetchTo` = `ifTrue` / `ifFalse`, the old key removed; any
 * other value throws in ThingsBoard (null here).
 */
function fetchToFrom(c: Record<string, unknown>, oldKey: string, ifTrue: string, ifFalse: string): Record<string, unknown> | null {
  const v = asText(c[oldKey]);
  if (v !== 'true' && v !== 'false') return null;
  const { [oldKey]: _gone, ...rest } = c;
  return { ...rest, fetchTo: v === 'true' ? ifTrue : ifFalse };
}

/**
 * `TbGetAttributesNode` / `TbGetDeviceAttrNode.upgrade` v0 → v1, through
 * `TbAbstractGetAttributesNode`'s override: `fetchToData` absent → `fetchTo`
 * METADATA (over whatever is there), a JSON null → removed and METADATA,
 * "true" / "false" → DATA / METADATA.
 */
const attributesFetchToUpgrade: TbUpgrade = (from, c) => {
  if (from !== 0) return c;
  if (!hasOwn(c, 'fetchToData')) return { ...c, fetchTo: 'METADATA' };
  if (c.fetchToData === null) {
    const { fetchToData: _gone, ...rest } = c;
    return { ...rest, fetchTo: 'METADATA' };
  }
  return fetchToFrom(c, 'fetchToData', 'DATA', 'METADATA');
};

/** `TbGetTenantDetailsNode.upgrade` v0 → v1 (the BASE helper): `addToMetadata` required; "true" → METADATA, "false" → DATA. */
const tenantDetailsUpgrade: TbUpgrade = (from, c) => {
  if (from !== 0) return c;
  return hasOwn(c, 'addToMetadata') ? fetchToFrom(c, 'addToMetadata', 'METADATA', 'DATA') : null;
};

/** `TbGetOriginatorFieldsNode.upgrade` v0 → v1: `fieldsMapping` (required) → `dataMapping`, and `fetchTo` METADATA. */
const originatorFieldsUpgrade: TbUpgrade = (from, c) => {
  if (from !== 0) return c;
  if (!hasOwn(c, 'fieldsMapping')) return null;
  const { fieldsMapping, ...rest } = c;
  return { ...rest, dataMapping: fieldsMapping, fetchTo: 'METADATA' };
};

/**
 * `TbGetTenantAttributeNode.upgrade` v0 → v1 (`TbAbstractGetEntityDataNode`):
 * `telemetry` and `attrMapping` both required; `attrMapping` → `dataMapping`,
 * `telemetry` "true" / "false" → `dataToFetch` LATEST_TELEMETRY / ATTRIBUTES,
 * and `fetchTo` METADATA.
 */
const tenantAttributesUpgrade: TbUpgrade = (from, c) => {
  if (from !== 0) return c;
  if (!hasOwn(c, 'telemetry') || !hasOwn(c, 'attrMapping')) return null;
  const v = asText(c.telemetry);
  if (v !== 'true' && v !== 'false') return null;
  const { telemetry: _t, attrMapping, ...rest } = c;
  return { ...rest, dataMapping: attrMapping, dataToFetch: v === 'true' ? 'LATEST_TELEMETRY' : 'ATTRIBUTES', fetchTo: 'METADATA' };
};

/**
 * `TbGetTelemetryNode.upgrade` → v2 (case 0 has no `break`): v0 with a
 * `fetchMode` — FIRST → orderBy ASC / aggregation NONE, LAST → DESC / NONE,
 * ALL → a present-but-blank orderBy / aggregation gets ASC / NONE, anything else
 * → LAST / DESC / NONE; then v0 / v1 — `limit` absent → 1000, and for ALL an
 * absent aggregation / orderBy → NONE / ASC.
 */
const originatorTelemetryUpgrade: TbUpgrade = (from, c) => {
  const out = { ...c };
  const blank = (k: string) => hasOwn(out, k) && (out[k] === null || asText(out[k]) === '');
  if (from === 0 && out.fetchMode !== undefined && out.fetchMode !== null) {
    const mode = asText(out.fetchMode);
    if (mode === 'FIRST') Object.assign(out, { orderBy: 'ASC', aggregation: 'NONE' });
    else if (mode === 'LAST') Object.assign(out, { orderBy: 'DESC', aggregation: 'NONE' });
    else if (mode === 'ALL') {
      if (blank('orderBy')) out.orderBy = 'ASC';
      if (blank('aggregation')) out.aggregation = 'NONE';
    } else Object.assign(out, { fetchMode: 'LAST', orderBy: 'DESC', aggregation: 'NONE' });
  }
  if (from <= 1) {
    if (out.limit === undefined || out.limit === null) out.limit = 1000;
    if (hasOwn(out, 'fetchMode') && asText(out.fetchMode) === 'ALL') {
      if (out.aggregation === undefined || out.aggregation === null) out.aggregation = 'NONE';
      if (out.orderBy === undefined || out.orderBy === null) out.orderBy = 'ASC';
    }
  }
  return out;
};

/** `CalculateDeltaNode.upgrade` v0 → v1 (additive): `excludeZeroDeltas` absent → false. */
const calculateDeltaUpgrade: TbUpgrade = (from, c) =>
  (from === 0 && !hasOwn(c, 'excludeZeroDeltas') ? { ...c, excludeZeroDeltas: false } : c);

/**
 * The upgrades mirrored here. Every OTHER built node with a configuration
 * version above 0 has a ThingsBoard upgrade that is NOT mirrored (all additive:
 * change originator, deduplication, generator, MQTT, REST API call, checkpoint,
 * rule chain); an import of an older version of it is flagged for review (see
 * `fromThingsboardExport`).
 */
const TB_UPGRADES: Readonly<Record<string, TbUpgrade>> = {
  'tb:filter:check-relation-presence': checkRelationUpgrade,
  'tb:enrichment:calculate-delta': calculateDeltaUpgrade,
  'tb:enrichment:originator-attributes': attributesFetchToUpgrade,
  'tb:enrichment:originator-fields': originatorFieldsUpgrade,
  'tb:enrichment:originator-telemetry': originatorTelemetryUpgrade,
  'tb:enrichment:related-device-attributes': attributesFetchToUpgrade,
  'tb:enrichment:tenant-attributes': tenantAttributesUpgrade,
  'tb:enrichment:tenant-details': tenantDetailsUpgrade,
  'tb:transformation:copy-key-value-pairs': msgSourceUpgrade('copyFrom', 'fromMetadata'),
  'tb:transformation:delete-key-value-pairs': msgSourceUpgrade('deleteFrom', 'dataToFetch'),
  'tb:transformation:rename-keys': msgSourceUpgrade('renameIn', 'fromMetadata'),
  'tb:action:device-profile': deviceProfileUpgrade,
  'tb:action:save-attributes': saveAttributesUpgrade,
  'tb:action:save-timeseries': saveTimeseriesUpgrade,
};

export interface ThingsboardConfigUpgrade {
  /** A copy of the configuration — upgraded when `outcome` is `upgraded`, else as given. */
  config: Record<string, unknown>;
  /**
   * `current` — nothing to do (the version is the one modelled, or newer; or the node models nothing);
   * `upgraded` — ThingsBoard's upgrade applied; `not-upgraded` — the version is older than the one
   * modelled and no upgrade applies (none mirrored, or ThingsBoard's own would have thrown).
   */
  outcome: 'current' | 'upgraded' | 'not-upgraded';
}

/**
 * Brings a ThingsBoard node configuration exported at `fromVersion` (absent in
 * the export = 0, as ThingsBoard reads it) up to the version this catalogue
 * models, with ThingsBoard's own upgrade. Never touches its input.
 */
export function upgradeThingsboardConfig(type: string, fromVersion: number, config: Record<string, unknown>): ThingsboardConfigUpgrade {
  const copy = cloneJson(config);
  const spec = RULE_NODE_TYPE_BY_ID.get(type);
  if (!spec || spec.tbConfigurationVersion === null || fromVersion >= spec.tbConfigurationVersion) return { config: copy, outcome: 'current' };
  const upgrade = TB_UPGRADES[type];
  const upgraded = upgrade ? upgrade(fromVersion, copy) : null;
  return upgraded ? { config: upgraded, outcome: 'upgraded' } : { config: copy, outcome: 'not-upgraded' };
}

// ─── Ruling CV-3: ONE source of truth per node, ThingsBoard's form at the boundary ─
//
// Save time series: the toggle `skipLatestPersistence` is what the handler honours.
// ThingsBoard 4.x has no such key — its `processingSettings` decides, per action
// (time series, latest, WebSockets, calculated fields), On every message / Skip /
// Deduplicate. ONE predicate (`timeseriesSettingsJudge`) reads a setting both ways:
// an import derives the toggle from it, an export keeps it verbatim unless it
// contradicts the toggle. Only the actions that exist here are judged — time series
// and latest (Save time series), attributes (Save attributes); this system has no
// WebSocket subscriptions and no calculated fields, so their strategies are kept for
// the export and never judged or warned about.

/** A strategy's name for a note: "Skip", "Deduplicate every 60 s", … */
function strategyText(s: unknown): string {
  const type = isPlainObject(s) ? s.type : undefined;
  if (type === 'ON_EVERY_MESSAGE') return 'On every message';
  if (type === 'SKIP') return 'Skip';
  if (type === 'DEDUPLICATE') {
    const secs = isPlainObject(s) ? s.deduplicationIntervalSecs : undefined;
    return typeof secs === 'number' ? `Deduplicate every ${secs} s` : 'Deduplicate';
  }
  return type === undefined ? 'no strategy' : `type ${JSON.stringify(type)}`;
}

const strategyType = (s: unknown): unknown => (isPlainObject(s) ? s.type : undefined);

/**
 * What a Save time series `processingSettings` means HERE: whether the latest
 * readings are skipped (null = cannot tell), and the parts not built here. The
 * handler saves every reading to history and updates the latest table unless the
 * toggle says not: time series must be On every message, latest On every message
 * or Skip. Basic WebSockets only skips every save in ThingsBoard — latest included.
 */
function timeseriesSettingsJudge(ps: Record<string, unknown>): { skipLatest: boolean | null; notBuilt: string[] } {
  switch (ps.type) {
    case 'ON_EVERY_MESSAGE': return { skipLatest: false, notBuilt: [] };
    case 'WEBSOCKETS_ONLY': return { skipLatest: true, notBuilt: ['WebSockets only'] };
    case 'DEDUPLICATE': return { skipLatest: false, notBuilt: [strategyText(ps)] };
    case 'ADVANCED': {
      const notBuilt: string[] = [];
      if (strategyType(ps.timeseries) !== 'ON_EVERY_MESSAGE') notBuilt.push(`time series: ${strategyText(ps.timeseries)}`);
      const latest = strategyType(ps.latest);
      if (latest !== 'ON_EVERY_MESSAGE' && latest !== 'SKIP') notBuilt.push(`latest: ${strategyText(ps.latest)}`);
      const skipLatest = latest === 'SKIP' ? true : latest === 'ON_EVERY_MESSAGE' || latest === 'DEDUPLICATE' ? false : null;
      return { skipLatest, notBuilt };
    }
    default: return { skipLatest: null, notBuilt: [`type ${JSON.stringify(ps.type ?? null)}`] };
  }
}

/** What a Save attributes `processingSettings` means here: the parts not built (the handler saves every message's attributes). */
function attributesSettingsNotBuilt(ps: Record<string, unknown>): string[] {
  switch (ps.type) {
    case 'ON_EVERY_MESSAGE': return [];
    case 'WEBSOCKETS_ONLY': return ['WebSockets only'];
    case 'DEDUPLICATE': return [strategyText(ps)];
    case 'ADVANCED': return strategyType(ps.attributes) === 'ON_EVERY_MESSAGE' ? [] : [`attributes: ${strategyText(ps.attributes)}`];
    default: return [`type ${JSON.stringify(ps.type ?? null)}`];
  }
}

const notBuiltNote = (notBuilt: string[], consequence: string): string | null =>
  (notBuilt.length === 0 ? null : `processing settings not built here (${notBuilt.join('; ')}) — ${consequence}.`);

export interface ThingsboardConfigImport {
  /** The configuration in the shape this system stores — a copy. */
  config: Record<string, unknown>;
  /**
   * What of ThingsBoard's configuration is not honoured here, as the tail of a
   * warning ("processing settings not built here (…) — …"); null when all is.
   */
  notHonoured: string | null;
}

/**
 * ThingsBoard's exchange form → the shape stored here (ruling CV-3). Runs on an
 * import AFTER `upgradeThingsboardConfig`, so `config` is at the modelled version.
 *  - Save time series: a `processingSettings` object SETS the toggle
 *    `skipLatestPersistence` (written as a boolean) and is kept as it came; a
 *    strategy not built here is named in `notHonoured` (the toggle still follows
 *    the latest strategy; an unknown setting leaves the toggle as given). With no
 *    `processingSettings`, the toggle is read as ThingsBoard's v0 reads it
 *    (`asText` "true") and ThingsBoard's own v0 → v1 form is stored beside it.
 *  - Save attributes: a strategy not built here is named; no `processingSettings`
 *    → ThingsBoard's default (On every message).
 *  - Every other node: a copy, unchanged.
 */
export function fromThingsboardConfig(type: string, config: Record<string, unknown>): ThingsboardConfigImport {
  const c = cloneJson(config);
  if (type === 'tb:action:save-timeseries') {
    const givenToggle = asText(c.skipLatestPersistence) === 'true';
    if (!isPlainObject(c.processingSettings)) {
      return { config: { ...c, skipLatestPersistence: givenToggle, processingSettings: timeseriesSettingsFor(givenToggle) }, notHonoured: null };
    }
    const judged = timeseriesSettingsJudge(c.processingSettings);
    const skipLatest = judged.skipLatest ?? givenToggle;
    const consequence = `it saves every reading and ${skipLatest ? 'does not update' : 'updates'} the latest readings`;
    return { config: { ...c, skipLatestPersistence: skipLatest }, notHonoured: notBuiltNote(judged.notBuilt, consequence) };
  }
  if (type === 'tb:action:save-attributes') {
    if (!isPlainObject(c.processingSettings)) return { config: { ...c, processingSettings: cloneJson(ON_EVERY_MESSAGE_SETTINGS) }, notHonoured: null };
    return { config: c, notHonoured: notBuiltNote(attributesSettingsNotBuilt(c.processingSettings), 'it saves the attributes of every message') };
  }
  return { config: c, notHonoured: null };
}

/**
 * The shape stored here → ThingsBoard's exchange form, at the modelled version
 * (ruling CV-3). A copy; the stored configuration is never touched.
 *  - Save time series: NO `skipLatestPersistence` (ThingsBoard's v1 class has no
 *    such field, and its Jackson refuses an unknown one — the node would not
 *    start); `processingSettings` kept verbatim when it agrees with the toggle,
 *    else — contradicting, absent or unreadable — exactly what ThingsBoard's own
 *    v0 → v1 upgrade writes for the toggle's value.
 *  - Save attributes: `processingSettings` kept; none → On every message
 *    (ThingsBoard's `@NotNull` refuses a chain without one).
 *  - Every other node: a copy, unchanged.
 */
export function toThingsboardConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const c = cloneJson(config);
  if (type === 'tb:action:save-timeseries') {
    const { skipLatestPersistence, ...rest } = c;
    const toggle = skipLatestPersistence === true;
    const stored = isPlainObject(rest.processingSettings) ? timeseriesSettingsJudge(rest.processingSettings).skipLatest : null;
    return stored === toggle ? rest : { ...rest, processingSettings: timeseriesSettingsFor(toggle) };
  }
  if (type === 'tb:action:save-attributes') {
    return isPlainObject(c.processingSettings) ? c : { ...c, processingSettings: cloneJson(ON_EVERY_MESSAGE_SETTINGS) };
  }
  return c;
}
