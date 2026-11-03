import { describe, it, expect } from 'vitest';
import {
  RULE_NODE_TYPES, RULE_NODE_TYPE_BY_ID, RULE_NODE_TYPE_BY_TB_CLASS, BUILT_RULE_NODE_TYPES, UNSUPPORTED_NODE_TYPE,
  RULE_NODE_GROUPS, RULE_MESSAGE_TYPES, MESSAGE_TYPE_SWITCH_LABELS, messageTypeSwitchLabel,
  RULE_RELATION_SUCCESS, RULE_RELATION_FAILURE, RULE_RELATION_TRUE, RULE_RELATION_FALSE, RULE_RELATION_OTHER,
  RULE_ORIGINATOR_TYPES, RULE_ORIGINATOR_TYPE_LABELS, TB_ENTITY_TYPE_ALIASES, RULE_DEBUG_MODES,
  RULE_NODE_NAME_MAX, RULE_CHAIN_NAME_MAX, RULE_CHAIN_NODES_MAX, RULE_MATH_OPERATIONS, toRuleNodeTypeDescriptor,
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
  // action (10)
  'tb:action:clear-alarm', 'tb:action:create-alarm', 'tb:action:delay', 'tb:action:delete-attributes',
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

  it('marks 46 built, 10 later and 30 with no counterpart here', () => {
    expect(countBy(RULE_NODE_TYPES, (s) => s.status)).toEqual({ built: 46, later: 10, none: 30 });
  });

  it('built is EXACTLY the 46 nodes Tasks 4-6 write handlers for', () => {
    expect(BUILT_RULE_NODE_TYPES.map((s) => s.id).sort()).toEqual([...BUILT_IDS].sort());
    expect(BUILT_IDS).toHaveLength(46);
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
  it.each(BUILT_IDS)('%s: every field is labelled, keyed once, and its schema ACCEPTS the default config', (id) => {
    const s = RULE_NODE_TYPE_BY_ID.get(id)!;
    const keys = s.fields.map((f) => f.key);
    expect(new Set(keys).size, 'field keys unique').toBe(keys.length);
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
