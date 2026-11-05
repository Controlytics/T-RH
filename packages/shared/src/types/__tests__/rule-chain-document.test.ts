import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  RULE_CHAIN_DOCUMENT_VERSION, DEFAULT_ROOT_CHAIN_NAME, DEFAULT_ROOT_CHAIN_NODE_IDS,
  parseRuleChainDocument, readRuleChainDocument, emptyRuleChainDocument, defaultRootChainDocument,
  toThingsboardExport, fromThingsboardExport, ruleChainsEqual,
  type RuleChainDocument,
} from '../rule-chain-document.js';
import {
  RULE_NODE_TYPES, RULE_NODE_TYPE_BY_ID, RULE_NODE_TYPE_BY_TB_CLASS, UNSUPPORTED_NODE_TYPE, RULE_CHAIN_NODES_MAX, RULE_SCRIPT_KEYS,
} from '../rule-nodes.js';

/**
 * The rule chain DOCUMENT (rule chains, 2026-11-03; spec §4, §5, §8).
 * One chain = one document — nodes, connections, the first node. Two readers,
 * as for the dashboard document: STRICT on every write, FORGIVING on every read.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function node(id: string, type: string, extra: Partial<RuleChainDocument['nodes'][number]> = {}) {
  const spec = RULE_NODE_TYPE_BY_ID.get(type);
  return { id, type, name: extra.name ?? (spec?.label ?? 'Node'), debugMode: 'off' as const, config: spec ? { ...spec.defaultConfig } : {}, x: 10, y: 20, ...extra };
}

function doc(over: Partial<RuleChainDocument> = {}): RuleChainDocument {
  return {
    version: 1,
    firstNodeId: A,
    nodes: [node(A, 'tb:filter:message-type-switch'), node(B, 'tb:action:log')],
    connections: [{ from: A, to: B, relation: 'Other' }],
    ...over,
  };
}

function parseError(v: unknown): string {
  try { parseRuleChainDocument(v); } catch (e) {
    expect(e).toBeInstanceOf(ZodError);
    return (e as ZodError).issues.map((i) => i.message).join(' | ');
  }
  throw new Error('expected parseRuleChainDocument to throw');
}

describe('defaultRootChainDocument — ThingsBoard\'s default root chain, as far as it exists here', () => {
  it('parses strictly and is unchanged by the parse', () => {
    const d = defaultRootChainDocument();
    expect(parseRuleChainDocument(d)).toEqual(d);
  });

  it('is Input → Message Type Switch → Post telemetry / Post attributes / Other (spec §5)', () => {
    const d = defaultRootChainDocument();
    expect(d.nodes.map((n) => [n.type, n.name])).toEqual([
      ['tb:filter:message-type-switch', 'Message Type Switch'],
      ['tb:action:save-timeseries', 'Save Timeseries'],
      ['tb:action:save-attributes', 'Save Attributes'],
      ['tb:action:log', 'Log Other'],
    ]);
    expect(d.firstNodeId).toBe(DEFAULT_ROOT_CHAIN_NODE_IDS.messageTypeSwitch);
    const byId = new Map(d.nodes.map((n) => [n.id, n.name]));
    expect(d.connections.map((c) => [byId.get(c.from), c.relation, byId.get(c.to)])).toEqual([
      ['Message Type Switch', 'Post telemetry', 'Save Timeseries'],
      ['Message Type Switch', 'Post attributes', 'Save Attributes'],
      ['Message Type Switch', 'Other', 'Log Other'],
    ]);
    // `RPC Request from Device` and the alarm / activity labels go nowhere (spec §5).
    expect(d.connections.map((c) => c.relation)).not.toContain('RPC Request from Device');
  });

  it('has FIXED ids, so the migration seed and the function agree', () => {
    const one = defaultRootChainDocument();
    const two = defaultRootChainDocument();
    expect(one).toEqual(two);
    expect(one.nodes.map((n) => n.id)).toEqual([
      DEFAULT_ROOT_CHAIN_NODE_IDS.messageTypeSwitch, DEFAULT_ROOT_CHAIN_NODE_IDS.saveTimeseries,
      DEFAULT_ROOT_CHAIN_NODE_IDS.saveAttributes, DEFAULT_ROOT_CHAIN_NODE_IDS.logOther,
    ]);
    expect(DEFAULT_ROOT_CHAIN_NAME).toBe('Root Rule Chain');
  });

  it('returns a fresh object each call', () => {
    const one = defaultRootChainDocument();
    one.nodes[0].config.mutated = true;
    one.connections.pop();
    expect(defaultRootChainDocument().nodes[0].config.mutated).toBeUndefined();
    expect(defaultRootChainDocument().connections).toHaveLength(3);
  });

  it('saves attributes in the client scope, as ThingsBoard\'s root chain does for device reports', () => {
    const save = defaultRootChainDocument().nodes.find((n) => n.type === 'tb:action:save-attributes')!;
    expect(save.config.scope).toBe('CLIENT_SCOPE');
  });
});

describe('emptyRuleChainDocument', () => {
  it('is version 1 with no nodes, no connections and no first node — and parses', () => {
    expect(emptyRuleChainDocument()).toEqual({ version: RULE_CHAIN_DOCUMENT_VERSION, firstNodeId: null, nodes: [], connections: [] });
    expect(parseRuleChainDocument(emptyRuleChainDocument())).toEqual(emptyRuleChainDocument());
  });
});

describe('parseRuleChainDocument — STRICT (every write)', () => {
  it('accepts a well-formed document', () => {
    expect(parseRuleChainDocument(doc())).toEqual(doc());
  });

  it('refuses an unknown node type, naming the node', () => {
    const msg = parseError(doc({ nodes: [node(A, 'tb:filter:message-type-switch'), node(B, 'tb:filter:nope', { name: 'Mystery' })] }));
    expect(msg).toContain('Mystery');
    expect(msg).toContain('tb:filter:nope');
  });

  it('refuses a built node whose config its schema refuses, naming the node', () => {
    const bad = node(B, 'tb:filter:message-type-filter', { name: 'Only telemetry', config: { messageTypes: 'POST_TELEMETRY_REQUEST' } });
    const msg = parseError(doc({ nodes: [node(A, 'tb:filter:message-type-switch'), bad] }));
    expect(msg).toContain('Only telemetry');
  });

  it('accepts an Unsupported node and a later / none node with any config object', () => {
    const d = doc({
      nodes: [
        node(A, 'tb:filter:message-type-switch'),
        node(B, UNSUPPORTED_NODE_TYPE, { config: { tbClass: 'org.thingsboard.rule.engine.foo.TbFooNode', configuration: { a: 1 } } }),
        node(C, 'tb:action:rpc-call-request', { config: { timeoutInSeconds: 60 } }),
      ],
    });
    expect(parseRuleChainDocument(d)).toEqual(d);
  });

  it('refuses a connection to or from a node that does not exist', () => {
    expect(parseError(doc({ connections: [{ from: A, to: C, relation: 'Other' }] }))).toContain(C);
    expect(parseError(doc({ connections: [{ from: C, to: B, relation: 'Other' }] }))).toContain(C);
  });

  it('refuses two nodes with one id', () => {
    expect(parseError(doc({ nodes: [node(A, 'tb:filter:message-type-switch'), node(A, 'tb:action:log', { name: 'Twin' })], connections: [] })))
      .toContain('Twin');
  });

  it('refuses a firstNodeId that is not a node; null is fine', () => {
    expect(parseError(doc({ firstNodeId: C }))).toContain(C);
    expect(parseRuleChainDocument(doc({ firstNodeId: null })).firstNodeId).toBeNull();
  });

  it('refuses more than RULE_CHAIN_NODES_MAX nodes', () => {
    const many = Array.from({ length: RULE_CHAIN_NODES_MAX + 1 }, (_, i) =>
      node(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'tb:action:log'));
    expect(() => parseRuleChainDocument(doc({ nodes: many, connections: [], firstNodeId: null }))).toThrow(ZodError);
  });

  it('refuses a blank or over-long name, a non-uuid id, a bad debug mode, a non-finite position, a blank relation, a duplicate connection', () => {
    expect(() => parseRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch', { name: '  ' }), node(B, 'tb:action:log')] }))).toThrow(ZodError);
    expect(() => parseRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch', { name: 'x'.repeat(81) }), node(B, 'tb:action:log')] }))).toThrow(ZodError);
    expect(() => parseRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch'), node('not-a-uuid', 'tb:action:log')], connections: [] }))).toThrow(ZodError);
    expect(() => parseRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch', { debugMode: 'loud' as never }), node(B, 'tb:action:log')] }))).toThrow(ZodError);
    expect(() => parseRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch', { x: Number.NaN }), node(B, 'tb:action:log')] }))).toThrow(ZodError);
    expect(() => parseRuleChainDocument(doc({ connections: [{ from: A, to: B, relation: ' ' }] }))).toThrow(ZodError);
    expect(parseError(doc({ connections: [{ from: A, to: B, relation: 'Other' }, { from: A, to: B, relation: 'Other' }] }))).toContain('Other');
  });

  it('refuses a version it does not know', () => {
    expect(() => parseRuleChainDocument({ ...doc(), version: 2 })).toThrow(ZodError);
  });
});

describe('readRuleChainDocument — FORGIVING (every read)', () => {
  it('reads a good document unchanged', () => {
    expect(readRuleChainDocument(doc())).toEqual(doc());
  });

  it('reads an unknown node type as Unsupported, keeping its name, position and what it was', () => {
    const d = readRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch'), node(B, 'tb:filter:nope', { name: 'Mystery', x: 300, y: 40, config: { k: 1 } })] }));
    const b = d.nodes.find((n) => n.id === B)!;
    expect(b).toMatchObject({ type: UNSUPPORTED_NODE_TYPE, name: 'Mystery', x: 300, y: 40 });
    expect(b.config).toMatchObject({ type: 'tb:filter:nope', configuration: { k: 1 } });
    expect(d.connections).toHaveLength(1);
    // … and what it reads always passes the strict parse.
    expect(parseRuleChainDocument(d)).toEqual(d);
  });

  it('reads a built node with a bad config as Unsupported, keeping its ThingsBoard class', () => {
    const d = readRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch'), node(B, 'tb:filter:message-type-filter', { config: { messageTypes: 7 } })] }));
    const b = d.nodes.find((n) => n.id === B)!;
    expect(b.type).toBe(UNSUPPORTED_NODE_TYPE);
    expect(b.config.tbClass).toBe('org.thingsboard.rule.engine.filter.TbMsgTypeFilterNode');
    expect(parseRuleChainDocument(d)).toEqual(d);
  });

  it('drops a dangling connection, a duplicate connection and a duplicate node id', () => {
    const d = readRuleChainDocument(doc({
      nodes: [node(A, 'tb:filter:message-type-switch'), node(B, 'tb:action:log'), node(A, 'tb:action:log', { name: 'Twin' })],
      connections: [{ from: A, to: B, relation: 'Other' }, { from: A, to: B, relation: 'Other' }, { from: A, to: C, relation: 'Other' }],
    }));
    expect(d.nodes.map((n) => n.name)).not.toContain('Twin');
    expect(d.connections).toEqual([{ from: A, to: B, relation: 'Other' }]);
  });

  it('reads a firstNodeId that is not a node as null', () => {
    expect(readRuleChainDocument(doc({ firstNodeId: C })).firstNodeId).toBeNull();
  });

  it('reads garbage as the empty document, never throws', () => {
    for (const v of [null, undefined, 42, 'x', [], { nodes: 'no' }, { nodes: [null, 5, { id: 'bad' }] }]) {
      expect(readRuleChainDocument(v)).toEqual(emptyRuleChainDocument());
    }
  });

  it('repairs a blank name, a bad debug mode and a non-finite position', () => {
    const d = readRuleChainDocument(doc({ nodes: [node(A, 'tb:filter:message-type-switch', { name: '', debugMode: 'loud' as never, x: Number.NaN }), node(B, 'tb:action:log')] }));
    expect(d.nodes[0]).toMatchObject({ name: 'Message type switch', debugMode: 'off', x: 0 });
    expect(parseRuleChainDocument(d)).toEqual(d);
  });
});

describe('ThingsBoard export / import', () => {
  it('exports the ThingsBoard shape', () => {
    const d = defaultRootChainDocument();
    const tb = toThingsboardExport('Root Rule Chain', true, d) as any;
    expect(tb.ruleChain).toMatchObject({ name: 'Root Rule Chain', root: true, debugMode: false });
    expect(tb.metadata.firstNodeIndex).toBe(0);
    expect(tb.metadata.ruleChainConnections).toEqual([]);
    expect(tb.metadata.nodes[0]).toMatchObject({
      type: 'org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode', name: 'Message Type Switch', debugMode: false,
      configuration: { version: 0 }, additionalInfo: { layoutX: d.nodes[0].x, layoutY: d.nodes[0].y },
    });
    expect(tb.metadata.connections).toEqual([
      { fromIndex: 0, toIndex: 1, type: 'Post telemetry' },
      { fromIndex: 0, toIndex: 2, type: 'Post attributes' },
      { fromIndex: 0, toIndex: 3, type: 'Other' },
    ]);
    // Plain JSON — no class instances, no undefined.
    expect(JSON.parse(JSON.stringify(tb))).toEqual(tb);
  });

  it('export → import round-trips the default root chain, with no warnings', () => {
    const d = defaultRootChainDocument();
    const back = fromThingsboardExport(toThingsboardExport('Root Rule Chain', true, d));
    expect(back.name).toBe('Root Rule Chain');
    expect(back.root).toBe(true);
    expect(back.warnings).toEqual([]);
    expect(ruleChainsEqual(back.document, d)).toBe(true);
    expect(parseRuleChainDocument(back.document)).toEqual(back.document);
  });

  it('import mints NEW node ids (importing a file twice must not collide)', () => {
    const tb = toThingsboardExport('Root Rule Chain', true, defaultRootChainDocument());
    const one = fromThingsboardExport(tb).document.nodes.map((n) => n.id);
    const two = fromThingsboardExport(tb).document.nodes.map((n) => n.id);
    expect(one.some((id) => Object.values(DEFAULT_ROOT_CHAIN_NODE_IDS).includes(id as never))).toBe(false);
    expect(one.filter((id) => two.includes(id))).toEqual([]);
    let i = 0;
    const fixed = fromThingsboardExport(tb, { newId: () => `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}` });
    expect(fixed.document.nodes[0].id).toBe('00000000-0000-4000-8000-000000000001');
    expect(fixed.document.firstNodeId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('a ThingsBoard class not in the catalogue imports as Unsupported with ONE warning, and exports back as itself', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.nodes[1] = { type: 'org.thingsboard.rule.engine.custom.TbAcmeNode', name: 'Acme', debugMode: false, configuration: { level: 3 }, additionalInfo: { layoutX: 5, layoutY: 6 } };
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Acme');
    expect(r.warnings[0]).toContain('org.thingsboard.rule.engine.custom.TbAcmeNode');
    const acme = r.document.nodes[1];
    expect(acme).toMatchObject({ type: UNSUPPORTED_NODE_TYPE, name: 'Acme', x: 5, y: 6 });
    expect(acme.config).toEqual({ tbClass: 'org.thingsboard.rule.engine.custom.TbAcmeNode', configuration: { level: 3 } });
    const again = toThingsboardExport('C', false, r.document) as any;
    expect(again.metadata.nodes[1]).toMatchObject({ type: 'org.thingsboard.rule.engine.custom.TbAcmeNode', configuration: { level: 3 } });
  });

  /** ThingsBoard's CE default root chain as master ships it (2026-11-03) — five built nodes and RPC Call Request (later). */
  function tbCeRootChain() {
    const script ="return '\\nIncoming message:\\n' + JSON.stringify(msg) + '\\nIncoming metadata:\\n' + JSON.stringify(metadata);";
    const tb = {
      ruleChain: { additionalInfo: null, name: 'Root Rule Chain', firstRuleNodeId: null, root: true, debugMode: false, configuration: null },
      metadata: {
        firstNodeIndex: 2,
        nodes: [
          { additionalInfo: { layoutX: 999, layoutY: 271 }, type: 'org.thingsboard.rule.engine.telemetry.TbMsgTimeseriesNode', name: 'Save Timeseries', debugFailures: false, debugAll: false, configurationVersion: 1, configuration: { defaultTTL: 0, useServerTs: false, processingSettings: { type: 'ON_EVERY_MESSAGE' } } },
          { additionalInfo: { layoutX: 1000, layoutY: 167 }, type: 'org.thingsboard.rule.engine.telemetry.TbMsgAttributesNode', name: 'Save Attributes', debugFailures: true, debugAll: false, configurationVersion: 3, configuration: { processingSettings: { type: 'ON_EVERY_MESSAGE' }, scope: 'CLIENT_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true } },
          { additionalInfo: { layoutX: 566, layoutY: 302 }, type: 'org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode', name: 'Message Type Switch', debugFailures: false, debugAll: true, configuration: { version: 0 } },
          { additionalInfo: { layoutX: 1000, layoutY: 381 }, type: 'org.thingsboard.rule.engine.action.TbLogNode', name: 'Log RPC from Device', debugFailures: false, debugAll: false, configuration: { scriptLang: 'TBEL', jsScript: script, tbelScript: script } },
          { additionalInfo: { layoutX: 1000, layoutY: 494 }, type: 'org.thingsboard.rule.engine.action.TbLogNode', name: 'Log Other', debugFailures: false, debugAll: false, configuration: { scriptLang: 'TBEL', jsScript: script, tbelScript: script } },
          { additionalInfo: { layoutX: 1000, layoutY: 583 }, type: 'org.thingsboard.rule.engine.rpc.TbSendRPCRequestNode', name: 'RPC Call Request', debugFailures: false, debugAll: false, configuration: { timeoutInSeconds: 60 } },
        ],
        connections: [
          { fromIndex: 2, toIndex: 4, type: 'Other' },
          { fromIndex: 2, toIndex: 1, type: 'Post attributes' },
          { fromIndex: 2, toIndex: 0, type: 'Post telemetry' },
          { fromIndex: 2, toIndex: 3, type: 'RPC Request from Device' },
          { fromIndex: 2, toIndex: 5, type: 'RPC Request to Device' },
        ],
      },
    };
    return tb;
  }

  const NO_COUNTERPART = 'has no counterpart here and will send every message to Failure';
  /** Ruling TB-L (2026-11-05): a TBEL node imports as JavaScript running its TBEL script — one warning per node. */
  const tbelWarning = (name: string, label = 'Log') => `Node "${name}" (${label}): its TBEL script now runs as JavaScript — check it.`;
  const LOG_TBEL_WARNINGS = [tbelWarning('Log RPC from Device'), tbelWarning('Log Other')];

  it('imports ThingsBoard\'s own default root chain: six nodes mapped, 4.x debug flags read, THREE warnings — its two TBEL Log nodes, and RPC Call Request (later)', () => {
    const tb = tbCeRootChain();
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual([...LOG_TBEL_WARNINGS, `Node "RPC Call Request": RPC call request ${NO_COUNTERPART}.`]);
    expect(r.document.nodes.map((n) => n.type)).toEqual([
      'tb:action:save-timeseries', 'tb:action:save-attributes', 'tb:filter:message-type-switch',
      'tb:action:log', 'tb:action:log', 'tb:action:rpc-call-request',
    ]);
    expect(r.document.nodes.map((n) => n.debugMode)).toEqual(['off', 'failures', 'all', 'off', 'off', 'off']);
    expect(r.document.firstNodeId).toBe(r.document.nodes[2].id);
    expect(r.document.connections).toHaveLength(5);
    // ThingsBoard keys we do not model survive the import, untouched.
    expect(r.document.nodes[1].config).toEqual(tb.metadata.nodes[1].configuration);
    expect(parseRuleChainDocument(r.document)).toEqual(r.document);
  });

  it('the same chain with only its built nodes imports with only the two TBEL notes', () => {
    const tb = tbCeRootChain();
    tb.metadata.nodes = tb.metadata.nodes.filter((n) => n.name !== 'RPC Call Request');
    tb.metadata.connections = tb.metadata.connections.filter((c) => c.toIndex !== 5);
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual(LOG_TBEL_WARNINGS);
    expect(r.document.nodes).toHaveLength(5);
  });

  it('a ThingsBoard root chain ENTERED by the Device Profile node imports live: the entry is built, no warning of its own (2026-11-04)', () => {
    // Every ThingsBoard release v3.6–v4.2 ships its root chain this way.
    const tb = tbCeRootChain() as any;
    tb.metadata.nodes = tb.metadata.nodes.filter((n: { name: string }) => n.name !== 'RPC Call Request');
    tb.metadata.connections = tb.metadata.connections.filter((c: { toIndex: number }) => c.toIndex !== 5);
    tb.metadata.nodes.push({
      additionalInfo: { layoutX: 204, layoutY: 240 }, type: 'org.thingsboard.rule.engine.profile.TbDeviceProfileNode',
      name: 'Device Profile Node', debugFailures: false, debugAll: false,
      configuration: { persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: false },
    });
    tb.metadata.connections.push({ fromIndex: 5, toIndex: 2, type: 'Success' });
    tb.metadata.firstNodeIndex = 5;
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual(LOG_TBEL_WARNINGS);
    const entry = r.document.nodes.find((n) => n.id === r.document.firstNodeId)!;
    expect(entry).toMatchObject({ type: 'tb:action:device-profile', name: 'Device Profile Node' });
    expect(entry.config).toEqual({ persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: false });
    const sw = r.document.nodes.find((n) => n.type === 'tb:filter:message-type-switch')!;
    expect(r.document.connections).toContainEqual({ from: entry.id, to: sw.id, relation: 'Success' });
  });

  it('ThingsBoard 3.6.0–3.6.3\'s string-encoded booleans and numbers are read as such, so the node imports BUILT', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.nodes.push(
      // Versions as modelled, so this case is about the strings alone (versions: the CV-1 cases below).
      { type: 'org.thingsboard.rule.engine.telemetry.TbMsgAttributesNode', name: 'Save Attributes', additionalInfo: { layoutX: 1, layoutY: 1 }, configurationVersion: 3,
        configuration: { scope: 'CLIENT_SCOPE', notifyDevice: 'false', sendAttributesUpdatedNotification: 'false', updateAttributesOnlyOnValueChange: 'true' } },
      { type: 'org.thingsboard.rule.engine.telemetry.TbMsgTimeseriesNode', name: 'Save Timeseries', additionalInfo: { layoutX: 2, layoutY: 2 }, configurationVersion: 1,
        configuration: { defaultTTL: '0', useServerTs: 'false' } },
    );
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual([]);
    const [attrs, ts] = r.document.nodes.slice(2);
    expect(attrs.type).toBe('tb:action:save-attributes');
    // (Neither carries processingSettings, so the CV-3 boundary adds ThingsBoard's default form.)
    expect(attrs.config).toEqual({
      scope: 'CLIENT_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true,
      processingSettings: { type: 'ON_EVERY_MESSAGE' },
    });
    expect(ts.type).toBe('tb:action:save-timeseries');
    expect(ts.config).toEqual({ defaultTTL: 0, useServerTs: false, skipLatestPersistence: false, processingSettings: { type: 'ON_EVERY_MESSAGE' } });
    // A string that is not a boolean still does not fit — Unsupported, with the warning.
    tb.metadata.nodes[2].configuration.notifyDevice = 'no';
    const bad = fromThingsboardExport(tb);
    expect(bad.document.nodes[2].type).toBe(UNSUPPORTED_NODE_TYPE);
    expect(bad.warnings).toHaveLength(1);
  });

  // ─── configurationVersion (ruling CV-1, 2026-11-04) ───────────────────────
  const tbNode = (cls: string, name: string, configuration: Record<string, unknown>, configurationVersion?: number) => ({
    type: `org.thingsboard.rule.engine.${cls}`, name, configuration, additionalInfo: { layoutX: 1, layoutY: 1 },
    ...(configurationVersion === undefined ? {} : { configurationVersion }),
  });
  const importNodes = (...nodes: unknown[]) =>
    fromThingsboardExport({ ruleChain: { name: 'V' }, metadata: { firstNodeIndex: null, nodes, connections: [] } });

  it('export writes each built node\'s configurationVersion — the version its catalogue entry models', () => {
    const d = doc({ nodes: [node(A, 'tb:action:save-attributes'), node(B, 'tb:filter:check-relation-presence'), node(C, 'tb:filter:script')], connections: [], firstNodeId: null });
    const tb = toThingsboardExport('C', false, d);
    expect(tb.metadata.nodes.map((n) => n.configurationVersion)).toEqual([3, 1, 0]);
  });

  it('Check relation presence: a v0 export (no configurationVersion) imports with its direction FLIPPED; v1 keeps it', () => {
    const r = importNodes(
      tbNode('filter.TbCheckRelationNode', 'Old', { direction: 'FROM', relationType: 'Contains', checkForSingleEntity: false }),
      tbNode('filter.TbCheckRelationNode', 'New', { direction: 'FROM', relationType: 'Contains', checkForSingleEntity: false }, 1),
    );
    expect(r.warnings).toEqual([]);
    expect(r.document.nodes.map((n) => [n.name, n.config.direction])).toEqual([['Old', 'TO'], ['New', 'FROM']]);
  });

  it('Copy / Delete / Rename keys: v0 and v1 exports import as the v2 configuration, no warning', () => {
    const r = importNodes(
      tbNode('transform.TbCopyKeysNode', 'Copy v0', { fromMetadata: 'true', keys: ['a'] }),
      tbNode('transform.TbCopyKeysNode', 'Copy v1', { fromMetadata: 'DATA', keys: ['a'] }, 1),
      tbNode('transform.TbDeleteKeysNode', 'Delete v1', { dataToFetch: 'METADATA', keys: ['b'] }, 1),
      tbNode('transform.TbRenameKeysNode', 'Rename v0', { fromMetadata: false, renameKeysMapping: { a: 'b' } }),
    );
    expect(r.warnings).toEqual([]);
    expect(r.document.nodes.map((n) => [n.type, n.config])).toEqual([
      ['tb:transformation:copy-key-value-pairs', { keys: ['a'], copyFrom: 'METADATA' }],
      ['tb:transformation:copy-key-value-pairs', { keys: ['a'], copyFrom: 'DATA' }],
      ['tb:transformation:delete-key-value-pairs', { keys: ['b'], deleteFrom: 'METADATA' }],
      ['tb:transformation:rename-keys', { renameKeysMapping: { a: 'b' }, renameIn: 'DATA' }],
    ]);
  });

  it('an older built node whose upgrade is not mirrored (or cannot apply) imports as itself, with ONE warning to review it', () => {
    const r = importNodes(
      tbNode('debug.TbMsgGeneratorNode', 'Generator v0', { periodInSeconds: 1, jsScript: 'return {};' }),  // additive upgrade, not mirrored
      tbNode('filter.TbCheckRelationNode', 'No direction', { relationType: 'Contains' }),                   // the upgrade cannot apply
    );
    expect(r.warnings).toEqual([
      'Node "Generator v0": configuration version 0 is older than 2 — review its settings.',
      'Node "No direction": configuration version 0 is older than 1 — review its settings.',
    ]);
    expect(r.document.nodes.map((n) => n.type)).toEqual(['tb:action:generator', 'tb:filter:check-relation-presence']);
  });

  // ─── Ruling CV-3 (2026-11-05): Save time series / Save attributes and the enrichment upgrades ───
  const ON_EVERY = { type: 'ON_EVERY_MESSAGE' };
  const SKIP_LATEST = {
    type: 'ADVANCED', timeseries: { type: 'ON_EVERY_MESSAGE' }, latest: { type: 'SKIP' },
    webSockets: { type: 'ON_EVERY_MESSAGE' }, calculatedFields: { type: 'ON_EVERY_MESSAGE' },
  };

  it('ThingsBoard 3.6–3.9\'s Save Timeseries (v0) and Save Client Attributes (v2) import with NO warning, upgraded as ThingsBoard upgrades them', () => {
    const r = importNodes(
      tbNode('telemetry.TbMsgTimeseriesNode', 'Save Timeseries', { defaultTTL: 0 }),
      tbNode('telemetry.TbMsgTimeseriesNode', 'History only', { defaultTTL: 0, skipLatestPersistence: true }),
      tbNode('telemetry.TbMsgAttributesNode', 'Save Client Attributes',
        { scope: 'CLIENT_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true }, 2),
      tbNode('telemetry.TbMsgAttributesNode', 'Old save', { scope: 'SERVER_SCOPE' }),                       // v0
    );
    expect(r.warnings).toEqual([]);
    expect(r.document.nodes.map((n) => n.config)).toEqual([
      { defaultTTL: 0, skipLatestPersistence: false, processingSettings: ON_EVERY },
      { defaultTTL: 0, skipLatestPersistence: true, processingSettings: SKIP_LATEST },
      { scope: 'CLIENT_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true, processingSettings: ON_EVERY },
      // ThingsBoard's v0 rules: notifyDevice absent → TRUE, updateAttributesOnlyOnValueChange absent → false.
      { scope: 'SERVER_SCOPE', updateAttributesOnlyOnValueChange: false, notifyDevice: true, sendAttributesUpdatedNotification: false, processingSettings: ON_EVERY },
    ]);
  });

  it('a v1 Save time series: processingSettings sets the toggle; a strategy not built here imports with ONE warning naming it', () => {
    const r = importNodes(
      tbNode('telemetry.TbMsgTimeseriesNode', 'Skip latest', { defaultTTL: 0, useServerTs: false, processingSettings: SKIP_LATEST }, 1),
      tbNode('telemetry.TbMsgTimeseriesNode', 'Dedupe', { defaultTTL: 0, useServerTs: false, processingSettings: { type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 } }, 1),
      tbNode('telemetry.TbMsgAttributesNode', 'Attrs skip', { scope: 'SERVER_SCOPE', processingSettings: { type: 'ADVANCED', attributes: { type: 'SKIP' }, webSockets: ON_EVERY, calculatedFields: ON_EVERY } }, 3),
    );
    expect(r.warnings).toEqual([
      'Node "Dedupe" (Save time series): processing settings not built here (Deduplicate every 60 s) — it saves every reading and updates the latest readings.',
      'Node "Attrs skip" (Save attributes): processing settings not built here (attributes: Skip) — it saves the attributes of every message.',
    ]);
    expect(r.document.nodes.map((n) => n.type)).toEqual(['tb:action:save-timeseries', 'tb:action:save-timeseries', 'tb:action:save-attributes']);
    expect(r.document.nodes.map((n) => n.config.skipLatestPersistence)).toEqual([true, false, undefined]);
    // processingSettings is kept as it came.
    expect(r.document.nodes[1].config.processingSettings).toEqual({ type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 });
  });

  it('export writes Save time series at v1 with NO skipLatestPersistence key and a processingSettings consistent with the toggle', () => {
    const consistent = node(A, 'tb:action:save-timeseries', { config: { defaultTTL: 0, useServerTs: false, skipLatestPersistence: true, processingSettings: SKIP_LATEST } });
    const contradicting = node(B, 'tb:action:save-timeseries', { config: { defaultTTL: 0, useServerTs: false, skipLatestPersistence: true, processingSettings: ON_EVERY } });
    const attrsNoSetting = node(C, 'tb:action:save-attributes', { config: { scope: 'SERVER_SCOPE', notifyDevice: false } });
    const tb = toThingsboardExport('C', false, doc({ nodes: [consistent, contradicting, attrsNoSetting], connections: [], firstNodeId: null }));
    expect(tb.metadata.nodes.map((n) => n.configurationVersion)).toEqual([1, 1, 3]);
    expect(tb.metadata.nodes.map((n) => n.configuration)).toEqual([
      { defaultTTL: 0, useServerTs: false, processingSettings: SKIP_LATEST },
      { defaultTTL: 0, useServerTs: false, processingSettings: SKIP_LATEST },   // ThingsBoard's own v0 → v1 form for "true"
      { scope: 'SERVER_SCOPE', notifyDevice: false, processingSettings: ON_EVERY },
    ]);
    // The stored chain is not touched by an export.
    expect(contradicting.config.processingSettings).toEqual(ON_EVERY);
    expect(contradicting.config.skipLatestPersistence).toBe(true);
  });

  it('import(export(import(x))) is import(x) for every known Save time series strategy (one predicate both ways)', () => {
    for (const ps of [ON_EVERY, SKIP_LATEST, { type: 'WEBSOCKETS_ONLY' }, { type: 'DEDUPLICATE', deduplicationIntervalSecs: 60 }]) {
      const once = importNodes(tbNode('telemetry.TbMsgTimeseriesNode', 'TS', { defaultTTL: 0, useServerTs: false, processingSettings: ps }, 1));
      const twice = fromThingsboardExport(JSON.parse(JSON.stringify(toThingsboardExport('V', false, once.document))));
      expect(ruleChainsEqual(twice.document, once.document), JSON.stringify(ps)).toBe(true);
      expect(twice.warnings, JSON.stringify(ps)).toEqual(once.warnings);
    }
  });

  it('the enrichment nodes\' v0 exports import upgraded, with no warning (fetchToData, addToMetadata, fieldsMapping, attrMapping, fetchMode)', () => {
    const r = importNodes(
      tbNode('metadata.TbGetAttributesNode', 'Attrs', { serverAttributeNames: ['limit'], fetchToData: true, tellFailureIfAbsent: false }),
      tbNode('metadata.TbGetTenantDetailsNode', 'Tenant', { detailsList: ['TITLE'], addToMetadata: true }),
      tbNode('metadata.TbGetOriginatorFieldsNode', 'Fields', { fieldsMapping: { name: 'deviceName' } }),
      tbNode('metadata.TbGetTenantAttributeNode', 'Tenant attrs', { attrMapping: { limit: 'lim' }, telemetry: false }),
      tbNode('metadata.TbGetTelemetryNode', 'Telemetry', { latestTsKeyNames: ['t'], fetchMode: 'LAST', startInterval: 2, endInterval: 1 }, 1),
    );
    expect(r.warnings).toEqual([]);
    expect(r.document.nodes.map((n) => n.type)).toEqual([
      'tb:enrichment:originator-attributes', 'tb:enrichment:tenant-details', 'tb:enrichment:originator-fields',
      'tb:enrichment:tenant-attributes', 'tb:enrichment:originator-telemetry',
    ]);
    expect(r.document.nodes.map((n) => n.config)).toEqual([
      { serverAttributeNames: ['limit'], tellFailureIfAbsent: false, fetchTo: 'DATA' },
      { detailsList: ['TITLE'], fetchTo: 'METADATA' },
      { dataMapping: { name: 'deviceName' }, fetchTo: 'METADATA' },
      { dataMapping: { limit: 'lim' }, dataToFetch: 'ATTRIBUTES', fetchTo: 'METADATA' },
      { latestTsKeyNames: ['t'], fetchMode: 'LAST', startInterval: 2, endInterval: 1, limit: 1000 },
    ]);
  });

  it('EVERY built node round-trips export → import unchanged, with no warning (no upgrade re-applied)', () => {
    const ids = RULE_NODE_TYPES.filter((s) => s.status === 'built').map((s) => s.id);
    const nodes = ids.map((t, i) => node(`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, t, { x: i, y: i }));
    const d: RuleChainDocument = { version: 1, firstNodeId: null, nodes, connections: [] };
    const back = fromThingsboardExport(toThingsboardExport('All', false, d));
    expect(back.warnings).toEqual([]);
    expect(ruleChainsEqual(back.document, d)).toBe(true);
  });

  it('an Unsupported node keeps its source configurationVersion and exports it back', () => {
    const r = importNodes(tbNode('custom.TbAcmeNode', 'Acme', { level: 3 }, 2));
    expect(r.document.nodes[0].config).toEqual({ tbClass: 'org.thingsboard.rule.engine.custom.TbAcmeNode', configuration: { level: 3 }, configurationVersion: 2 });
    expect(toThingsboardExport('C', false, r.document).metadata.nodes[0]).toMatchObject({ type: 'org.thingsboard.rule.engine.custom.TbAcmeNode', configurationVersion: 2 });
  });

  it('a node with no counterpart (status none) warns too — once per node, beside the unknown-class warning', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.nodes.push(
      { type: 'org.thingsboard.rule.engine.edge.TbMsgPushToEdgeNode', name: 'To edge', configuration: {}, additionalInfo: { layoutX: 1, layoutY: 1 } },
      { type: 'org.thingsboard.rule.engine.edge.TbMsgPushToEdgeNode', name: 'To edge again', configuration: {}, additionalInfo: { layoutX: 2, layoutY: 2 } },
      { type: 'org.thingsboard.rule.engine.custom.TbAcmeNode', name: 'Acme', configuration: {}, additionalInfo: { layoutX: 3, layoutY: 3 } },
    );
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual([
      `Node "To edge": Push to edge ${NO_COUNTERPART}.`,
      `Node "To edge again": Push to edge ${NO_COUNTERPART}.`,
      expect.stringContaining('org.thingsboard.rule.engine.custom.TbAcmeNode'),
    ]);
    // It still imports as itself, not as Unsupported.
    expect(r.document.nodes.slice(2, 4).map((n) => n.type)).toEqual(['tb:action:push-to-edge', 'tb:action:push-to-edge']);
  });

  // ─── Ruling SW-1 (2026-11-05): ThingsBoard's entity-type vocabulary at the boundary ───
  it('SW-1: an Entity type switch\'s ThingsBoard labels import as this system\'s (Device → Instrument, Tenant → System) and export back', () => {
    const exp = {
      ruleChain: { name: 'Types' },
      metadata: {
        firstNodeIndex: 0, connections: [
          { fromIndex: 0, toIndex: 1, type: 'Device' }, { fromIndex: 0, toIndex: 2, type: 'Tenant' }, { fromIndex: 0, toIndex: 3, type: 'Alarm' },
          { fromIndex: 1, toIndex: 3, type: 'Success' }, { fromIndex: 4, toIndex: 1, type: 'Device' },
        ],
        nodes: [
          tbNode('filter.TbOriginatorTypeSwitchNode', 'By type', { version: 0 }),
          tbNode('action.TbLogNode', 'Devices', { scriptLang: 'JS', jsScript: 'return "d";' }),
          tbNode('action.TbLogNode', 'Tenant', { scriptLang: 'JS', jsScript: 'return "t";' }),
          tbNode('action.TbLogNode', 'Alarms', { scriptLang: 'JS', jsScript: 'return "a";' }),
          tbNode('filter.TbJsSwitchNode', 'Script switch', { scriptLang: 'JS', jsScript: 'return ["Device"];' }),
        ],
      },
    };
    const imported = fromThingsboardExport(exp);
    expect(imported.warnings).toEqual([]);
    const name = (id: string) => imported.document.nodes.find((n) => n.id === id)!.name;
    expect(imported.document.connections.map((c) => [name(c.from), c.relation, name(c.to)])).toEqual([
      ['By type', 'Instrument', 'Devices'], ['By type', 'System', 'Tenant'], ['By type', 'Alarm', 'Alarms'],
      // Only the SWITCH's labels are mapped: a Log node's Success stays Success.
      ['Devices', 'Success', 'Alarms'],
      // … and a script Switch's own "Device" relation stays "Device" (it is the script's word, not an entity type).
      ['Script switch', 'Device', 'Devices'],
    ]);
    const back = toThingsboardExport('Types', false, imported.document);
    expect(back.metadata.connections.map((c) => c.type)).toEqual(['Device', 'Tenant', 'Alarm', 'Success', 'Device']);
  });

  it('SW-1: a chain authored HERE exports its switch labels and its filter / Generator values in ThingsBoard\'s words, legacy values included', () => {
    const d = doc({
      firstNodeId: A,
      nodes: [
        node(A, 'tb:filter:entity-type-switch'),
        node(B, 'tb:filter:entity-type-filter', { config: { originatorTypes: ['INSTRUMENT', 'SYSTEM'] } }),
        node(C, 'tb:action:generator', { config: { ...RULE_NODE_TYPE_BY_ID.get('tb:action:generator')!.defaultConfig, originatorType: 'INSTRUMENT', originatorId: 'i-1' } }),
      ],
      connections: [{ from: A, to: B, relation: 'Instrument' }, { from: A, to: C, relation: 'System' }, { from: B, to: C, relation: 'True' }],
    });
    const exp = toThingsboardExport('C', false, d);
    expect(exp.metadata.connections.map((c) => c.type)).toEqual(['Device', 'Tenant', 'True']);
    expect(exp.metadata.nodes[1].configuration).toEqual({ originatorTypes: ['DEVICE', 'TENANT'] });
    expect(exp.metadata.nodes[2].configuration).toMatchObject({ originatorType: 'DEVICE', originatorId: 'i-1' });
    // And back: ThingsBoard's values are what is stored now; the switch's labels are this system's again.
    const again = fromThingsboardExport(JSON.parse(JSON.stringify(exp)));
    expect(again.document.connections.map((c) => c.relation)).toEqual(['Instrument', 'System', 'True']);
    expect(again.document.nodes[1].config).toEqual({ originatorTypes: ['DEVICE', 'TENANT'] });
    expect(again.document.nodes[2].config.originatorType).toBe('DEVICE');
  });

  // ─── Ruling DP-1 (2026-11-05): a connection a node can NEVER take is named on import ───
  it('DP-1: a connection whose label the source node never sends imports with ONE warning per connection, naming node and label', () => {
    const r = fromThingsboardExport({
      ruleChain: { name: 'Dead ends' },
      metadata: {
        firstNodeIndex: 0,
        nodes: [
          tbNode('filter.TbOriginatorTypeSwitchNode', 'By type', { version: 0 }),
          tbNode('action.TbLogNode', 'Log', { scriptLang: 'JS', jsScript: 'return "x";' }),
          tbNode('filter.TbJsFilterNode', 'Hot?', { scriptLang: 'JS', jsScript: 'return msg.t > 30;' }),
          tbNode('flow.TbRuleChainOutputNode', 'Out', { version: 0 }),
        ],
        connections: [
          { fromIndex: 0, toIndex: 1, type: 'Device' },   // mapped by SW-1 first: taken, no warning
          { fromIndex: 0, toIndex: 1, type: 'Asset' },    // there are no assets here
          { fromIndex: 1, toIndex: 2, type: 'True' },     // a Log node sends Success / Failure only
          { fromIndex: 2, toIndex: 1, type: 'Success' },  // a filter sends True / False / Failure
          { fromIndex: 2, toIndex: 3, type: 'True' },
          { fromIndex: 3, toIndex: 1, type: 'Success' },  // an Output ends the chain
        ],
      },
    });
    expect(r.warnings).toEqual([
      'Node "By type" (Entity type switch): its "Asset" connection to "Log" is never taken — it sends only Instrument, Alarm, User, System, Rule node, Failure.',
      'Node "Log" (Log): its "True" connection to "Hot?" is never taken — it sends only Success, Failure.',
      'Node "Hot?" (Script): its "Success" connection to "Log" is never taken — it sends only True, False, Failure.',
      'Node "Out" (Output): its "Success" connection to "Log" is never taken — it sends nothing on.',
    ]);
    // Every connection is still imported (and exported back): the warning names it, nothing is dropped.
    expect(r.document.connections).toHaveLength(6);
  });

  it('DP-1: ThingsBoard\'s Device Profile alarm branches import WITHOUT a warning — the node sends Alarm Created / Updated / Severity Updated / Cleared', () => {
    const r = fromThingsboardExport({
      ruleChain: { name: 'Profile alarms' },
      metadata: {
        firstNodeIndex: 0,
        nodes: [
          tbNode('profile.TbDeviceProfileNode', 'Device Profile Node', { persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: false }, 1),
          tbNode('action.TbLogNode', 'Notify', { scriptLang: 'JS', jsScript: 'return "x";' }),
        ],
        connections: ['Alarm Created', 'Alarm Updated', 'Alarm Severity Updated', 'Alarm Cleared', 'Success'].map((type) => ({ fromIndex: 0, toIndex: 1, type })),
      },
    });
    expect(r.warnings).toEqual([]);
    expect(r.document.connections.map((c) => c.relation)).toEqual(['Alarm Created', 'Alarm Updated', 'Alarm Severity Updated', 'Alarm Cleared', 'Success']);
  });

  it('DP-1: a node that names its relations at run time (Switch, Device profile switch, Rule chain) never warns; nor does a later / none node, whose own warning already says every message goes to Failure', () => {
    const r = fromThingsboardExport({
      ruleChain: { name: 'Dynamic' },
      metadata: {
        firstNodeIndex: 0,
        nodes: [
          tbNode('filter.TbJsSwitchNode', 'Script switch', { scriptLang: 'JS', jsScript: 'return ["anything"];' }),
          tbNode('filter.TbDeviceTypeSwitchNode', 'By profile', { version: 0 }),
          tbNode('flow.TbRuleChainInputNode', 'To chain', { ruleChainId: null, forwardMsgToDefaultRuleChain: false }, 1),
          tbNode('edge.TbMsgPushToEdgeNode', 'To edge', {}),
          tbNode('action.TbLogNode', 'Log', { scriptLang: 'JS', jsScript: 'return "x";' }),
        ],
        connections: [
          { fromIndex: 0, toIndex: 4, type: 'anything' }, { fromIndex: 1, toIndex: 4, type: 'Thermohygrometer' },
          { fromIndex: 2, toIndex: 4, type: 'Done' }, { fromIndex: 3, toIndex: 4, type: 'Success' },
        ],
      },
    });
    expect(r.warnings).toEqual([`Node "To edge": Push to edge ${NO_COUNTERPART}.`]);
    expect(r.document.connections).toHaveLength(4);
  });

  // ─── Rulings SW-2 / M-7 (2026-11-05) ───
  it('SW-2: the export\'s ruleChain.additionalInfo.description names each node ThingsBoard cannot start and what to set there (ThingsBoard\'s rule chain Description)', () => {
    const U = '0f9c5ce9-1111-4222-8333-444455556666';
    const d = doc({
      firstNodeId: A,
      nodes: [
        node(A, 'tb:external:send-notification', { name: 'Notify QA', config: { templateId: U, targets: { roles: ['QA'], userIds: [] } } }),
        node(B, 'tb:flow:rule-chain', { name: 'To escalation', config: { ruleChainId: U, forwardMsgToDefaultRuleChain: false } }),
        node(C, 'tb:action:log', { name: 'Log' }),
      ],
      connections: [],
    });
    const exp = toThingsboardExport('Escalation', false, d);
    expect(exp.ruleChain.additionalInfo).toEqual({
      description: [
        'Set in ThingsBoard when you import this chain:',
        '- Node "Notify QA" (Send notification): choose its notification template and recipients after import — this system\'s template, roles and users do not exist there; until then ThingsBoard keeps the node but cannot start it.',
        `- Node "To escalation" (Rule chain): choose the rule chain it sends to after import — rule chain ${U} is this system's.`,
      ].join('\n'),
    });
    // The nodes still go out — nothing is dropped.
    expect(exp.metadata.nodes.map((n) => n.name)).toEqual(['Notify QA', 'To escalation', 'Log']);
  });

  it('SW-2: the notes judge what ThingsBoard RECEIVES — a Generator stored as INSTRUMENT (before SW-1) goes out as DEVICE and is named', () => {
    const d = doc({
      firstNodeId: A, connections: [],
      nodes: [node(A, 'tb:action:generator', { name: 'Gen', config: { ...RULE_NODE_TYPE_BY_ID.get('tb:action:generator')!.defaultConfig, originatorType: 'INSTRUMENT', originatorId: 'i-7' } })],
    });
    expect(toThingsboardExport('C', false, d).ruleChain.additionalInfo?.description)
      .toBe('Set in ThingsBoard when you import this chain:\n- Node "Gen" (Generator): choose the device it generates messages for after import — instrument i-7 is this system\'s.');
  });

  it('SW-2: a chain ThingsBoard can run as it stands carries NO description (additionalInfo stays null)', () => {
    expect(toThingsboardExport('C', false, doc()).ruleChain.additionalInfo).toBeNull();
    expect(toThingsboardExport('Root Rule Chain', true, defaultRootChainDocument()).ruleChain.additionalInfo).toBeNull();
  });

  it('M-7: an import warns once per node for an id that came with the file and for a setting not honoured here', () => {
    const U = '0f9c5ce9-1111-4222-8333-444455556666';
    const r = importNodes(
      tbNode('flow.TbRuleChainInputNode', 'To chain', { ruleChainId: U, forwardMsgToDefaultRuleChain: false }, 1),
      tbNode('debug.TbMsgGeneratorNode', 'Gen', { msgCount: 0, periodInSeconds: 5, originatorType: 'DEVICE', originatorId: U, scriptLang: 'JS', jsScript: 'return {};' }, 2),
      tbNode('filter.TbCheckRelationNode', 'Has gateway', { direction: 'TO', relationType: 'Contains', checkForSingleEntity: true, entityType: 'DEVICE', entityId: U }, 1),
      tbNode('mail.TbSendEmailNode', 'Mail', { useSystemSmtpSettings: false, smtpHost: 'mail.plant', smtpPort: 25, enableProxy: false }),
      tbNode('sms.TbSendSmsNode', 'Text', { numbersToTemplate: '${phone}', smsMessageTemplate: 'Hi', useSystemSmsSettings: false }),
      tbNode('rest.TbRestApiCallNode', 'Call', { restEndpointUrlPattern: 'http://x/api', requestMethod: 'POST', enableProxy: true, proxyHost: 'proxy', proxyPort: 3128 }, 4),
    );
    expect(r.warnings).toEqual([
      `Node "To chain" (Rule chain): rule chain ${U} came with the file — a ThingsBoard rule chain id (or another installation's) does not exist here; choose the rule chain it sends to.`,
      `Node "Gen" (Generator): instrument ${U} came with the file — a ThingsBoard device id (or another installation's) does not exist here; choose the instrument.`,
      `Node "Has gateway" (Check relation presence): entity ${U} came with the file — a ThingsBoard device id (or another installation's) does not exist here; choose the instrument to check.`,
      'Node "Mail" (Send email): it was set to its own SMTP server; here it sends through this system\'s email settings (Configuration → Email).',
      'Node "Text" (Send SMS): it was set to its own SMS provider; here it sends through this system\'s SMS settings (Configuration → SMS).',
      'Node "Call" (REST API call): its proxy is not used here — it calls the endpoint directly.',
    ]);
    expect(r.document.nodes.every((n) => n.type !== UNSUPPORTED_NODE_TYPE)).toBe(true);
  });

  it('M-7: ThingsBoard\'s Send notification (templateId an object) does not fit here — imported as Unsupported with ONE warning, not two', () => {
    const r = importNodes(tbNode('notification.TbNotificationNode', 'Notify', {
      templateId: { entityType: 'NOTIFICATION_TEMPLATE', id: '0f9c5ce9-1111-4222-8333-444455556666' }, targets: ['0f9c5ce9-1111-4222-8333-444455556666'],
    }));
    expect(r.document.nodes[0].type).toBe(UNSUPPORTED_NODE_TYPE);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^Node "Notify" \(Send notification\): its configuration does not fit here \(templateId/);
  });

  it('reads ThingsBoard 3.x "debugMode: true" as debug all', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    delete tb.metadata.nodes[0].debugAll;
    delete tb.metadata.nodes[0].debugFailures;
    tb.metadata.nodes[0].debugMode = true;
    expect(fromThingsboardExport(tb).document.nodes[0].debugMode).toBe('all');
  });

  it('round-trips each debug mode', () => {
    const d = doc({ nodes: [node(A, 'tb:filter:message-type-switch', { debugMode: 'all' }), node(B, 'tb:action:log', { debugMode: 'failures' })] });
    expect(ruleChainsEqual(fromThingsboardExport(toThingsboardExport('C', false, d)).document, d)).toBe(true);
  });

  it('TB-L: a TBEL node imports as JavaScript running its TBEL script, with ONE warning; its export is JavaScript and re-imports silently', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.nodes[1].configuration = { scriptLang: 'TBEL', jsScript: 'return "js";', tbelScript: 'return "tbel" + 1;' };
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual([tbelWarning('Log')]);
    expect(r.document.nodes[1]).toMatchObject({ type: 'tb:action:log', config: { scriptLang: 'JS', jsScript: 'return "tbel" + 1;' } });
    expect(r.document.nodes[1].config).not.toHaveProperty('tbelScript');
    const out = toThingsboardExport('C', false, r.document).metadata.nodes[1].configuration;
    expect(out).toEqual({ scriptLang: 'JS', jsScript: 'return "tbel" + 1;' });
    const again = fromThingsboardExport(JSON.parse(JSON.stringify(toThingsboardExport('C', false, r.document))));
    expect(again.warnings).toEqual([]);
    expect(ruleChainsEqual(again.document, r.document)).toBe(true);
  });

  it('TB-L: every one of the seven script nodes, at ThingsBoard\'s TBEL default, imports as JavaScript with one warning each', () => {
    const scripted: [string, string, Record<string, unknown>][] = [
      ['filter.TbJsFilterNode', 'Script', {}],
      ['filter.TbJsSwitchNode', 'Switch', {}],
      ['transform.TbTransformMsgNode', 'Script', {}],
      ['action.TbLogNode', 'Log', {}],
      ['debug.TbMsgGeneratorNode', 'Generator', { msgCount: 0, periodInSeconds: 1, originatorType: 'RULE_NODE' }],
      ['action.TbCreateAlarmNode', 'Create alarm', { alarmType: 'General Alarm', severity: 'CRITICAL' }],
      ['action.TbClearAlarmNode', 'Clear alarm', { alarmType: 'General Alarm' }],
    ];
    const nodes = scripted.map(([cls, , extra], i) => {
      const alarm = cls.includes('Alarm');
      const scripts = alarm
        ? { alarmDetailsBuildJs: 'return {js: 1};', alarmDetailsBuildTbel: `return {n: ${i}};` }
        : { jsScript: 'return {};', tbelScript: `return {n: ${i}};` };
      return tbNode(cls, `N${i}`, { ...extra, scriptLang: 'TBEL', ...scripts },
        RULE_NODE_TYPE_BY_TB_CLASS.get(`org.thingsboard.rule.engine.${cls}`)!.tbConfigurationVersion ?? 0);
    });
    const r = importNodes(...nodes);
    expect(r.warnings).toEqual(scripted.map(([, label], i) => tbelWarning(`N${i}`, label)));
    r.document.nodes.forEach((n, i) => {
      const [jsKey, tbelKey] = RULE_SCRIPT_KEYS[n.type];
      expect(n.config.scriptLang, n.name).toBe('JS');
      expect(n.config[jsKey], n.name).toBe(`return {n: ${i}};`);
      expect(n.config, n.name).not.toHaveProperty(tbelKey);
    });
  });

  it('TB-L: a document stored BEFORE the rule (still TBEL) exports its TBEL script as the JavaScript one — what runs is what goes out', () => {
    const legacy = doc({ nodes: [node(A, 'tb:action:log', { config: { scriptLang: 'TBEL', jsScript: 'old', tbelScript: 'ran' } }), node(B, 'tb:action:log')] });
    expect(toThingsboardExport('C', false, legacy).metadata.nodes[0].configuration).toEqual({ scriptLang: 'JS', jsScript: 'ran' });
  });

  it('a known class whose configuration does not fit imports as Unsupported with a warning (never refuses the file)', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.nodes[1] = { type: 'org.thingsboard.rule.engine.filter.TbMsgTypeFilterNode', name: 'Odd filter', debugMode: false, configuration: { messageTypes: 'nope' }, additionalInfo: { layoutX: 1, layoutY: 2 } };
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Odd filter');
    expect(r.document.nodes[1]).toMatchObject({ type: UNSUPPORTED_NODE_TYPE, config: { tbClass: 'org.thingsboard.rule.engine.filter.TbMsgTypeFilterNode', configuration: { messageTypes: 'nope' } } });
  });

  it('drops a connection with a bad index or no label, with a warning each', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.connections.push({ fromIndex: 0, toIndex: 9, type: 'Other' }, { fromIndex: 0, toIndex: 1 });
    const r = fromThingsboardExport(tb);
    expect(r.document.connections).toHaveLength(1);
    expect(r.warnings).toHaveLength(2);
  });

  it('accepts the export as a JSON string too, and refuses something that is not a rule chain export', () => {
    const s = JSON.stringify(toThingsboardExport('C', false, doc()));
    expect(fromThingsboardExport(s).document.nodes).toHaveLength(2);
    expect(() => fromThingsboardExport({ hello: 'world' })).toThrow();
    expect(() => fromThingsboardExport('{not json')).toThrow();
  });

  it('refuses an export with more nodes than a chain may hold', () => {
    const many = Array.from({ length: RULE_CHAIN_NODES_MAX + 1 }, (_, i) => ({ type: 'org.thingsboard.rule.engine.action.TbLogNode', name: `L${i}`, configuration: { jsScript: 'return "x";' } }));
    expect(() => fromThingsboardExport({ ruleChain: { name: 'Big' }, metadata: { firstNodeIndex: null, nodes: many, connections: [] } })).toThrow(/300/);
  });
});

describe('ruleChainsEqual — structure, not ids', () => {
  it('two documents equal up to node ids are equal', () => {
    const d = doc();
    const remapped: RuleChainDocument = {
      ...d,
      firstNodeId: C,
      nodes: [{ ...d.nodes[0], id: C }, d.nodes[1]],
      connections: [{ from: C, to: B, relation: 'Other' }],
    };
    expect(ruleChainsEqual(d, remapped)).toBe(true);
  });

  it('a different config value, relation, name, position, debug mode, node order or first node is a difference', () => {
    const d = doc();
    const variants: RuleChainDocument[] = [
      { ...d, nodes: [d.nodes[0], { ...d.nodes[1], config: { ...d.nodes[1].config, jsScript: 'return "y";' } }] },
      { ...d, connections: [{ from: A, to: B, relation: 'Post telemetry' }] },
      { ...d, nodes: [d.nodes[0], { ...d.nodes[1], name: 'Other log' }] },
      { ...d, nodes: [d.nodes[0], { ...d.nodes[1], x: 11 }] },
      { ...d, nodes: [d.nodes[0], { ...d.nodes[1], debugMode: 'all' }] },
      { ...d, nodes: [d.nodes[1], d.nodes[0]] },
      { ...d, firstNodeId: B },
      { ...d, connections: [] },
    ];
    for (const v of variants) expect(ruleChainsEqual(d, v)).toBe(false);
  });

  it('config key order does not matter', () => {
    const d = doc();
    const reordered = { ...d, nodes: [d.nodes[0], { ...d.nodes[1], config: Object.fromEntries(Object.entries(d.nodes[1].config).reverse()) }] };
    expect(ruleChainsEqual(d, reordered)).toBe(true);
  });
});
