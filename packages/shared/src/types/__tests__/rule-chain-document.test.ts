import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  RULE_CHAIN_DOCUMENT_VERSION, DEFAULT_ROOT_CHAIN_NAME, DEFAULT_ROOT_CHAIN_NODE_IDS,
  parseRuleChainDocument, readRuleChainDocument, emptyRuleChainDocument, defaultRootChainDocument,
  toThingsboardExport, fromThingsboardExport, ruleChainsEqual,
  type RuleChainDocument,
} from '../rule-chain-document.js';
import { RULE_NODE_TYPE_BY_ID, UNSUPPORTED_NODE_TYPE, RULE_CHAIN_NODES_MAX } from '../rule-nodes.js';

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

  it('imports ThingsBoard\'s own default root chain: six nodes mapped, 4.x debug flags read, ONE warning — the RPC Call Request (later)', () => {
    const tb = tbCeRootChain();
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual([`Node "RPC Call Request": RPC call request ${NO_COUNTERPART}.`]);
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

  it('the same chain with only its built nodes imports with no warnings', () => {
    const tb = tbCeRootChain();
    tb.metadata.nodes = tb.metadata.nodes.filter((n) => n.name !== 'RPC Call Request');
    tb.metadata.connections = tb.metadata.connections.filter((c) => c.toIndex !== 5);
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual([]);
    expect(r.document.nodes).toHaveLength(5);
  });

  it('a ThingsBoard root chain ENTERED by the Device Profile node imports live: the entry is built, no warning (2026-11-04)', () => {
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
    expect(r.warnings).toEqual([]);
    const entry = r.document.nodes.find((n) => n.id === r.document.firstNodeId)!;
    expect(entry).toMatchObject({ type: 'tb:action:device-profile', name: 'Device Profile Node' });
    expect(entry.config).toEqual({ persistAlarmRulesState: false, fetchAlarmRulesStateOnStart: false });
    const sw = r.document.nodes.find((n) => n.type === 'tb:filter:message-type-switch')!;
    expect(r.document.connections).toContainEqual({ from: entry.id, to: sw.id, relation: 'Success' });
  });

  it('ThingsBoard 3.6.0–3.6.3\'s string-encoded booleans and numbers are read as such, so the node imports BUILT', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.nodes.push(
      { type: 'org.thingsboard.rule.engine.telemetry.TbMsgAttributesNode', name: 'Save Attributes', additionalInfo: { layoutX: 1, layoutY: 1 },
        configuration: { scope: 'CLIENT_SCOPE', notifyDevice: 'false', sendAttributesUpdatedNotification: 'false', updateAttributesOnlyOnValueChange: 'true' } },
      { type: 'org.thingsboard.rule.engine.telemetry.TbMsgTimeseriesNode', name: 'Save Timeseries', additionalInfo: { layoutX: 2, layoutY: 2 },
        configuration: { defaultTTL: '0', useServerTs: 'false' } },
    );
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toEqual([]);
    const [attrs, ts] = r.document.nodes.slice(2);
    expect(attrs.type).toBe('tb:action:save-attributes');
    expect(attrs.config).toEqual({ scope: 'CLIENT_SCOPE', notifyDevice: false, sendAttributesUpdatedNotification: false, updateAttributesOnlyOnValueChange: true });
    expect(ts.type).toBe('tb:action:save-timeseries');
    expect(ts.config).toEqual({ defaultTTL: 0, useServerTs: false });
    // A string that is not a boolean still does not fit — Unsupported, with the warning.
    tb.metadata.nodes[2].configuration.notifyDevice = 'no';
    const bad = fromThingsboardExport(tb);
    expect(bad.document.nodes[2].type).toBe(UNSUPPORTED_NODE_TYPE);
    expect(bad.warnings).toHaveLength(1);
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

  it('warns when a TBEL script differs from the JavaScript one that will run', () => {
    const tb = toThingsboardExport('C', false, doc()) as any;
    tb.metadata.nodes[1].configuration = { scriptLang: 'TBEL', jsScript: 'return "js";', tbelScript: 'return "tbel" + 1;' };
    const r = fromThingsboardExport(tb);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('TBEL');
    expect(r.document.nodes[1].type).toBe('tb:action:log');
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
