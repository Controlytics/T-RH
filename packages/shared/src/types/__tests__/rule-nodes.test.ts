import { describe, it, expect } from 'vitest';
import {
  RULE_NODE_TYPES, RULE_NODE_TYPE_BY_ID, RULE_NODE_TYPE_BY_TB_CLASS, BUILT_RULE_NODE_TYPES, UNSUPPORTED_NODE_TYPE,
  RULE_NODE_GROUPS, RULE_MESSAGE_TYPES, MESSAGE_TYPE_SWITCH_LABELS, messageTypeSwitchLabel,
  RULE_RELATION_SUCCESS, RULE_RELATION_FAILURE, RULE_RELATION_TRUE, RULE_RELATION_FALSE, RULE_RELATION_OTHER,
  RULE_ORIGINATOR_TYPES, RULE_ORIGINATOR_TYPE_LABELS, TB_ENTITY_TYPE_ALIASES, RULE_DEBUG_MODES,
  RULE_NODE_NAME_MAX, RULE_CHAIN_NAME_MAX, RULE_CHAIN_NODES_MAX, RULE_MATH_OPERATIONS, toRuleNodeTypeDescriptor,
  visibleRuleNodeFields, coerceThingsboardScalars, upgradeThingsboardConfig, fromThingsboardConfig, toThingsboardConfig,
  RULE_SCRIPT_KEYS, ruleNodeScriptKey, ruleNodeScript,
  RULE_ORIGINATOR_TB_ENTITY_TYPES, TB_ENTITY_TYPE_SWITCH_LABELS, toRuleOriginatorType, canonicalRuleNodeConfig,
  entityTypeSwitchLabelFromThingsboard, entityTypeSwitchLabelToThingsboard,
} from '../rule-nodes.js';

/**
 * The rule-node catalogue (rule chains, 2026-11-03). Spec:
 * docs/superpowers/specs/2026-11-03-rule-chains-design.md §7.
 *
 * ThingsBoard documents 86 rule nodes — 12 filter, 11 enrichment, 12
 * transformation, 31 action, 16 external, 4 flow — read off the six group
 * pages of thingsboard.io/docs/user-guide/rule-engine-2-0 and the @RuleNode
 * annotations in thingsboard/thingsboard master on 2026-11-03. The spec's "87 /
 * 13 filter" counted its own alias note ("Originator type filter/switch" — the
 * same two classes as Entity type filter/switch) as a node. Ruling T1-1.
 *
 * Built = every node Tasks 4-6 write a handler for (46); three of them are
 * marked L in the spec's table but built in a narrowed form (check relation
 * presence and related device attributes on the gateway link, tenant
 * attributes as "Application attributes"), which is why the spec's L count
 * (12) and B count (46) overlap by two. Ruling T1-2.
 *
 * 2026-11-04 (ruling, found by Task 6): Device profile (deprecated) is BUILT
 * as a pass-through — every ThingsBoard release v3.6–v4.2 ships its root chain
 * with it as the ENTRY, so an imported root chain was dead here. 46 → 47
 * built, 30 → 29 none.
 */

const BUILT_IDS = [
  // filter (10)
  'tb:filter:alarm-status-filter', 'tb:filter:check-fields-presence', 'tb:filter:check-relation-presence',
  'tb:filter:device-profile-switch', 'tb:filter:entity-type-filter', 'tb:filter:entity-type-switch',
  'tb:filter:message-type-filter', 'tb:filter:message-type-switch', 'tb:filter:script', 'tb:filter:switch',
  // enrichment (7)
  'tb:enrichment:calculate-delta', 'tb:enrichment:originator-attributes', 'tb:enrichment:originator-fields',
  'tb:enrichment:originator-telemetry', 'tb:enrichment:related-device-attributes', 'tb:enrichment:tenant-attributes',
  'tb:enrichment:tenant-details',
  // transformation (9)
  'tb:transformation:change-originator', 'tb:transformation:copy-key-value-pairs', 'tb:transformation:deduplication',
  'tb:transformation:delete-key-value-pairs', 'tb:transformation:json-path', 'tb:transformation:rename-keys',
  'tb:transformation:script', 'tb:transformation:split-array-msg', 'tb:transformation:to-email',
  // action (11) — device-profile is a pass-through (2026-11-04)
  'tb:action:clear-alarm', 'tb:action:create-alarm', 'tb:action:delay', 'tb:action:delete-attributes', 'tb:action:device-profile',
  'tb:action:generator', 'tb:action:log', 'tb:action:math-function', 'tb:action:message-count',
  'tb:action:save-attributes', 'tb:action:save-timeseries',
  // external (6)
  'tb:external:mqtt', 'tb:external:rest-api-call', 'tb:external:send-email', 'tb:external:send-notification',
  'tb:external:send-sms', 'tb:external:send-to-slack',
  // flow (4)
  'tb:flow:acknowledge', 'tb:flow:checkpoint', 'tb:flow:rule-chain', 'tb:flow:output',
];

const LATER_IDS = [
  'tb:filter:gps-geofencing-filter', 'tb:enrichment:related-entity-data',
  'tb:action:create-relation', 'tb:action:delete-relation', 'tb:action:device-state', 'tb:action:gps-geofencing-events',
  'tb:action:rest-call-reply', 'tb:action:rpc-call-reply', 'tb:action:rpc-call-request',
  'tb:external:ai-request',
];

const countBy = <T,>(xs: readonly T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((acc, x) => { acc[key(x)] = (acc[key(x)] ?? 0) + 1; return acc; }, {});

describe('RULE_NODE_TYPES — the whole ThingsBoard catalogue', () => {
  it('holds all 86 ThingsBoard nodes, by group as thingsboard.io lists them', () => {
    expect(RULE_NODE_TYPES).toHaveLength(86);
    expect(countBy(RULE_NODE_TYPES, (s) => s.group)).toEqual({
      filter: 12, enrichment: 11, transformation: 12, action: 31, external: 16, flow: 4,
    });
  });

  it('marks 47 built, 10 later and 29 with no counterpart here', () => {
    expect(countBy(RULE_NODE_TYPES, (s) => s.status)).toEqual({ built: 47, later: 10, none: 29 });
  });

  it('built is EXACTLY the 47 nodes Tasks 4-6 write handlers for', () => {
    expect(BUILT_RULE_NODE_TYPES.map((s) => s.id).sort()).toEqual([...BUILT_IDS].sort());
    expect(BUILT_IDS).toHaveLength(47);
    expect(BUILT_RULE_NODE_TYPES.every((s) => s.status === 'built')).toBe(true);
  });

  it('later is EXACTLY the 10 nodes waiting on a feature this system does not have yet', () => {
    expect(RULE_NODE_TYPES.filter((s) => s.status === 'later').map((s) => s.id).sort()).toEqual([...LATER_IDS].sort());
  });

  it('every id is unique and reads tb:<group>:<kebab-name> with its own group', () => {
    const ids = RULE_NODE_TYPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of RULE_NODE_TYPES) {
      expect(s.id, s.id).toMatch(/^tb:(filter|enrichment|transformation|action|external|flow):[a-z0-9-]+$/);
      expect(s.id.split(':')[1], s.id).toBe(s.group);
    }
  });

  it('every tbClass is unique and a ThingsBoard rule-engine class', () => {
    const classes = RULE_NODE_TYPES.map((s) => s.tbClass);
    expect(new Set(classes).size).toBe(classes.length);
    for (const c of classes) expect(c).toMatch(/^org\.thingsboard\.rule\.engine\.[a-z.]+\.[A-Z][A-Za-z0-9]*Node(V2)?$/);
  });

  it('carries the class names the ThingsBoard source declares, not the ones the brief guessed', () => {
    const cls = (id: string) => RULE_NODE_TYPE_BY_ID.get(id)?.tbClass;
    expect(cls('tb:filter:message-type-switch')).toBe('org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode');
    expect(cls('tb:filter:gps-geofencing-filter')).toBe('org.thingsboard.rule.engine.geo.TbGpsGeofencingFilterNode');
    expect(cls('tb:enrichment:related-device-attributes')).toBe('org.thingsboard.rule.engine.metadata.TbGetDeviceAttrNode');
    expect(cls('tb:enrichment:related-entity-data')).toBe('org.thingsboard.rule.engine.metadata.TbGetRelatedAttributeNode');
    expect(cls('tb:transformation:deduplication')).toBe('org.thingsboard.rule.engine.deduplication.TbMsgDeduplicationNode');
    expect(cls('tb:transformation:to-email')).toBe('org.thingsboard.rule.engine.mail.TbMsgToEmailNode');
    expect(cls('tb:action:save-timeseries')).toBe('org.thingsboard.rule.engine.telemetry.TbMsgTimeseriesNode');
    expect(cls('tb:action:generator')).toBe('org.thingsboard.rule.engine.debug.TbMsgGeneratorNode');
    expect(cls('tb:action:delay')).toBe('org.thingsboard.rule.engine.delay.TbMsgDelayNode');
    expect(cls('tb:action:generate-report')).toBe('org.thingsboard.rule.engine.report.TbGenerateReportV2Node');
    expect(cls('tb:action:generate-dashboard-report')).toBe('org.thingsboard.rule.engine.report.TbGenerateReportNode');
    expect(cls('tb:action:assign-to-customer')).toBe('org.thingsboard.rule.engine.action.TbAssignToCustomerNode');
    expect(cls('tb:external:azure-iot-hub')).toBe('org.thingsboard.rule.engine.mqtt.azure.TbAzureIotHubNode');
    expect(cls('tb:external:twilio-sms')).toBe('org.thingsboard.rule.engine.pe.twilio.TbTwilioSmsNode');
    expect(cls('tb:external:twilio-voice')).toBe('org.thingsboard.rule.engine.pe.twilio.voice.TbTwilioVoiceNode');
    expect(cls('tb:flow:rule-chain')).toBe('org.thingsboard.rule.engine.flow.TbRuleChainInputNode');
    expect(cls('tb:flow:output')).toBe('org.thingsboard.rule.engine.flow.TbRuleChainOutputNode');
  });

  it('the two lookups find every entry and round-trip id <-> ThingsBoard class', () => {
    expect(RULE_NODE_TYPE_BY_ID.size).toBe(86);
    expect(RULE_NODE_TYPE_BY_TB_CLASS.size).toBe(86);
    for (const s of RULE_NODE_TYPES) {
      expect(RULE_NODE_TYPE_BY_ID.get(s.id)).toBe(s);
      expect(RULE_NODE_TYPE_BY_TB_CLASS.get(s.tbClass)).toBe(s);
    }
  });

  it('keeps ThingsBoard labels, and every entry has a description', () => {
    const label = (id: string) => RULE_NODE_TYPE_BY_ID.get(id)?.label;
    expect(label('tb:filter:check-fields-presence')).toBe('Check fields presence');
    expect(label('tb:transformation:copy-key-value-pairs')).toBe('Copy key-value pairs');
    expect(label('tb:action:save-timeseries')).toBe('Save time series');
    expect(label('tb:external:send-to-slack')).toBe('Send to Slack');
    expect(label('tb:flow:rule-chain')).toBe('Rule chain');
    for (const s of RULE_NODE_TYPES) expect(s.description.length, s.id).toBeGreaterThan(10);
  });

  it('UNSUPPORTED_NODE_TYPE is not a catalogue entry', () => {
    expect(UNSUPPORTED_NODE_TYPE).toBe('tb:unsupported');
    expect(RULE_NODE_TYPE_BY_ID.has(UNSUPPORTED_NODE_TYPE)).toBe(false);
  });

  it('groups are listed in ThingsBoard palette order and cover every entry', () => {
    expect(RULE_NODE_GROUPS.map((g) => g.id)).toEqual(['filter', 'enrichment', 'transformation', 'action', 'external', 'flow']);
    expect(RULE_NODE_GROUPS.map((g) => g.label)).toEqual(['Filter', 'Enrichment', 'Transformation', 'Action', 'External', 'Flow']);
  });
});

describe('built nodes — descriptors, defaults and config schemas', () => {
  it.each(BUILT_IDS)('%s: every field is labelled, a key is never shown twice at once, and its schema ACCEPTS the default config', (id) => {
    const s = RULE_NODE_TYPE_BY_ID.get(id)!;
    const keys = s.fields.map((f) => f.key);
    // Two fields may share a key only when they are never shown together — the
    // same `showWhen` key with different values (Create alarm's `severity`: a
    // select, or a template while `dynamicSeverity` is on, as in ThingsBoard).
    for (const key of new Set(keys)) {
      const same = s.fields.filter((f) => f.key === key);
      if (same.length === 1) continue;
      expect(same.length, `${id}.${key}`).toBe(2);
      const [a, b] = same;
      expect(Boolean(a.showWhen && b.showWhen && a.showWhen.key === b.showWhen.key && a.showWhen.equals !== b.showWhen.equals),
        `${id}.${key} is offered twice and could be shown twice`).toBe(true);
    }
    for (const f of s.fields) {
      expect(f.label.length, `${id}.${f.key} label`).toBeGreaterThan(0);
      if (f.type === 'select' || f.type === 'multiselect') expect(f.options?.length, `${id}.${f.key} options`).toBeGreaterThan(0);
      if (f.type === 'script') expect(f.scriptKind, `${id}.${f.key} scriptKind`).toBeTruthy();
      if (f.showWhen) expect(keys, `${id}.${f.key} showWhen`).toContain(f.showWhen.key);
    }
    const r = s.configSchema.safeParse(s.defaultConfig);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it('a select field\'s default is one of its options, a multiselect\'s every default too', () => {
    for (const s of BUILT_RULE_NODE_TYPES) {
      for (const f of s.fields) {
        if (f.type !== 'select' && f.type !== 'multiselect') continue;
        const allowed = new Set(f.options!.map((o) => o.value));
        const v = s.defaultConfig[f.key];
        if (v === undefined) continue;
        const values = Array.isArray(v) ? v : [v];
        for (const x of values) expect(allowed.has(x as string), `${s.id}.${f.key} = ${String(x)}`).toBe(true);
      }
    }
  });

  it('every built node can fail (ThingsBoard adds Failure to every node) — except Output, which has no outputs', () => {
    for (const s of BUILT_RULE_NODE_TYPES) {
      if (s.id === 'tb:flow:output') { expect(s.relations).toEqual([]); continue; }
      if (s.relations === 'dynamic') continue;
      expect(s.relations, s.id).toContain(RULE_RELATION_FAILURE);
    }
  });

  it('relations are ThingsBoard\'s: filters True/False, alarm nodes Created/Updated/Cleared, switches dynamic', () => {
    const rel = (id: string) => RULE_NODE_TYPE_BY_ID.get(id)!.relations;
    expect(rel('tb:filter:script')).toEqual(['True', 'False', 'Failure']);
    expect(rel('tb:filter:switch')).toBe('dynamic');
    expect(rel('tb:filter:device-profile-switch')).toBe('dynamic');
    expect(rel('tb:flow:rule-chain')).toBe('dynamic');
    expect(rel('tb:action:create-alarm')).toEqual(['Created', 'Updated', 'False', 'Failure']);
    expect(rel('tb:action:clear-alarm')).toEqual(['Cleared', 'False', 'Failure']);
    expect(rel('tb:enrichment:calculate-delta')).toEqual(['Success', 'Failure', 'Other']);
    expect(rel('tb:action:save-timeseries')).toEqual(['Success', 'Failure']);
  });

  it('the message type switch offers every ThingsBoard label, Other and Failure', () => {
    const rel = RULE_NODE_TYPE_BY_ID.get('tb:filter:message-type-switch')!.relations as readonly string[];
    for (const label of new Set(Object.values(MESSAGE_TYPE_SWITCH_LABELS))) expect(rel).toContain(label);
    expect(rel).toContain('Other');
    expect(rel).toContain('Failure');
    expect(new Set(rel).size).toBe(rel.length);
  });

  it('the entity type switch offers one relation per originator type', () => {
    const rel = RULE_NODE_TYPE_BY_ID.get('tb:filter:entity-type-switch')!.relations as readonly string[];
    for (const t of RULE_ORIGINATOR_TYPES) expect(rel).toContain(RULE_ORIGINATOR_TYPE_LABELS[t]);
    expect(rel).toContain('Failure');
  });

  it('configuration field names are ThingsBoard\'s (a real export imports as-is)', () => {
    const keys = (id: string) => RULE_NODE_TYPE_BY_ID.get(id)!.fields.map((f) => f.key);
    expect(keys('tb:filter:check-fields-presence')).toEqual(['messageNames', 'metadataNames', 'checkAllKeys']);
    expect(keys('tb:action:save-attributes')).toEqual(expect.arrayContaining(['scope', 'notifyDevice', 'updateAttributesOnlyOnValueChange']));
    expect(keys('tb:external:rest-api-call')).toEqual(expect.arrayContaining(['restEndpointUrlPattern', 'requestMethod', 'headers', 'readTimeoutMs']));
    expect(keys('tb:transformation:to-email')).toEqual(expect.arrayContaining(['fromTemplate', 'toTemplate', 'subjectTemplate', 'bodyTemplate', 'mailBodyType']));
    expect(keys('tb:action:create-alarm')).toEqual(expect.arrayContaining(['alarmType', 'severity', 'alarmDetailsBuildJs']));
  });

  it('a schema keeps ThingsBoard keys it does not model (scriptLang, tbelScript, processingSettings …)', () => {
    const s = RULE_NODE_TYPE_BY_ID.get('tb:action:log')!;
    const tb = { scriptLang: 'TBEL', jsScript: 'return "x";', tbelScript: 'return "x";', configurationVersion: 0 };
    expect(s.configSchema.parse(tb)).toEqual(tb);
  });

  it('a schema refuses a config of the wrong shape', () => {
    const filter = RULE_NODE_TYPE_BY_ID.get('tb:filter:message-type-filter')!;
    expect(filter.configSchema.safeParse({ messageTypes: 'POST_TELEMETRY_REQUEST' }).success).toBe(false);
    expect(filter.configSchema.safeParse({ messageTypes: [] }).success).toBe(false);
    const script = RULE_NODE_TYPE_BY_ID.get('tb:filter:script')!;
    expect(script.configSchema.safeParse({ jsScript: '' }).success).toBe(false);
    const alarm = RULE_NODE_TYPE_BY_ID.get('tb:action:create-alarm')!;
    expect(alarm.configSchema.safeParse({ ...alarm.defaultConfig, severity: 'LOUD' }).success).toBe(false);
    // ThingsBoard's WARNING / INDETERMINATE are accepted (the handler reads them as MINOR) …
    expect(alarm.configSchema.safeParse({ ...alarm.defaultConfig, severity: 'WARNING' }).success).toBe(true);
    // … and a dynamic severity is a template, not an enum value.
    expect(alarm.configSchema.safeParse({ ...alarm.defaultConfig, dynamicSeverity: true, severity: '${severity}' }).success).toBe(true);
    const math = RULE_NODE_TYPE_BY_ID.get('tb:action:math-function')!;
    expect(math.configSchema.safeParse({ ...math.defaultConfig, operation: 'ADD', arguments: [{ name: 'x', type: 'CONSTANT', key: '1' }] }).success).toBe(false);
  });

  it('Create alarm: severity is a select, and a TEMPLATE while dynamicSeverity is on — so ${severity} can be authored', () => {
    const spec = RULE_NODE_TYPE_BY_ID.get('tb:action:create-alarm')!;
    const shown = (config: Record<string, unknown>) =>
      visibleRuleNodeFields('tb:action:create-alarm', config).filter((f) => f.key === 'severity');
    // Fixed severity (the default): exactly one severity field, the select.
    expect(shown(spec.defaultConfig).map((f) => f.type)).toEqual(['select']);
    // Dynamic severity: exactly one severity field, a template the author can type ${severity} into.
    const dynamic = { ...spec.defaultConfig, dynamicSeverity: true, severity: '${severity}' };
    expect(shown(dynamic).map((f) => f.type)).toEqual(['template']);
    expect(spec.configSchema.safeParse(dynamic).success).toBe(true);
    // A ThingsBoard config without the flag reads it from the default (off): the select.
    const { dynamicSeverity: _off, ...noFlag } = spec.defaultConfig;
    expect(shown(noFlag).map((f) => f.type)).toEqual(['select']);
  });

  it('visibleRuleNodeFields judges showWhen against the config WITH its defaults', () => {
    const tele = (config: Record<string, unknown>) =>
      visibleRuleNodeFields('tb:enrichment:originator-telemetry', config).map((f) => f.key);
    expect(tele({})).toContain('startInterval');            // useMetadataIntervalPatterns defaults to false
    expect(tele({})).not.toContain('startIntervalPattern');
    expect(tele({ useMetadataIntervalPatterns: true })).toContain('startIntervalPattern');
    expect(tele({ fetchMode: 'ALL' })).toContain('aggregation');
    expect(visibleRuleNodeFields('tb:filter:nope', {})).toEqual([]);
  });

  it('Device profile (deprecated) is a BUILT pass-through: Success / Failure, no fields, ThingsBoard\'s config accepted', () => {
    const s = RULE_NODE_TYPE_BY_ID.get('tb:action:device-profile')!;
    expect(s.tbClass).toBe('org.thingsboard.rule.engine.profile.TbDeviceProfileNode');
    expect(s.status).toBe('built');
    expect(s.relations).toEqual(['Success', 'Failure']);
    expect(s.fields).toEqual([]);
    expect(s.defaultConfig).toEqual({ persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: false });
    expect(s.description).toContain('instrument-limit alarms');
    expect(s.configSchema.safeParse({ persistAlarmRulesState: true, fetchAlarmRulesStateOnStart: true }).success).toBe(true);
    expect(s.configSchema.safeParse({}).success).toBe(true);
    expect(s.configSchema.safeParse({ persistAlarmRulesState: 'yes' }).success).toBe(false);
  });

  it('coerceThingsboardScalars: every boolean / number FIELD reads ThingsBoard 3.6.0–3.6.3\'s string form', () => {
    let booleans = 0;
    let numbers = 0;
    for (const s of BUILT_RULE_NODE_TYPES) {
      for (const f of s.fields) {
        if (f.type === 'boolean') {
          booleans++;
          expect(coerceThingsboardScalars(s.id, { [f.key]: 'true' })[f.key], `${s.id}.${f.key}`).toBe(true);
          expect(coerceThingsboardScalars(s.id, { [f.key]: 'false' })[f.key], `${s.id}.${f.key}`).toBe(false);
        }
        if (f.type === 'number') {
          numbers++;
          expect(coerceThingsboardScalars(s.id, { [f.key]: '12' })[f.key], `${s.id}.${f.key}`).toBe(12);
        }
      }
    }
    expect(booleans).toBeGreaterThan(30);
    expect(numbers).toBeGreaterThan(15);
  });

  it('coerceThingsboardScalars: only a recognisable scalar, only where the schema wants one, never in place', () => {
    const save = 'tb:action:save-attributes';
    const input = { notifyDevice: 'false', scope: 'SERVER_SCOPE', updateAttributesOnlyOnValueChange: 'TRUE ', extra: 'false' };
    const out = coerceThingsboardScalars(save, input);
    expect(out).toEqual({ notifyDevice: false, scope: 'SERVER_SCOPE', updateAttributesOnlyOnValueChange: 'TRUE ', extra: 'false' });
    expect(input.notifyDevice).toBe('false');                                   // the input is not touched
    // A boolean the schema models without a form field (create alarm's propagateToOwner) is read too.
    expect(coerceThingsboardScalars('tb:action:create-alarm', { propagateToOwner: 'false' }).propagateToOwner).toBe(false);
    // A number: only a plain decimal string; anything else is left for the schema to refuse.
    const ts = 'tb:action:save-timeseries';
    expect(coerceThingsboardScalars(ts, { defaultTTL: '0' }).defaultTTL).toBe(0);
    expect(coerceThingsboardScalars(ts, { defaultTTL: '-1.5' }).defaultTTL).toBe(-1.5);
    for (const raw of ['', ' ', 'abc', '1e3', '0x10', '12px']) expect(coerceThingsboardScalars(ts, { defaultTTL: raw }).defaultTTL, raw).toBe(raw);
    // Nested values are not touched; an unknown type comes back as a copy.
    const math = coerceThingsboardScalars('tb:action:math-function', { result: { resultValuePrecision: '2' } });
    expect(math.result).toEqual({ resultValuePrecision: '2' });
    const unknown = { a: 'true' };
    expect(coerceThingsboardScalars('tb:action:nope', unknown)).toEqual({ a: 'true' });
    expect(coerceThingsboardScalars('tb:action:nope', unknown)).not.toBe(unknown);
  });

  it('tbConfigurationVersion: each built node records the ThingsBoard configuration version it models; later / none model none', () => {
    // ThingsBoard master's @RuleNode(version = …), 2026-11-04; every built node not listed is 0.
    const modelled: Record<string, number> = {
      'tb:filter:check-relation-presence': 1,
      'tb:enrichment:calculate-delta': 1, 'tb:enrichment:originator-attributes': 1, 'tb:enrichment:originator-fields': 1,
      'tb:enrichment:originator-telemetry': 2, 'tb:enrichment:related-device-attributes': 1,
      'tb:enrichment:tenant-attributes': 1, 'tb:enrichment:tenant-details': 1,
      'tb:transformation:change-originator': 1, 'tb:transformation:copy-key-value-pairs': 2, 'tb:transformation:deduplication': 1,
      'tb:transformation:delete-key-value-pairs': 2, 'tb:transformation:rename-keys': 2,
      'tb:action:device-profile': 1, 'tb:action:generator': 2, 'tb:action:save-attributes': 3, 'tb:action:save-timeseries': 1,
      'tb:external:mqtt': 2, 'tb:external:rest-api-call': 4,
      'tb:flow:checkpoint': 1, 'tb:flow:rule-chain': 1,
    };
    for (const s of RULE_NODE_TYPES) {
      if (s.status === 'built') expect(s.tbConfigurationVersion, s.id).toBe(modelled[s.id] ?? 0);
      else expect(s.tbConfigurationVersion, s.id).toBeNull();
    }
  });

  it('Save attributes\' two toggles SAY what they do here (TB-P 7 — no silent dead toggle); Save time series names its ThingsBoard form', () => {
    const help = (type: string, key: string) => RULE_NODE_TYPE_BY_ID.get(type)!.fields.find((f) => f.key === key)?.help ?? '';
    const onlyOnChange = help('tb:action:save-attributes', 'updateAttributesOnlyOnValueChange');
    expect(onlyOnChange).toMatch(/never written or audited again/);
    expect(onlyOnChange).toMatch(/Off: the Attributes Updated message lists every key of the message/);
    const notify = help('tb:action:save-attributes', 'sendAttributesUpdatedNotification');
    expect(notify).toMatch(/only when a value changed/);
    expect(notify).toMatch(/never for the client scope/);
    expect(notify).toMatch(/Re-enter on rule-node writes/);
    expect(help('tb:action:save-timeseries', 'skipLatestPersistence')).toMatch(/processing settings/);
  });

  it('Save attributes SAYS every changed value is an audit row kept for good, and a changing value belongs in time series (review A I5)', () => {
    const s = RULE_NODE_TYPE_BY_ID.get('tb:action:save-attributes')!;
    const scopeHelp = s.fields.find((f) => f.key === 'scope')!.help ?? '';
    for (const [where, text] of [['description', s.description], ['scope help', scopeHelp]] as const) {
      expect(text, where).toMatch(/every changed value/i);
      expect(text, where).toMatch(/audit trail/);
      expect(text, where).toMatch(/kept for good/);
      expect(text, where).toMatch(/Save time series/);
    }
    // Delete attributes keeps the plain scope help: it shares no such advice.
    expect(RULE_NODE_TYPE_BY_ID.get('tb:action:delete-attributes')!.fields.find((f) => f.key === 'scope')!.help).not.toMatch(/Save time series/);
  });

  it('JSON path\'s example reads ThingsBoard\'s FLAT telemetry ($.temperature — no { ts, values } wrapper since ruling M-1)', () => {
    expect(RULE_NODE_TYPE_BY_ID.get('tb:transformation:json-path')!.fields[0].help).toBe('e.g. $.temperature');
  });

  it('both gateway-reaching defaults run TO the originator (the link runs gateway → instrument)', () => {
    // Change originator: RELATED is the gateway.
    const co = RULE_NODE_TYPE_BY_ID.get('tb:transformation:change-originator')!;
    expect((co.defaultConfig.relationsQuery as { direction: string }).direction).toBe('TO');
    // Related device attributes: "the gateway's attributes" — ruled 2026-11-04 (ThingsBoard's default is FROM).
    const rd = RULE_NODE_TYPE_BY_ID.get('tb:enrichment:related-device-attributes')!;
    expect((rd.defaultConfig.deviceRelationsQuery as { direction: string }).direction).toBe('TO');
    expect(rd.description).toMatch(/GATEWAY/);
  });

  it('the math operations and their argument counts are ThingsBoard\'s', () => {
    const op = (v: string) => RULE_MATH_OPERATIONS.find((o) => o.value === v);
    expect(RULE_MATH_OPERATIONS).toHaveLength(35);
    expect(op('ADD')).toMatchObject({ minArgs: 2, maxArgs: 2 });
    expect(op('SQRT')).toMatchObject({ minArgs: 1, maxArgs: 1 });
    expect(op('CUSTOM')).toMatchObject({ minArgs: 0, maxArgs: 16 });
  });

  it('a descriptor is the spec without its zod schema (what GET /node-types serves)', () => {
    const s = RULE_NODE_TYPE_BY_ID.get('tb:filter:script')!;
    const d = toRuleNodeTypeDescriptor(s);
    expect('configSchema' in d).toBe(false);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d).toMatchObject({ id: s.id, tbClass: s.tbClass, status: 'built', relations: ['True', 'False', 'Failure'] });
  });
});

describe('upgradeThingsboardConfig — ThingsBoard\'s own configuration upgrades, mirrored (ruling CV-1)', () => {
  const up = upgradeThingsboardConfig;

  it('Check relation presence v0 → v1 FLIPS the direction (TbCheckRelationNode.upgrade)', () => {
    const T = 'tb:filter:check-relation-presence';
    expect(up(T, 0, { direction: 'FROM', relationType: 'Contains' })).toEqual({ outcome: 'upgraded', config: { direction: 'TO', relationType: 'Contains' } });
    expect(up(T, 0, { direction: 'TO' })).toEqual({ outcome: 'upgraded', config: { direction: 'FROM' } });
    // Already v1: untouched.
    expect(up(T, 1, { direction: 'FROM' })).toEqual({ outcome: 'current', config: { direction: 'FROM' } });
    // ThingsBoard throws on a missing / bad direction and keeps the config as it is: so do we, and say so.
    expect(up(T, 0, { relationType: 'Contains' })).toEqual({ outcome: 'not-upgraded', config: { relationType: 'Contains' } });
    expect(up(T, 0, { direction: 'SIDEWAYS' })).toEqual({ outcome: 'not-upgraded', config: { direction: 'SIDEWAYS' } });
  });

  it('Copy / Rename keys v0: fromMetadata "true" / "false" (or a boolean) → copyFrom / renameIn METADATA / DATA', () => {
    expect(up('tb:transformation:copy-key-value-pairs', 0, { fromMetadata: 'true', keys: ['a'] }))
      .toEqual({ outcome: 'upgraded', config: { keys: ['a'], copyFrom: 'METADATA' } });
    expect(up('tb:transformation:copy-key-value-pairs', 0, { fromMetadata: false, keys: [] }))
      .toEqual({ outcome: 'upgraded', config: { keys: [], copyFrom: 'DATA' } });
    expect(up('tb:transformation:rename-keys', 0, { fromMetadata: true, renameKeysMapping: { a: 'b' } }))
      .toEqual({ outcome: 'upgraded', config: { renameKeysMapping: { a: 'b' }, renameIn: 'METADATA' } });
    // Delete keys v0 ALSO reads fromMetadata.
    expect(up('tb:transformation:delete-key-value-pairs', 0, { fromMetadata: 'false', keys: ['x'] }))
      .toEqual({ outcome: 'upgraded', config: { keys: ['x'], deleteFrom: 'DATA' } });
    expect(up('tb:transformation:copy-key-value-pairs', 0, { keys: [] }).outcome).toBe('not-upgraded');
    expect(up('tb:transformation:copy-key-value-pairs', 0, { fromMetadata: 'maybe' }).outcome).toBe('not-upgraded');
  });

  it('Copy / Rename keys v1: fromMetadata "METADATA" / "DATA"; Delete keys v1: dataToFetch', () => {
    expect(up('tb:transformation:copy-key-value-pairs', 1, { fromMetadata: 'METADATA', keys: [] }))
      .toEqual({ outcome: 'upgraded', config: { keys: [], copyFrom: 'METADATA' } });
    expect(up('tb:transformation:rename-keys', 1, { fromMetadata: 'DATA', renameKeysMapping: {} }))
      .toEqual({ outcome: 'upgraded', config: { renameKeysMapping: {}, renameIn: 'DATA' } });
    expect(up('tb:transformation:delete-key-value-pairs', 1, { dataToFetch: 'METADATA', keys: [] }))
      .toEqual({ outcome: 'upgraded', config: { keys: [], deleteFrom: 'METADATA' } });
    // v1 that already carries the v2 key: nothing to do (ThingsBoard returns it unchanged).
    expect(up('tb:transformation:delete-key-value-pairs', 1, { deleteFrom: 'DATA', dataToFetch: 'METADATA' }))
      .toEqual({ outcome: 'upgraded', config: { deleteFrom: 'DATA', dataToFetch: 'METADATA' } });
    expect(up('tb:transformation:delete-key-value-pairs', 1, { fromMetadata: 'METADATA' }).outcome).toBe('not-upgraded');
    expect(up('tb:transformation:copy-key-value-pairs', 2, { copyFrom: 'DATA' })).toEqual({ outcome: 'current', config: { copyFrom: 'DATA' } });
  });

  it('Device profile v0 → v1 (TbDeviceProfileNode.upgrade): not persisting the state means not fetching it', () => {
    expect(up('tb:action:device-profile', 0, { persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: true }))
      .toEqual({ outcome: 'upgraded', config: { persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: false } });
    expect(up('tb:action:device-profile', 0, { persistAlarmRulesState: true, fetchAlarmRulesStateOnStart: true }))
      .toEqual({ outcome: 'upgraded', config: { persistAlarmRulesState: true, fetchAlarmRulesStateOnStart: true } });
    expect(up('tb:action:device-profile', 0, {}).outcome).toBe('upgraded');
  });

  it('an older version of a node whose upgrade is NOT mirrored is "not-upgraded", the config untouched', () => {
    // Additive-only upgrades still not mirrored (CV-1's list): the Generator, REST API call.
    expect(up('tb:action:generator', 0, { periodInSeconds: 1 })).toEqual({ outcome: 'not-upgraded', config: { periodInSeconds: 1 } });
    expect(up('tb:external:rest-api-call', 3, { restEndpointUrlPattern: 'http://x' }).outcome).toBe('not-upgraded');
    expect(up('tb:action:save-attributes', 3, { scope: 'CLIENT_SCOPE' }).outcome).toBe('current');
  });

  it('a node that models version 0, a later / none node or an unknown type is always "current"; the input is never touched', () => {
    expect(up('tb:filter:script', 0, { jsScript: 'return true;' }).outcome).toBe('current');
    expect(up('tb:action:create-relation', 0, { direction: 'FROM' })).toEqual({ outcome: 'current', config: { direction: 'FROM' } });
    expect(up('tb:filter:nope', 0, {}).outcome).toBe('current');
    const input = { direction: 'FROM' };
    up('tb:filter:check-relation-presence', 0, input);
    expect(input).toEqual({ direction: 'FROM' });
    // Whatever the outcome, the config handed back is the caller's own copy, nested values too.
    for (const [type, version] of [['tb:filter:script', 0], ['tb:action:save-timeseries', 0]] as const) {
      const given = { jsScript: 'return true;', processingSettings: { type: 'ON_EVERY_MESSAGE' } };
      const back = up(type, version, given).config;
      expect(back).not.toBe(given);
      (back.processingSettings as { type: string }).type = 'CHANGED';
      expect(given.processingSettings.type).toBe('ON_EVERY_MESSAGE');
    }
  });
});

// ─── Ruling CV-3 (2026-11-05): every meaning-changing ThingsBoard upgrade, mirrored ─────
//
// Each vector below is read off ThingsBoard master (commit e48b5780, 2026-11-02): the
// node's own `upgrade()` and, where ThingsBoard has one, its unit test's upgrade vectors
// (TbMsgTimeseriesNodeTest / TbMsgAttributesNodeTest `givenFromVersionAndConfig_…`).

const ON_EVERY = { type: 'ON_EVERY_MESSAGE' };
/** What TbMsgTimeseriesNode.upgrade writes for skipLatestPersistence "true". */
const SKIP_LATEST = {
  type: 'ADVANCED', timeseries: { type: 'ON_EVERY_MESSAGE' }, latest: { type: 'SKIP' },
  webSockets: { type: 'ON_EVERY_MESSAGE' }, calculatedFields: { type: 'ON_EVERY_MESSAGE' },
};

describe('upgradeThingsboardConfig — CV-3: Save time series / Save attributes (TbMsgTimeseriesNode, TbMsgAttributesNode)', () => {
  const up = upgradeThingsboardConfig;

  it('Save time series v0 → v1: skipLatestPersistence "true" becomes Advanced (latest SKIP), anything else On every message; the v0 key goes', () => {
    const T = 'tb:action:save-timeseries';
    // ThingsBoard's four test vectors.
    expect(up(T, 0, { defaultTTL: 0, useServerTs: false, skipLatestPersistence: false }))
      .toEqual({ outcome: 'upgraded', config: { defaultTTL: 0, useServerTs: false, processingSettings: ON_EVERY } });
    expect(up(T, 0, { defaultTTL: 0, useServerTs: false }))
      .toEqual({ outcome: 'upgraded', config: { defaultTTL: 0, useServerTs: false, processingSettings: ON_EVERY } });
    expect(up(T, 0, { defaultTTL: 0, useServerTs: false, skipLatestPersistence: null }))
      .toEqual({ outcome: 'upgraded', config: { defaultTTL: 0, useServerTs: false, processingSettings: ON_EVERY } });
    expect(up(T, 0, { defaultTTL: 0, useServerTs: false, skipLatestPersistence: true }))
      .toEqual({ outcome: 'upgraded', config: { defaultTTL: 0, useServerTs: false, processingSettings: SKIP_LATEST } });
    // Jackson's asText(): the string "true" counts; "TRUE" does not.
    expect(up(T, 0, { skipLatestPersistence: 'true' }).config).toEqual({ processingSettings: SKIP_LATEST });
    expect(up(T, 0, { skipLatestPersistence: 'TRUE' }).config).toEqual({ processingSettings: ON_EVERY });
    // ThingsBoard 3.6.4's root chain ships this node at v0 with { defaultTTL: 0 }.
    expect(up(T, 0, { defaultTTL: 0 })).toEqual({ outcome: 'upgraded', config: { defaultTTL: 0, processingSettings: ON_EVERY } });
    expect(up(T, 1, { processingSettings: ON_EVERY }).outcome).toBe('current');
  });

  it('Save attributes v0 / v1 / v2 → v3: ThingsBoard\'s eight test vectors', () => {
    const T = 'tb:action:save-attributes';
    const v3 = (scope: string, notifyDevice: boolean, onlyOnChange: boolean) => ({
      outcome: 'upgraded',
      config: { processingSettings: ON_EVERY, scope, notifyDevice, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: onlyOnChange },
    });
    // v0, flags as strings, no updateAttributesOnlyOnValueChange → false (v0 never compared values).
    expect(up(T, 0, { scope: 'CLIENT_SCOPE', notifyDevice: 'false', sendAttributesUpdatedNotification: 'false' })).toEqual(v3('CLIENT_SCOPE', false, false));
    expect(up(T, 0, { scope: 'CLIENT_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true }))
      .toEqual(v3('CLIENT_SCOPE', false, true));
    expect(up(T, 1, { scope: 'SHARED_SCOPE', notifyDevice: true, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true }))
      .toEqual(v3('SHARED_SCOPE', true, true));
    // No flags at all: notifyDevice absent → TRUE (backward compatibility: the node once always notified).
    expect(up(T, 1, { scope: 'CLIENT_SCOPE' })).toEqual(v3('CLIENT_SCOPE', true, true));
    expect(up(T, 1, { scope: 'CLIENT_SCOPE', notifyDevice: 'false', sendAttributesUpdatedNotification: 'false', updateAttributesOnlyOnValueChange: 'true' }))
      .toEqual(v3('CLIENT_SCOPE', false, true));
    expect(up(T, 1, { scope: 'CLIENT_SCOPE', notifyDevice: 'false', sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true }))
      .toEqual(v3('CLIENT_SCOPE', false, true));
    // A text that is not a boolean ("null") takes the default — true for notifyDevice.
    expect(up(T, 1, { scope: 'CLIENT_SCOPE', notifyDevice: 'null', sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true }))
      .toEqual(v3('CLIENT_SCOPE', true, true));
    // ThingsBoard 3.6.4's root chain ships Save Client Attributes at v2: only processingSettings is added.
    expect(up(T, 2, { scope: 'SERVER_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true }))
      .toEqual(v3('SERVER_SCOPE', false, true));
  });

  it('Save attributes: the cases fall through (v0 runs v1 and v2 too); a JSON null is "absent"; the text is trimmed (TextNode.asBoolean)', () => {
    const T = 'tb:action:save-attributes';
    expect(up(T, 0, { scope: 'SERVER_SCOPE' }).config).toEqual({
      scope: 'SERVER_SCOPE', updateAttributesOnlyOnValueChange: false, notifyDevice: true, sendAttributesUpdatedNotification: false, processingSettings: ON_EVERY,
    });
    // v0 with the key present but null: `has` is true at v0, then v1's hasNonNull is false → true.
    expect(up(T, 0, { updateAttributesOnlyOnValueChange: null }).config.updateAttributesOnlyOnValueChange).toBe(true);
    expect(up(T, 1, { notifyDevice: null }).config.notifyDevice).toBe(true);
    expect(up(T, 1, { sendAttributesUpdatedNotification: ' true ' }).config.sendAttributesUpdatedNotification).toBe(true);
    expect(up(T, 1, { sendAttributesUpdatedNotification: 'TRUE' }).config.sendAttributesUpdatedNotification).toBe(false);
    // v2 REPLACES whatever processingSettings it carried, as ThingsBoard does.
    expect(up(T, 2, { processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 5 } }).config.processingSettings).toEqual(ON_EVERY);
  });
});

describe('upgradeThingsboardConfig — CV-3: the enrichment nodes\' v0 upgrades', () => {
  const up = upgradeThingsboardConfig;

  it('Originator attributes and Related device attributes v0: fetchToData → fetchTo (TbAbstractGetAttributesNode\'s rule)', () => {
    for (const T of ['tb:enrichment:originator-attributes', 'tb:enrichment:related-device-attributes']) {
      expect(up(T, 0, { fetchToData: true, latestTsKeyNames: ['t'] }), T).toEqual({ outcome: 'upgraded', config: { latestTsKeyNames: ['t'], fetchTo: 'DATA' } });
      expect(up(T, 0, { fetchToData: 'false' }).config, T).toEqual({ fetchTo: 'METADATA' });
      // Absent → METADATA, even over a fetchTo already there; a JSON null → removed, METADATA.
      expect(up(T, 0, { fetchTo: 'DATA' }).config, T).toEqual({ fetchTo: 'METADATA' });
      expect(up(T, 0, { fetchToData: null }).config, T).toEqual({ fetchTo: 'METADATA' });
      // Only an unexpected value makes ThingsBoard throw.
      expect(up(T, 0, { fetchToData: 'yes' }), T).toEqual({ outcome: 'not-upgraded', config: { fetchToData: 'yes' } });
      expect(up(T, 1, { fetchToData: true }).outcome, T).toBe('current');
    }
  });

  it('Tenant details v0: addToMetadata → fetchTo, true meaning METADATA; a missing key throws in ThingsBoard', () => {
    const T = 'tb:enrichment:tenant-details';
    expect(up(T, 0, { detailsList: ['TITLE'], addToMetadata: true })).toEqual({ outcome: 'upgraded', config: { detailsList: ['TITLE'], fetchTo: 'METADATA' } });
    expect(up(T, 0, { addToMetadata: 'false' }).config).toEqual({ fetchTo: 'DATA' });
    expect(up(T, 0, { detailsList: [] }).outcome).toBe('not-upgraded');
    expect(up(T, 0, { addToMetadata: null }).outcome).toBe('not-upgraded');
  });

  it('Originator fields v0: fieldsMapping → dataMapping, and fetchTo METADATA (TB-P 5 — the handler needs no fallback)', () => {
    const T = 'tb:enrichment:originator-fields';
    expect(up(T, 0, { fieldsMapping: { name: 'deviceName' }, ignoreNullStrings: true, fetchTo: 'DATA' }))
      .toEqual({ outcome: 'upgraded', config: { dataMapping: { name: 'deviceName' }, ignoreNullStrings: true, fetchTo: 'METADATA' } });
    expect(up(T, 0, { dataMapping: { name: 'x' } }).outcome).toBe('not-upgraded');
  });

  it('Tenant attributes v0: attrMapping → dataMapping, telemetry → dataToFetch, fetchTo METADATA; both keys required', () => {
    const T = 'tb:enrichment:tenant-attributes';
    expect(up(T, 0, { attrMapping: { limit: 'lim' }, telemetry: false }))
      .toEqual({ outcome: 'upgraded', config: { dataMapping: { limit: 'lim' }, dataToFetch: 'ATTRIBUTES', fetchTo: 'METADATA' } });
    expect(up(T, 0, { attrMapping: {}, telemetry: 'true' }).config).toEqual({ dataMapping: {}, dataToFetch: 'LATEST_TELEMETRY', fetchTo: 'METADATA' });
    expect(up(T, 0, { attrMapping: {} }).outcome).toBe('not-upgraded');
    expect(up(T, 0, { telemetry: false }).outcome).toBe('not-upgraded');
    expect(up(T, 0, { attrMapping: {}, telemetry: 'maybe' })).toEqual({ outcome: 'not-upgraded', config: { attrMapping: {}, telemetry: 'maybe' } });
  });

  it('Originator telemetry v0 / v1 → v2: orderBy / aggregation from fetchMode, limit 1000; v0 falls through into v1', () => {
    const T = 'tb:enrichment:originator-telemetry';
    expect(up(T, 0, { fetchMode: 'FIRST' }).config).toEqual({ fetchMode: 'FIRST', orderBy: 'ASC', aggregation: 'NONE', limit: 1000 });
    expect(up(T, 0, { fetchMode: 'LAST', limit: 5 }).config).toEqual({ fetchMode: 'LAST', orderBy: 'DESC', aggregation: 'NONE', limit: 5 });
    // ALL: a blank / null orderBy or aggregation is given its default; an absent one is v1's to fill.
    expect(up(T, 0, { fetchMode: 'ALL', orderBy: '', aggregation: null }).config).toEqual({ fetchMode: 'ALL', orderBy: 'ASC', aggregation: 'NONE', limit: 1000 });
    expect(up(T, 0, { fetchMode: 'ALL', orderBy: 'DESC' }).config).toEqual({ fetchMode: 'ALL', orderBy: 'DESC', aggregation: 'NONE', limit: 1000 });
    // An unknown fetchMode becomes LAST.
    expect(up(T, 0, { fetchMode: 'MIDDLE' }).config).toEqual({ fetchMode: 'LAST', orderBy: 'DESC', aggregation: 'NONE', limit: 1000 });
    expect(up(T, 0, {})).toEqual({ outcome: 'upgraded', config: { limit: 1000 } });
    expect(up(T, 1, { fetchMode: 'ALL', limit: 10 }).config).toEqual({ fetchMode: 'ALL', limit: 10, aggregation: 'NONE', orderBy: 'ASC' });
    expect(up(T, 1, { fetchMode: 'FIRST' }).config).toEqual({ fetchMode: 'FIRST', limit: 1000 });
    expect(up(T, 2, { fetchMode: 'FIRST' }).outcome).toBe('current');
  });

  it('Calculate delta v0 (additive): excludeZeroDeltas absent → false', () => {
    const T = 'tb:enrichment:calculate-delta';
    expect(up(T, 0, { inputValueKey: 'a' })).toEqual({ outcome: 'upgraded', config: { inputValueKey: 'a', excludeZeroDeltas: false } });
    expect(up(T, 0, { excludeZeroDeltas: true })).toEqual({ outcome: 'upgraded', config: { excludeZeroDeltas: true } });
  });
});

describe('fromThingsboardConfig / toThingsboardConfig — CV-3: ONE source of truth per node, ThingsBoard\'s form at the boundary', () => {
  const TS = 'tb:action:save-timeseries';
  const ATTR = 'tb:action:save-attributes';
  const adv = (over: Record<string, unknown>) => ({ ...SKIP_LATEST, latest: ON_EVERY, ...over });

  it('Save time series import: processingSettings sets the toggle (explicitly), and is kept as it came', () => {
    expect(fromThingsboardConfig(TS, { defaultTTL: 0, processingSettings: ON_EVERY }))
      .toEqual({ config: { defaultTTL: 0, processingSettings: ON_EVERY, skipLatestPersistence: false }, notHonoured: null });
    expect(fromThingsboardConfig(TS, { processingSettings: SKIP_LATEST }))
      .toEqual({ config: { processingSettings: SKIP_LATEST, skipLatestPersistence: true }, notHonoured: null });
    expect(fromThingsboardConfig(TS, { processingSettings: adv({}) }).config.skipLatestPersistence).toBe(false);
    // The setting wins over a stale toggle beside it.
    expect(fromThingsboardConfig(TS, { skipLatestPersistence: true, processingSettings: ON_EVERY }).config.skipLatestPersistence).toBe(false);
    // WebSockets / calculated fields have no counterpart here: never judged, never warned about.
    expect(fromThingsboardConfig(TS, { processingSettings: adv({ webSockets: { type: 'SKIP' }, calculatedFields: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 9 } }) }))
      .toEqual({ config: expect.objectContaining({ skipLatestPersistence: false }), notHonoured: null });
  });

  it('Save time series import: a strategy not built here sets the toggle from the latest strategy and is NAMED in one note', () => {
    const dedupe = fromThingsboardConfig(TS, { processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 } });
    expect(dedupe.config.skipLatestPersistence).toBe(false);
    expect(dedupe.config.processingSettings).toEqual({ type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 });
    expect(dedupe.notHonoured).toBe('processing settings not built here (Deduplicate every 60 s) — it saves every reading and updates the latest readings.');
    const ws = fromThingsboardConfig(TS, { processingSettings: { type: 'WEBSOCKETS_ONLY' } });
    expect(ws.config.skipLatestPersistence).toBe(true);
    expect(ws.notHonoured).toBe('processing settings not built here (WebSockets only) — it saves every reading and does not update the latest readings.');
    const mixed = fromThingsboardConfig(TS, { processingSettings: adv({ timeseries: { type: 'SKIP' }, latest: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 10 } }) });
    expect(mixed.config.skipLatestPersistence).toBe(false);
    expect(mixed.notHonoured).toBe('processing settings not built here (time series: Skip; latest: Deduplicate every 10 s) — it saves every reading and updates the latest readings.');
    // A type ThingsBoard does not have either: the toggle stays as the config gives it.
    const odd = fromThingsboardConfig(TS, { skipLatestPersistence: 'true', processingSettings: { type: 'BATCH' } });
    expect(odd.config).toEqual({ skipLatestPersistence: true, processingSettings: { type: 'BATCH' } });
    expect(odd.notHonoured).toBe('processing settings not built here (type "BATCH") — it saves every reading and does not update the latest readings.');
  });

  it('Save time series import with NO processingSettings: the toggle as given (Jackson asText "true"), and ThingsBoard\'s v0 → v1 form beside it', () => {
    expect(fromThingsboardConfig(TS, { defaultTTL: 0 })).toEqual({
      config: { defaultTTL: 0, skipLatestPersistence: false, processingSettings: ON_EVERY }, notHonoured: null,
    });
    expect(fromThingsboardConfig(TS, { skipLatestPersistence: 'true', processingSettings: null }).config)
      .toEqual({ skipLatestPersistence: true, processingSettings: SKIP_LATEST });
  });

  it('Save time series export: no toggle key (ThingsBoard\'s v1 class has none); the stored setting verbatim unless it contradicts the toggle', () => {
    // Consistent → verbatim.
    expect(toThingsboardConfig(TS, { defaultTTL: 0, skipLatestPersistence: true, processingSettings: SKIP_LATEST })).toEqual({ defaultTTL: 0, processingSettings: SKIP_LATEST });
    expect(toThingsboardConfig(TS, { skipLatestPersistence: false, processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 } }))
      .toEqual({ processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 } });
    expect(toThingsboardConfig(TS, { skipLatestPersistence: true, processingSettings: { type: 'WEBSOCKETS_ONLY' } })).toEqual({ processingSettings: { type: 'WEBSOCKETS_ONLY' } });
    // Contradicting, absent or unreadable → exactly what ThingsBoard's own v0 → v1 upgrade writes for the toggle.
    expect(toThingsboardConfig(TS, { skipLatestPersistence: true, processingSettings: ON_EVERY })).toEqual({ processingSettings: SKIP_LATEST });
    expect(toThingsboardConfig(TS, { skipLatestPersistence: false, processingSettings: SKIP_LATEST })).toEqual({ processingSettings: ON_EVERY });
    expect(toThingsboardConfig(TS, { useServerTs: true })).toEqual({ useServerTs: true, processingSettings: ON_EVERY });
    expect(toThingsboardConfig(TS, { skipLatestPersistence: true, processingSettings: { type: 'BATCH' } })).toEqual({ processingSettings: SKIP_LATEST });
  });

  it('Save time series: ONE predicate both ways — every known setting survives import → export verbatim', () => {
    for (const ps of [ON_EVERY, SKIP_LATEST, adv({}), { type: 'WEBSOCKETS_ONLY' }, { type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 },
      adv({ latest: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 5 } }), adv({ timeseries: { type: 'SKIP' }, latest: { type: 'SKIP' } })]) {
      const stored = fromThingsboardConfig(TS, { defaultTTL: 0, processingSettings: ps }).config;
      expect(toThingsboardConfig(TS, stored), JSON.stringify(ps)).toEqual({ defaultTTL: 0, processingSettings: ps });
    }
  });

  it('Save attributes: what is built (save on every message) is honoured, the rest named; a missing setting is ThingsBoard\'s default', () => {
    expect(fromThingsboardConfig(ATTR, { scope: 'SERVER_SCOPE', processingSettings: ON_EVERY })).toEqual({ config: { scope: 'SERVER_SCOPE', processingSettings: ON_EVERY }, notHonoured: null });
    expect(fromThingsboardConfig(ATTR, { processingSettings: { type: 'ADVANCED', attributes: ON_EVERY, webSockets: { type: 'SKIP' }, calculatedFields: { type: 'SKIP' } } }).notHonoured).toBeNull();
    expect(fromThingsboardConfig(ATTR, { processingSettings: { type: 'ADVANCED', attributes: { type: 'SKIP' }, webSockets: ON_EVERY, calculatedFields: ON_EVERY } }).notHonoured)
      .toBe('processing settings not built here (attributes: Skip) — it saves the attributes of every message.');
    expect(fromThingsboardConfig(ATTR, { processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 30 } }).notHonoured)
      .toBe('processing settings not built here (Deduplicate every 30 s) — it saves the attributes of every message.');
    expect(fromThingsboardConfig(ATTR, { processingSettings: { type: 'WEBSOCKETS_ONLY' } }).notHonoured)
      .toBe('processing settings not built here (WebSockets only) — it saves the attributes of every message.');
    expect(fromThingsboardConfig(ATTR, { scope: 'CLIENT_SCOPE' }).config).toEqual({ scope: 'CLIENT_SCOPE', processingSettings: ON_EVERY });
    // Export: the stored setting verbatim; none → ThingsBoard's default (its @NotNull refuses a missing one).
    expect(toThingsboardConfig(ATTR, { scope: 'SERVER_SCOPE', processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 30 } }))
      .toEqual({ scope: 'SERVER_SCOPE', processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 30 } });
    expect(toThingsboardConfig(ATTR, { scope: 'SERVER_SCOPE' })).toEqual({ scope: 'SERVER_SCOPE', processingSettings: ON_EVERY });
  });

  it('any other node passes both ways unchanged — as a copy; the input is never touched', () => {
    // (A script node is no longer "any other node": ruling TB-L writes its scriptLang — see the TB-L block.)
    const cfg = { jsonPath: '$.temperature', nested: { a: 1 } };
    const imp = fromThingsboardConfig('tb:transformation:json-path', cfg);
    expect(imp).toEqual({ config: cfg, notHonoured: null });
    expect(imp.config).not.toBe(cfg);
    const exp = toThingsboardConfig('tb:transformation:json-path', cfg);
    expect(exp).toEqual(cfg);
    (exp.nested as { a: number }).a = 2;
    expect(cfg.nested.a).toBe(1);
    const given = { skipLatestPersistence: true, processingSettings: { type: 'ON_EVERY_MESSAGE' } };
    fromThingsboardConfig(TS, given);
    toThingsboardConfig(TS, given);
    expect(given).toEqual({ skipLatestPersistence: true, processingSettings: { type: 'ON_EVERY_MESSAGE' } });
  });
});

describe('later / none nodes', () => {
  it('carry no fields, Failure as their only relation, an empty default, and accept any object', () => {
    for (const s of RULE_NODE_TYPES.filter((x) => x.status !== 'built')) {
      expect(s.fields, s.id).toEqual([]);
      expect(s.relations, s.id).toEqual(['Failure']);
      expect(s.defaultConfig, s.id).toEqual({});
      expect(s.configSchema.safeParse({ anything: [1, { two: 2 }] }).success, s.id).toBe(true);
      expect(s.configSchema.safeParse('not an object').success, s.id).toBe(false);
    }
  });
});

describe('message types and the Message Type Switch labels', () => {
  it('RULE_MESSAGE_TYPES is the spec §5 list', () => {
    expect([...RULE_MESSAGE_TYPES]).toEqual([
      'POST_TELEMETRY_REQUEST', 'POST_ATTRIBUTES_REQUEST', 'ATTRIBUTES_UPDATED', 'ATTRIBUTES_DELETED',
      'ALARM', 'ALARM_CLEAR', 'ALARM_ACK', 'INACTIVITY_EVENT', 'ACTIVITY_EVENT',
      'ENTITY_CREATED', 'ENTITY_UPDATED', 'ENTITY_DELETED', 'REST_API_REQUEST', 'GENERATOR_NODE_SELF_MSG', 'SEND_EMAIL',
    ]);
  });

  it('labels are ThingsBoard\'s TbMsgType labels', () => {
    expect(MESSAGE_TYPE_SWITCH_LABELS.POST_TELEMETRY_REQUEST).toBe('Post telemetry');
    expect(MESSAGE_TYPE_SWITCH_LABELS.POST_ATTRIBUTES_REQUEST).toBe('Post attributes');
    expect(MESSAGE_TYPE_SWITCH_LABELS.ALARM).toBe('Alarm');
    expect(MESSAGE_TYPE_SWITCH_LABELS.ALARM_CLEAR).toBe('Alarm Cleared');
    expect(MESSAGE_TYPE_SWITCH_LABELS.ALARM_ACK).toBe('Alarm Acknowledged');
    expect(MESSAGE_TYPE_SWITCH_LABELS.INACTIVITY_EVENT).toBe('Inactivity Event');
    expect(MESSAGE_TYPE_SWITCH_LABELS.ACTIVITY_EVENT).toBe('Activity Event');
    expect(MESSAGE_TYPE_SWITCH_LABELS.ATTRIBUTES_UPDATED).toBe('Attributes Updated');
    expect(MESSAGE_TYPE_SWITCH_LABELS.ENTITY_CREATED).toBe('Entity Created');
    expect(MESSAGE_TYPE_SWITCH_LABELS.TO_SERVER_RPC_REQUEST).toBe('RPC Request from Device');
    // ThingsBoard's own spelling — lower-case "request" (the spec wrote "Request").
    expect(MESSAGE_TYPE_SWITCH_LABELS.REST_API_REQUEST).toBe('REST API request');
  });

  it('a type with no label (generator, email, custom) routes to Other', () => {
    expect(messageTypeSwitchLabel('POST_TELEMETRY_REQUEST')).toBe('Post telemetry');
    expect(messageTypeSwitchLabel('GENERATOR_NODE_SELF_MSG')).toBe('Other');
    expect(messageTypeSwitchLabel('SEND_EMAIL')).toBe('Other');
    expect(messageTypeSwitchLabel('CUSTOM:anything')).toBe('Other');
    expect(messageTypeSwitchLabel('toString')).toBe('Other');
    expect(MESSAGE_TYPE_SWITCH_LABELS.GENERATOR_NODE_SELF_MSG).toBeUndefined();
  });
});

// ─── Ruling TB-L (2026-11-05): TBEL is not built here — every script runs as JavaScript ───
describe('scripts — ruling TB-L: ONE rule for which script a node runs', () => {
  const LOG = 'tb:action:log';
  const ALARM = 'tb:action:create-alarm';

  it('RULE_SCRIPT_KEYS names every built node with a script field, keyed by that field — and nothing else', () => {
    const withScript = BUILT_RULE_NODE_TYPES.filter((s) => s.fields.some((f) => f.type === 'script'));
    expect(Object.keys(RULE_SCRIPT_KEYS).sort()).toEqual(withScript.map((s) => s.id).sort());
    expect(withScript).toHaveLength(7);
    for (const s of withScript) {
      const scriptKeys = new Set(s.fields.filter((f) => f.type === 'script').map((f) => f.key));
      expect([...scriptKeys], s.id).toEqual([RULE_SCRIPT_KEYS[s.id][0]]);
      // Every catalogue default runs JavaScript.
      expect(s.defaultConfig.scriptLang, s.id).toBe('JS');
      expect(s.defaultConfig[RULE_SCRIPT_KEYS[s.id][1]], s.id).toBeUndefined();
    }
    expect(RULE_SCRIPT_KEYS[ALARM]).toEqual(['alarmDetailsBuildJs', 'alarmDetailsBuildTbel']);
    expect(RULE_SCRIPT_KEYS['tb:action:clear-alarm']).toEqual(['alarmDetailsBuildJs', 'alarmDetailsBuildTbel']);
  });

  it('ruleNodeScriptKey: TBEL with a TBEL script runs THAT script; anything else runs the JavaScript key', () => {
    expect(ruleNodeScriptKey(LOG, { scriptLang: 'JS', jsScript: 'a', tbelScript: 'b' })).toBe('jsScript');
    expect(ruleNodeScriptKey(LOG, { jsScript: 'a', tbelScript: 'b' })).toBe('jsScript');                    // absent = JS, as ThingsBoard reads it
    expect(ruleNodeScriptKey(LOG, { scriptLang: 'TBEL', jsScript: 'a', tbelScript: 'b' })).toBe('tbelScript');
    expect(ruleNodeScriptKey(LOG, { scriptLang: 'TBEL', jsScript: 'a', tbelScript: '  ' })).toBe('jsScript'); // nothing to run there
    expect(ruleNodeScriptKey(LOG, { scriptLang: 'TBEL', jsScript: 'a', tbelScript: null })).toBe('jsScript');
    expect(ruleNodeScriptKey(ALARM, { scriptLang: 'TBEL', alarmDetailsBuildTbel: 'return {};' })).toBe('alarmDetailsBuildTbel');
    expect(ruleNodeScriptKey('tb:filter:message-type-switch', { scriptLang: 'TBEL' })).toBeNull();
    expect(ruleNodeScript(LOG, { scriptLang: 'TBEL', jsScript: 'a', tbelScript: 'b' })).toBe('b');
    expect(ruleNodeScript(LOG, { scriptLang: 'JS', jsScript: 'a', tbelScript: 'b' })).toBe('a');
    expect(ruleNodeScript(LOG, {})).toBeUndefined();
    expect(ruleNodeScript('tb:filter:message-type-switch', { jsScript: 'a' })).toBeUndefined();
  });

  it('import (fromThingsboardConfig): TBEL becomes JavaScript running the TBEL script the author ran — the TBEL twin dropped, ONE note', () => {
    const r = fromThingsboardConfig(LOG, { scriptLang: 'TBEL', jsScript: 'return "js";', tbelScript: 'return "tbel";' });
    expect(r).toEqual({ config: { scriptLang: 'JS', jsScript: 'return "tbel";' }, notHonoured: 'its TBEL script now runs as JavaScript — check it.' });
    // Identical texts are still a language change: the author ran it as TBEL.
    expect(fromThingsboardConfig(LOG, { scriptLang: 'TBEL', jsScript: 'x', tbelScript: 'x' }).notHonoured).toBe('its TBEL script now runs as JavaScript — check it.');
    // Create / Clear alarm: their own two keys.
    expect(fromThingsboardConfig(ALARM, { alarmType: 'A', severity: 'MAJOR', scriptLang: 'TBEL', alarmDetailsBuildJs: 'return {js: 1};', alarmDetailsBuildTbel: 'return {tbel: 1};' }).config)
      .toEqual({ alarmType: 'A', severity: 'MAJOR', scriptLang: 'JS', alarmDetailsBuildJs: 'return {tbel: 1};' });
  });

  it('import: JavaScript keeps its script and loses a stale TBEL twin, with no note; an absent language reads as JavaScript', () => {
    expect(fromThingsboardConfig(LOG, { scriptLang: 'JS', jsScript: 'a', tbelScript: 'b' })).toEqual({ config: { scriptLang: 'JS', jsScript: 'a' }, notHonoured: null });
    expect(fromThingsboardConfig(LOG, { jsScript: 'a' })).toEqual({ config: { scriptLang: 'JS', jsScript: 'a' }, notHonoured: null });
  });

  it('import: TBEL with NO TBEL script (ThingsBoard could not start it) runs the JavaScript one, and says so', () => {
    expect(fromThingsboardConfig(LOG, { scriptLang: 'TBEL', jsScript: 'a', tbelScript: '' })).toEqual({
      config: { scriptLang: 'JS', jsScript: 'a' },
      notHonoured: 'it was set to TBEL with no TBEL script (ThingsBoard could not start it); its JavaScript script runs here — check it.',
    });
  });

  it('export (toThingsboardConfig): scriptLang JS and the script that RUNS, never a stale TBEL script', () => {
    expect(toThingsboardConfig(LOG, { scriptLang: 'JS', jsScript: 'a', tbelScript: 'stale' })).toEqual({ scriptLang: 'JS', jsScript: 'a' });
    // A document stored before TB-L may still say TBEL: its TBEL script is what runs, so it goes out as the JavaScript.
    expect(toThingsboardConfig(LOG, { scriptLang: 'TBEL', jsScript: 'old js', tbelScript: 'ran' })).toEqual({ scriptLang: 'JS', jsScript: 'ran' });
    expect(toThingsboardConfig('tb:action:clear-alarm', { alarmType: 'A', scriptLang: 'TBEL', alarmDetailsBuildJs: 'j', alarmDetailsBuildTbel: 't' }))
      .toEqual({ alarmType: 'A', scriptLang: 'JS', alarmDetailsBuildJs: 't' });
    expect(toThingsboardConfig(LOG, { jsScript: 'a' })).toEqual({ scriptLang: 'JS', jsScript: 'a' });
    // A node with no script is not touched.
    expect(toThingsboardConfig('tb:filter:message-type-switch', { version: 0, scriptLang: 'TBEL' })).toEqual({ version: 0, scriptLang: 'TBEL' });
  });

  it('the editor shows ONE script field, and it is the one that runs (a legacy stored TBEL config edits its TBEL script)', () => {
    const scriptFields = (type: string, config: Record<string, unknown>) =>
      visibleRuleNodeFields(type, config).filter((f) => f.type === 'script').map((f) => f.key);
    expect(scriptFields(LOG, { scriptLang: 'JS', jsScript: 'a' })).toEqual(['jsScript']);
    expect(scriptFields(LOG, { scriptLang: 'TBEL', jsScript: 'a', tbelScript: 'b' })).toEqual(['tbelScript']);
    expect(scriptFields(LOG, { scriptLang: 'TBEL', jsScript: 'a', tbelScript: '' })).toEqual(['jsScript']);
    expect(scriptFields(ALARM, { ...RULE_NODE_TYPE_BY_ID.get(ALARM)!.defaultConfig, scriptLang: 'TBEL', alarmDetailsBuildTbel: 'return {};' })).toEqual(['alarmDetailsBuildTbel']);
    // No scriptLang selector anywhere.
    for (const s of BUILT_RULE_NODE_TYPES) expect(s.fields.map((f) => f.key), s.id).not.toContain('scriptLang');
    // The catalogue entry itself is not changed by the lookup.
    expect(RULE_NODE_TYPE_BY_ID.get(LOG)!.fields[0].key).toBe('jsScript');
  });
});

// ─── Ruling SW-1 (2026-11-05, refined by review B): ThingsBoard's entity-type vocabulary ───
describe('entity types — ruling SW-1: configurations store ThingsBoard\'s values, the switch\'s labels map at the boundary', () => {
  const FILTER = 'tb:filter:entity-type-filter';
  const GEN = 'tb:action:generator';

  it('each originator type stands for ONE ThingsBoard EntityType, and the switch names it as ThingsBoard\'s EntityType.getNormalName() does', () => {
    expect(RULE_ORIGINATOR_TB_ENTITY_TYPES).toEqual({ INSTRUMENT: 'DEVICE', ALARM: 'ALARM', USER: 'USER', SYSTEM: 'TENANT', RULE_NODE: 'RULE_NODE' });
    // EntityType.java (master e48b5780): capitalize(name().toLowerCase().replaceAll("_", " ")).
    expect(TB_ENTITY_TYPE_SWITCH_LABELS).toEqual({ INSTRUMENT: 'Device', ALARM: 'Alarm', USER: 'User', SYSTEM: 'Tenant', RULE_NODE: 'Rule node' });
    // Each ThingsBoard value reads back as the type it stands for (the handlers' toRuleOriginatorType).
    for (const t of RULE_ORIGINATOR_TYPES) expect(toRuleOriginatorType(RULE_ORIGINATOR_TB_ENTITY_TYPES[t]), t).toBe(t);
  });

  it('Entity type filter OFFERS and DEFAULTS to ThingsBoard\'s values, labelled as here (Instrument / System …)', () => {
    const s = RULE_NODE_TYPE_BY_ID.get(FILTER)!;
    expect(s.fields[0].options).toEqual([
      { value: 'DEVICE', label: 'Instrument' }, { value: 'ALARM', label: 'Alarm' }, { value: 'USER', label: 'User' },
      { value: 'TENANT', label: 'System' }, { value: 'RULE_NODE', label: 'Rule node' },
    ]);
    expect(s.defaultConfig).toEqual({ originatorTypes: ['DEVICE'] });
  });

  it('Generator OFFERS ThingsBoard\'s DEVICE for "An instrument", and shows the instrument picker for it', () => {
    const s = RULE_NODE_TYPE_BY_ID.get(GEN)!;
    expect(s.fields.find((f) => f.key === 'originatorType')!.options).toEqual([
      { value: 'RULE_NODE', label: 'This rule node' }, { value: 'DEVICE', label: 'An instrument' },
    ]);
    const picker = (originatorType: string) => visibleRuleNodeFields(GEN, { ...s.defaultConfig, originatorType }).some((f) => f.key === 'originatorId');
    expect(picker('DEVICE')).toBe(true);
    expect(picker('RULE_NODE')).toBe(false);
    // A config stored before SW-1 still says INSTRUMENT: it is judged as DEVICE, so the picker does not vanish.
    expect(picker('INSTRUMENT')).toBe(true);
  });

  it('canonicalRuleNodeConfig: a legacy INSTRUMENT / SYSTEM reads as DEVICE / TENANT; every other value and node is left alone', () => {
    expect(canonicalRuleNodeConfig(FILTER, { originatorTypes: ['INSTRUMENT', 'SYSTEM', 'ALARM', 'ASSET'] })).toEqual({ originatorTypes: ['DEVICE', 'TENANT', 'ALARM', 'ASSET'] });
    // The same type twice (INSTRUMENT beside DEVICE) is listed once.
    expect(canonicalRuleNodeConfig(FILTER, { originatorTypes: ['DEVICE', 'INSTRUMENT'] })).toEqual({ originatorTypes: ['DEVICE'] });
    expect(canonicalRuleNodeConfig(GEN, { originatorType: 'INSTRUMENT', originatorId: 'i1' })).toEqual({ originatorType: 'DEVICE', originatorId: 'i1' });
    expect(canonicalRuleNodeConfig(GEN, { originatorType: 'SYSTEM' })).toEqual({ originatorType: 'TENANT' });
    expect(canonicalRuleNodeConfig(GEN, { originatorType: 'RULE_NODE' })).toEqual({ originatorType: 'RULE_NODE' });
    expect(canonicalRuleNodeConfig('tb:filter:check-relation-presence', { entityType: 'INSTRUMENT' })).toEqual({ entityType: 'INSTRUMENT' });
    const given = { originatorTypes: ['INSTRUMENT'] };
    canonicalRuleNodeConfig(FILTER, given);
    expect(given).toEqual({ originatorTypes: ['INSTRUMENT'] });        // never in place
  });

  it('import and export both write ThingsBoard\'s values — a legacy INSTRUMENT / SYSTEM goes out as DEVICE / TENANT', () => {
    expect(fromThingsboardConfig(FILTER, { originatorTypes: ['INSTRUMENT', 'TENANT'] })).toEqual({ config: { originatorTypes: ['DEVICE', 'TENANT'] }, notHonoured: null });
    expect(toThingsboardConfig(FILTER, { originatorTypes: ['INSTRUMENT', 'SYSTEM'] })).toEqual({ originatorTypes: ['DEVICE', 'TENANT'] });
    expect(toThingsboardConfig(GEN, { ...RULE_NODE_TYPE_BY_ID.get(GEN)!.defaultConfig, originatorType: 'INSTRUMENT', originatorId: 'i1' }))
      .toMatchObject({ originatorType: 'DEVICE', originatorId: 'i1' });
    expect(fromThingsboardConfig(GEN, { periodInSeconds: 1, originatorType: 'SYSTEM', scriptLang: 'JS', jsScript: 'return {};' }).config.originatorType).toBe('TENANT');
  });

  it('the Entity type switch\'s connection labels map at the boundary: Device ↔ Instrument, Tenant ↔ System; the rest are the same words', () => {
    expect(entityTypeSwitchLabelFromThingsboard('Device')).toBe('Instrument');
    expect(entityTypeSwitchLabelFromThingsboard('Tenant')).toBe('System');
    for (const same of ['Alarm', 'User', 'Rule node', 'Asset', 'Customer', 'Failure', 'Instrument']) expect(entityTypeSwitchLabelFromThingsboard(same), same).toBe(same);
    expect(entityTypeSwitchLabelToThingsboard('Instrument')).toBe('Device');
    expect(entityTypeSwitchLabelToThingsboard('System')).toBe('Tenant');
    for (const same of ['Alarm', 'User', 'Rule node', 'Failure', 'Device']) expect(entityTypeSwitchLabelToThingsboard(same), same).toBe(same);
    expect(entityTypeSwitchLabelFromThingsboard('toString')).toBe('toString');
    // The switch still EMITS this system's labels (its handler is unchanged).
    expect(RULE_NODE_TYPE_BY_ID.get('tb:filter:entity-type-switch')!.relations).toEqual(['Instrument', 'Alarm', 'User', 'System', 'Rule node', 'Failure']);
  });
});

describe('the small vocabulary', () => {
  it('relations, originators, debug modes and caps', () => {
    expect([RULE_RELATION_SUCCESS, RULE_RELATION_FAILURE, RULE_RELATION_TRUE, RULE_RELATION_FALSE, RULE_RELATION_OTHER])
      .toEqual(['Success', 'Failure', 'True', 'False', 'Other']);
    expect([...RULE_ORIGINATOR_TYPES]).toEqual(['INSTRUMENT', 'ALARM', 'USER', 'SYSTEM', 'RULE_NODE']);
    expect(TB_ENTITY_TYPE_ALIASES.DEVICE).toBe('INSTRUMENT');
    expect(TB_ENTITY_TYPE_ALIASES.TENANT).toBe('SYSTEM');
    expect([...RULE_DEBUG_MODES]).toEqual(['off', 'all', 'failures']);
    expect([RULE_NODE_NAME_MAX, RULE_CHAIN_NAME_MAX, RULE_CHAIN_NODES_MAX]).toEqual([80, 120, 300]);
  });
});
