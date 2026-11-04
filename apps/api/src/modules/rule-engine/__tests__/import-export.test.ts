import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defaultRootChainDocument, messageTypeSwitchLabel, toThingsboardExport, fromThingsboardExport, parseRuleChainDocument, ruleChainsEqual,
  newRuleNodeConfig, RULE_NODE_TYPE_BY_TB_CLASS, UNSUPPORTED_NODE_TYPE, DEFAULT_ROOT_CHAIN_NODE_IDS, type RuleChainDocument,
} from '@digilog/shared';
import { importChain, exportChain, MASKED_SECRET } from '../import-export.js';
import { createRuleEngine } from '../engine.js';
import { registerNode } from '../registry.js';
import { newMessage } from '../message.js';
import { chainOf, memoryDeps, fakeServices } from '../../../test-support/rule-engine.js';

/**
 * A chain exported to ThingsBoard JSON and imported back RUNS (Task 3): the
 * engine routes it by the imported node types and relation labels exactly as
 * it routes the shipped one. And the capacity claim of spec §6: 1,000
 * messages through the shipped root chain in under 2 s.
 *
 * The shipped chain's four node types have no handlers until Tasks 4 / 5, so
 * the stand-ins here do what those nodes do to ROUTING: the Message Type
 * Switch answers ThingsBoard's label for the type; the Save / Log nodes end
 * the message. The throughput figure is therefore the ENGINE's cost (queue,
 * routing, copies, contexts) — not a database write per message.
 */
const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

function standIns(hits: Record<string, number>) {
  const end = (name: string) => () => { hits[name] = (hits[name] ?? 0) + 1; };
  restores.push(registerNode('tb:filter:message-type-switch', (ctx, msg) => ctx.tellNext(msg, messageTypeSwitchLabel(msg.type))));
  restores.push(registerNode('tb:action:save-timeseries', end('timeseries')));
  restores.push(registerNode('tb:action:save-attributes', end('attributes')));
  restores.push(registerNode('tb:action:log', end('log')));
}

function importedRoot() {
  const exported = toThingsboardExport('Root Rule Chain', true, defaultRootChainDocument());
  const imported = importChain(JSON.parse(JSON.stringify(exported)));
  expect(imported.warnings).toEqual([]);
  return chainOf(imported.name, imported.document, { root: true, strict: true });
}

const telemetry = (instrument: string, i: number) =>
  newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: instrument }, { ts: i, values: { t: i } }, { ts: String(i) });

describe('an imported ThingsBoard chain runs', () => {
  it('routes by the imported types and labels: telemetry → Save Timeseries, attributes → Save Attributes, other → Log', async () => {
    const hits: Record<string, number> = {};
    standIns(hits);
    const root = importedRoot();
    // Import mints fresh node ids; the routing is by label, not by the shipped ids.
    expect(root.document.nodes.map((n) => n.id)).not.toContain(DEFAULT_ROOT_CHAIN_NODE_IDS.messageTypeSwitch);
    const mem = memoryDeps([root]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.processNow(telemetry('i1', 1));
    await engine.processNow(newMessage('POST_ATTRIBUTES_REQUEST', { type: 'INSTRUMENT', id: 'i1' }, { a: '1' }));
    // A type ThingsBoard has no label for is "Other" → Log.
    await engine.processNow(newMessage('MY_CUSTOM_EVENT', { type: 'INSTRUMENT', id: 'i1' }, {}));
    // ENTITY_CREATED ("Entity Created") and ALARM ("Alarm") HAVE labels, and the
    // default chain connects neither: they end at the switch.
    await engine.processNow(newMessage('ENTITY_CREATED', { type: 'INSTRUMENT', id: 'i1' }, {}));
    await engine.processNow(newMessage('ALARM', { type: 'ALARM', id: 'a1' }, {}));
    expect(hits).toEqual({ timeseries: 1, attributes: 1, log: 1 });
  });
});

describe('capacity (spec §6)', () => {
  it('1,000 messages from 320 instruments through the shipped root chain in under 2 s', async () => {
    const hits: Record<string, number> = {};
    standIns(hits);
    const root = chainOf('Root Rule Chain', defaultRootChainDocument(), { root: true, strict: true });
    const mem = memoryDeps([root]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      const started = performance.now();
      for (let i = 0; i < 1_000; i++) expect(engine.enqueue(telemetry(`inst-${i % 320}`, i))).toBe(true);
      await engine.drain();
      const ms = performance.now() - started;
      expect(hits.timeseries).toBe(1_000);
      expect(engine.stats().processedLastMinute).toBe(1_000);
      expect(engine.stats().dropped).toBe(0);
      // Reported in the task report; the bound is the spec's.
      console.log(`[rule-engine throughput] 1000 messages through the shipped root chain: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(2_000);
    } finally {
      await engine.stop();
    }
  });
});

// ─── ThingsBoard's REAL default root chain (Task 6) ──────────────────────────
//
// `fixtures/thingsboard-root-chain-3.x.json` is ThingsBoard's own tenant root
// chain, byte for byte: github.com/thingsboard/thingsboard, tag v3.6.4,
// `application/src/main/data/json/tenant/rule_chains/root_rule_chain.json`
// (sha256 099e78f7…c53a328). Every release from 3.6 to 4.2 ships SEVEN nodes,
// the entry being the Device Profile Node (`TbDeviceProfileNode` — no
// counterpart here) in front of the Message Type Switch; 3.6.4 is the 3.x
// shape (`debugMode`, plain booleans).
const FIXTURE_TEXT = readFileSync(new URL('./fixtures/thingsboard-root-chain-3.x.json', import.meta.url), 'utf8');
type TbNode = { type: string; name: string; configuration: unknown; additionalInfo: { layoutX: number; layoutY: number } };
type TbExport = { ruleChain: { name: string; root: boolean }; metadata: { firstNodeIndex: number; nodes: TbNode[]; connections: { fromIndex: number; toIndex: number; type: string }[] } };
const fixture = (): TbExport => JSON.parse(FIXTURE_TEXT) as TbExport;

/** The fixture without the named nodes; indices re-numbered, connections touching them dropped, `first` the new entry. */
function without(tb: TbExport, names: string[], first: string): TbExport {
  const keep = tb.metadata.nodes.map((n, i) => ({ n, i })).filter(({ n }) => !names.includes(n.name));
  const at = new Map(keep.map(({ i }, j) => [i, j]));
  return {
    ...tb,
    metadata: {
      ...tb.metadata,
      nodes: keep.map(({ n }) => n),
      connections: tb.metadata.connections.filter((c) => at.has(c.fromIndex) && at.has(c.toIndex))
        .map((c) => ({ ...c, fromIndex: at.get(c.fromIndex)!, toIndex: at.get(c.toIndex)! })),
      firstNodeIndex: keep.findIndex(({ n }) => n.name === first),
    },
  };
}

const NO_COUNTERPART = 'has no counterpart here and will send every message to Failure';
const RPC_WARNING = `Node "RPC Call Request": RPC call request ${NO_COUNTERPART}.`;
const DEVICE_PROFILE_WARNING = `Node "Device Profile Node": Device profile (deprecated) ${NO_COUNTERPART}.`;

describe('ThingsBoard\'s real root chain export (v3.6.4 fixture)', () => {
  it('imports every node mapped to its catalogue type, with ONE warning per node that has no handler here: RPC Call Request and Device Profile Node', () => {
    const tb = fixture();
    const r = importChain(tb);
    expect(r.name).toBe('Root Rule Chain');
    expect(r.document.nodes.map((n) => [n.type, n.name])).toEqual([
      ['tb:action:save-timeseries', 'Save Timeseries'],
      ['tb:action:save-attributes', 'Save Client Attributes'],
      ['tb:filter:message-type-switch', 'Message Type Switch'],
      ['tb:action:log', 'Log RPC from Device'],
      ['tb:action:log', 'Log Other'],
      ['tb:action:rpc-call-request', 'RPC Call Request'],
      ['tb:action:device-profile', 'Device Profile Node'],
    ]);
    expect(r.document.nodes.some((n) => n.type === UNSUPPORTED_NODE_TYPE)).toBe(false);
    expect(r.warnings).toEqual([RPC_WARNING, DEVICE_PROFILE_WARNING]);
    // The entry is the Device Profile Node, as in ThingsBoard.
    expect(r.document.firstNodeId).toBe(r.document.nodes[6].id);
    expect(r.document.nodes.map((n) => [n.x, n.y])).toEqual(tb.metadata.nodes.map((n) => [n.additionalInfo.layoutX, n.additionalInfo.layoutY]));
    expect(r.document.nodes.every((n) => n.debugMode === 'off')).toBe(true);
    const name = (id: string) => r.document.nodes.find((n) => n.id === id)!.name;
    expect(r.document.connections.map((c) => [name(c.from), c.relation, name(c.to)])).toEqual([
      ['Device Profile Node', 'Success', 'Message Type Switch'],
      ['Message Type Switch', 'Other', 'Log Other'],
      ['Message Type Switch', 'Post attributes', 'Save Client Attributes'],
      ['Message Type Switch', 'Post telemetry', 'Save Timeseries'],
      ['Message Type Switch', 'RPC Request from Device', 'Log RPC from Device'],
      ['Message Type Switch', 'RPC Request to Device', 'RPC Call Request'],
    ]);
    // ThingsBoard's configurations come through untouched (unmodelled keys included).
    r.document.nodes.forEach((n, i) => expect(n.config, n.name).toEqual(tb.metadata.nodes[i].configuration));
    expect(parseRuleChainDocument(r.document)).toEqual(r.document);
  });

  it('without its Device Profile Node (the switch as the entry) it imports with exactly ONE warning — the RPC Call Request', () => {
    const r = importChain(without(fixture(), ['Device Profile Node'], 'Message Type Switch'));
    expect(r.warnings).toEqual([RPC_WARNING]);
    expect(r.document.nodes).toHaveLength(6);
    expect(r.document.firstNodeId).toBe(r.document.nodes.find((n) => n.name === 'Message Type Switch')!.id);
  });

  it('with only its built nodes it imports with no warning at all', () => {
    const r = importChain(without(fixture(), ['Device Profile Node', 'RPC Call Request'], 'Message Type Switch'));
    expect(r.warnings).toEqual([]);
    expect(r.document.nodes).toHaveLength(5);
    expect(r.document.connections).toHaveLength(4);
  });

  it('a class the catalogue does not know (a ThingsBoard PE node) imports as Unsupported with one more warning, and exports back as itself', () => {
    const cls = 'org.thingsboard.rule.engine.analytics.incoming.TbSimpleAggMsgNode';
    expect(RULE_NODE_TYPE_BY_TB_CLASS.has(cls)).toBe(false);
    const tb = fixture();
    tb.metadata.nodes.push({ type: cls, name: 'Aggregate stream', configuration: { interval: 60 }, additionalInfo: { layoutX: 10, layoutY: 20 } });
    const r = importChain(tb);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.slice(0, 2)).toEqual([RPC_WARNING, DEVICE_PROFILE_WARNING]);
    expect(r.warnings[2]).toContain('Aggregate stream');
    expect(r.warnings[2]).toContain(cls);
    expect(r.document.nodes[7]).toMatchObject({ type: UNSUPPORTED_NODE_TYPE, name: 'Aggregate stream', config: { tbClass: cls, configuration: { interval: 60 } } });
    expect(toThingsboardExport('C', false, r.document).metadata.nodes[7]).toMatchObject({ type: cls, configuration: { interval: 60 } });
  });

  it('export → import is the same chain: classes, configurations, connections and the entry survive', () => {
    const first = importChain(fixture()).document;
    const exported = toThingsboardExport('Root Rule Chain', true, first);
    expect(exported.metadata.nodes.map((n) => n.type)).toEqual(fixture().metadata.nodes.map((n) => n.type));
    expect(exported.metadata.firstNodeIndex).toBe(fixture().metadata.firstNodeIndex);
    expect(exported.metadata.connections).toEqual(fixture().metadata.connections);
    const again = fromThingsboardExport(JSON.parse(JSON.stringify(exported)));
    expect(ruleChainsEqual(again.document, first)).toBe(true);
    // The masked export of a chain that holds no secret is the plain export.
    const masked = exportChain({ name: 'Root Rule Chain', root: true, debugMode: false, document: first });
    expect(masked.metadata).toEqual(exported.metadata);
  });

  it('imported as the ROOT chain it is inert here: every message ends at the Device Profile Node and never reaches the switch', async () => {
    const hits: Record<string, number> = {};
    standIns(hits);
    const run = async (doc: RuleChainDocument) => {
      const mem = memoryDeps([chainOf('Root Rule Chain', doc, { root: true, strict: true })]);
      const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
      await engine.processNow(telemetry('i1', 1));
      return engine.stats().counters;
    };
    const asShipped = await run(importChain(fixture()).document);
    expect(hits).toEqual({});
    expect(asShipped.unhandled_failures).toBe(1);
    const switchFirst = await run(importChain(without(fixture(), ['Device Profile Node'], 'Message Type Switch')).document);
    expect(hits).toEqual({ timeseries: 1 });
    expect(switchFirst.unhandled_failures ?? 0).toBe(0);
  });
});

describe('credentials on export (spec §12 ruling S-5, secrets.ts)', () => {
  const node = (id: string, type: string, name: string, over: Record<string, unknown>) =>
    ({ id, type, name, debugMode: 'off' as const, config: { ...newRuleNodeConfig(type), ...over }, x: 0, y: 0 });
  const doc = (): RuleChainDocument => ({
    version: 1,
    firstNodeId: 'c0de0000-0000-4000-8000-000000000001',
    nodes: [
      node('c0de0000-0000-4000-8000-000000000001', 'tb:external:rest-api-call', 'Call ERP', {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-2' },
        credentials: { type: 'basic', username: 'svc', password: 'p@ss-1' },
      }),
      node('c0de0000-0000-4000-8000-000000000002', 'tb:external:mqtt', 'Broker (cert)', {
        host: 'broker.local', credentials: { type: 'cert.PEM', caCert: 'CA-PEM', cert: 'CERT-PEM', privateKey: 'KEY-3', password: 'kp-4' },
      }),
      node('c0de0000-0000-4000-8000-000000000003', 'tb:external:mqtt', 'Broker (basic)', {
        host: 'broker.local', credentials: { type: 'basic', username: 'u1', password: 'pw-5' },
      }),
      node('c0de0000-0000-4000-8000-000000000004', 'tb:external:send-to-slack', 'Slack', { botToken: 'xoxb-6', conversation: 'C1' }),
    ],
    connections: [],
  });

  it('the export masks every external credential as "***", keeps user names and public certificates, and never touches the stored chain', () => {
    const stored = doc();
    const before = JSON.parse(JSON.stringify(stored));
    const exp = exportChain({ name: 'Out', root: false, debugMode: false, document: stored });
    const cfg = exp.metadata.nodes.map((n) => n.configuration as Record<string, any>);
    expect(cfg[0].credentials).toEqual({ type: 'basic', username: 'svc', password: MASKED_SECRET });
    expect(cfg[0].headers).toEqual({ 'Content-Type': 'application/json', Authorization: MASKED_SECRET });
    expect(cfg[1].credentials).toEqual({ type: 'cert.PEM', caCert: 'CA-PEM', cert: 'CERT-PEM', privateKey: MASKED_SECRET, password: MASKED_SECRET });
    expect(cfg[2].credentials).toEqual({ type: 'basic', username: 'u1', password: MASKED_SECRET });
    expect(cfg[3].botToken).toBe(MASKED_SECRET);
    expect(JSON.stringify(exp)).not.toMatch(/p@ss-1|tok-2|KEY-3|kp-4|pw-5|xoxb-6/);
    expect(stored).toEqual(before);
    // The masked export still parses: every node is itself, not Unsupported.
    expect(fromThingsboardExport(exp).document.nodes.map((n) => n.type)).toEqual(stored.nodes.map((n) => n.type));
  });

  it('importing that export warns once per node whose credential must be entered again', () => {
    const exp = exportChain({ name: 'Out', root: false, debugMode: false, document: doc() });
    const r = importChain(JSON.parse(JSON.stringify(exp)));
    expect(r.warnings).toEqual([
      expect.stringMatching(/^Node "Call ERP": credential must be entered \((headers\.Authorization, credentials\.password|credentials\.password, headers\.Authorization)\)/),
      expect.stringMatching(/^Node "Broker \(cert\)": credential must be entered \(credentials\.privateKey, credentials\.password\)/),
      expect.stringMatching(/^Node "Broker \(basic\)": credential must be entered \(credentials\.password\)/),
      expect.stringMatching(/^Node "Slack": credential must be entered \(botToken\)/),
    ]);
  });
});
