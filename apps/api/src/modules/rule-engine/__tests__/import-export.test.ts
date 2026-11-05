import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defaultRootChainDocument, messageTypeSwitchLabel, toThingsboardExport, fromThingsboardExport, parseRuleChainDocument, ruleChainsEqual,
  newRuleNodeConfig, RULE_NODE_TYPE_BY_TB_CLASS, UNSUPPORTED_NODE_TYPE, DEFAULT_ROOT_CHAIN_NODE_IDS, type RuleChainDocument,
  RULE_SCRIPT_KEYS, ruleNodeScriptKey, ruleNodeScript,
} from '@digilog/shared';
import { importChain, exportChain, MASKED_SECRET } from '../import-export.js';
import { createRuleEngine } from '../engine.js';
import { registerNode } from '../registry.js';
import { DEVICE_PROFILE_TYPE, deviceProfile } from '../nodes/action/device-profile.js';
import { LOG_TYPE, logNode } from '../nodes/action/log.js';
import { MESSAGE_TYPE_SWITCH, messageTypeSwitch } from '../nodes/filter/message-type-switch.js';
import { logger } from '../../../lib/logger.js';
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
afterEach(() => { while (restores.length) restores.pop()!(); vi.restoreAllMocks(); });

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

// ─── ThingsBoard's REAL default root chains (Task 6; re-pinned by ruling CV-3, 2026-11-05) ─
//
// Both fixtures are ThingsBoard's own tenant root chain, byte for byte, from
// github.com/thingsboard/thingsboard,
// `application/src/main/data/json/tenant/rule_chains/root_rule_chain.json`:
//  - `fixtures/thingsboard-root-chain-3.x.json` — tag v3.6.4 (commit 0c25a3b3),
//    sha256 099e78f7…c53a328. The 3.x shape: `debugMode`, Save Timeseries with NO
//    configurationVersion (v0), Save Client Attributes at v2.
//  - `fixtures/thingsboard-root-chain-4.2.json` — tag v4.2 (commit 29a6e980), sha256
//    26618699…bfae6a8b; the same bytes on v4.2.1, v4.2.2.8 and the release-4.2 branch
//    head (4955498b, 2026-10-26). The 4.x shape: no debug flags, Save Timeseries at v1
//    (`processingSettings`), Save Client Attributes at v3.
// Both ship SEVEN nodes, the entry being the Device Profile Node — a BUILT
// pass-through here since 46c91dc9 — in front of the Message Type Switch. The
// one node with no counterpart is RPC Call Request (later). Each imports with
// exactly THREE warnings since ruling TB-L (2026-11-05), every one of them true:
// its two Log nodes are TBEL in ThingsBoard ("Log RPC from Device", "Log Other")
// and now run their script as JavaScript, and RPC Call Request has no
// counterpart. (CV-2 / CV-3 pinned ONE, when a TBEL Log node imported silently
// and then failed on every message — review B C-1.)
const fixtureText = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
const FIXTURE_TEXT = fixtureText('thingsboard-root-chain-3.x.json');
const FIXTURE_42_TEXT = fixtureText('thingsboard-root-chain-4.2.json');
type TbNode = { type: string; name: string; configurationVersion?: number; configuration: unknown; additionalInfo: { layoutX: number; layoutY: number } };
type TbExport = { ruleChain: { name: string; root: boolean }; metadata: { firstNodeIndex: number; nodes: TbNode[]; connections: { fromIndex: number; toIndex: number; type: string }[] } };
const fixture = (): TbExport => JSON.parse(FIXTURE_TEXT) as TbExport;
const fixture42 = (): TbExport => JSON.parse(FIXTURE_42_TEXT) as TbExport;
const ON_EVERY = { type: 'ON_EVERY_MESSAGE' };

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
/** Ruling TB-L: a TBEL Log node imports as JavaScript running its TBEL script. */
const logTbelWarning = (name: string) => `Node "${name}" (Log): its TBEL script now runs as JavaScript — check it.`;
const LOG_TBEL_WARNINGS = [logTbelWarning('Log RPC from Device'), logTbelWarning('Log Other')];
const ROOT_WARNINGS = [...LOG_TBEL_WARNINGS, RPC_WARNING];
/** A ThingsBoard TBEL Log configuration as stored here after the import: JavaScript, running the TBEL text. */
const asJavaScript = (configuration: unknown) => {
  const c = configuration as { scriptLang: string; jsScript: string; tbelScript: string };
  expect(c.scriptLang).toBe('TBEL');
  return { scriptLang: 'JS', jsScript: c.tbelScript };
};

const NODES = [
  ['tb:action:save-timeseries', 'Save Timeseries'],
  ['tb:action:save-attributes', 'Save Client Attributes'],
  ['tb:filter:message-type-switch', 'Message Type Switch'],
  ['tb:action:log', 'Log RPC from Device'],
  ['tb:action:log', 'Log Other'],
  ['tb:action:rpc-call-request', 'RPC Call Request'],
  ['tb:action:device-profile', 'Device Profile Node'],
];
const CONNECTIONS = [
  ['Device Profile Node', 'Success', 'Message Type Switch'],
  ['Message Type Switch', 'Other', 'Log Other'],
  ['Message Type Switch', 'Post attributes', 'Save Client Attributes'],
  ['Message Type Switch', 'Post telemetry', 'Save Timeseries'],
  ['Message Type Switch', 'RPC Request from Device', 'Log RPC from Device'],
  ['Message Type Switch', 'RPC Request to Device', 'RPC Call Request'],
];

/** What both fixtures share after import: every node mapped, the entry, positions, debug off, the connections. */
function expectRootChainShape(tb: TbExport, r: ReturnType<typeof importChain>) {
  expect(r.name).toBe('Root Rule Chain');
  expect(r.document.nodes.map((n) => [n.type, n.name])).toEqual(NODES);
  expect(r.document.nodes.some((n) => n.type === UNSUPPORTED_NODE_TYPE)).toBe(false);
  // The entry is the Device Profile Node, as in ThingsBoard.
  expect(r.document.firstNodeId).toBe(r.document.nodes[6].id);
  expect(r.document.nodes.map((n) => [n.x, n.y])).toEqual(tb.metadata.nodes.map((n) => [n.additionalInfo.layoutX, n.additionalInfo.layoutY]));
  expect(r.document.nodes.every((n) => n.debugMode === 'off')).toBe(true);
  const name = (id: string) => r.document.nodes.find((n) => n.id === id)!.name;
  expect(r.document.connections.map((c) => [name(c.from), c.relation, name(c.to)])).toEqual(CONNECTIONS);
  expect(parseRuleChainDocument(r.document)).toEqual(r.document);
}

describe('ThingsBoard\'s real root chain export (v3.6.4 fixture)', () => {
  it('imports every node mapped to its catalogue type, with exactly THREE warnings — its two TBEL Log nodes (TB-L) and RPC Call Request', () => {
    const tb = fixture();
    const r = importChain(tb);
    expectRootChainShape(tb, r);
    expect(r.warnings).toEqual(ROOT_WARNINGS);
    // ThingsBoard's configurations come through as given, except where ThingsBoard
    // itself would upgrade them on import (TbNodeUpgradeUtils, ruling CV-3):
    //  - Save Timeseries v0 → v1: processingSettings On every message, and here the toggle it sets;
    //  - Save Client Attributes v2 → v3: processingSettings On every message;
    //  - Device Profile v0 → v1: persistAlarmRulesState false → fetchAlarmRulesStateOnStart false (already false);
    // and the two TBEL Log nodes, which run their TBEL script as JavaScript (ruling TB-L).
    const expected = tb.metadata.nodes.map((n) => n.configuration as Record<string, unknown>);
    expected[0] = { ...expected[0], skipLatestPersistence: false, processingSettings: ON_EVERY };
    expected[1] = { ...expected[1], processingSettings: ON_EVERY };
    expected[3] = asJavaScript(expected[3]);
    expected[4] = asJavaScript(expected[4]);
    r.document.nodes.forEach((n, i) => expect(n.config, n.name).toEqual(expected[i]));
  });

  it('without its Device Profile Node (the switch as the entry) it imports with the same THREE warnings', () => {
    const r = importChain(without(fixture(), ['Device Profile Node'], 'Message Type Switch'));
    expect(r.warnings).toEqual(ROOT_WARNINGS);
    expect(r.document.nodes).toHaveLength(6);
    expect(r.document.firstNodeId).toBe(r.document.nodes.find((n) => n.name === 'Message Type Switch')!.id);
  });

  it('with only its built nodes it imports with only the two TBEL notes', () => {
    const r = importChain(without(fixture(), ['RPC Call Request'], 'Device Profile Node'));
    expect(r.warnings).toEqual(LOG_TBEL_WARNINGS);
    expect(r.document.nodes).toHaveLength(6);
    expect(r.document.connections).toHaveLength(5);
  });

  it('a class the catalogue does not know (a ThingsBoard PE node) imports as Unsupported with one more warning, and exports back as itself', () => {
    const cls = 'org.thingsboard.rule.engine.analytics.incoming.TbSimpleAggMsgNode';
    expect(RULE_NODE_TYPE_BY_TB_CLASS.has(cls)).toBe(false);
    const tb = fixture();
    tb.metadata.nodes.push({ type: cls, name: 'Aggregate stream', configuration: { interval: 60 }, additionalInfo: { layoutX: 10, layoutY: 20 } });
    const r = importChain(tb);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings.slice(0, 3)).toEqual(ROOT_WARNINGS);
    expect(r.warnings[3]).toContain('Aggregate stream');
    expect(r.warnings[3]).toContain(cls);
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

  it('imported as the ROOT chain it RUNS: the Device Profile Node (a pass-through) hands every message to the switch', async () => {
    // Until 46c91dc9 the Device Profile Node had no handler and this chain was inert here.
    const hits: Record<string, number> = {};
    standIns(hits);
    restores.push(registerNode(DEVICE_PROFILE_TYPE, deviceProfile));
    const mem = memoryDeps([chainOf('Root Rule Chain', importChain(fixture()).document, { root: true, strict: true })]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.processNow(telemetry('i1', 1));
    await engine.processNow(newMessage('POST_ATTRIBUTES_REQUEST', { type: 'INSTRUMENT', id: 'i1' }, { a: '1' }));
    expect(hits).toEqual({ timeseries: 1, attributes: 1 });
    expect(engine.stats().counters.unhandled_failures ?? 0).toBe(0);
  });
});

describe('ThingsBoard\'s real root chain export (v4.2 fixture)', () => {
  it('imports every node mapped to its catalogue type, with exactly THREE warnings — its two TBEL Log nodes (TB-L) and RPC Call Request', () => {
    const tb = fixture42();
    const r = importChain(tb);
    expectRootChainShape(tb, r);
    expect(r.warnings).toEqual(ROOT_WARNINGS);
    // 4.x configurations come through as given; Save Timeseries (v1) gains only the toggle its
    // processingSettings sets (ruling CV-3) — On every message: the latest readings ARE updated;
    // the two TBEL Log nodes run their TBEL script as JavaScript (ruling TB-L).
    expect(tb.metadata.nodes[0].configurationVersion).toBe(1);
    expect(tb.metadata.nodes[1].configurationVersion).toBe(3);
    const expected = tb.metadata.nodes.map((n) => n.configuration as Record<string, unknown>);
    expected[0] = { ...expected[0], skipLatestPersistence: false };
    expected[3] = asJavaScript(expected[3]);
    expected[4] = asJavaScript(expected[4]);
    r.document.nodes.forEach((n, i) => expect(n.config, n.name).toEqual(expected[i]));
  });

  it('exports back in ThingsBoard\'s OWN 4.2 form: every configuration is the fixture\'s but the two Log nodes, now JavaScript (TB-L); Save Timeseries at v1 without the toggle', () => {
    const tb = fixture42();
    const exported = toThingsboardExport('Root Rule Chain', true, importChain(tb).document);
    const expected = tb.metadata.nodes.map((n) => n.configuration);
    expected[3] = asJavaScript(expected[3]);
    expected[4] = asJavaScript(expected[4]);
    expect(exported.metadata.nodes.map((n) => n.configuration)).toEqual(expected);
    expect(exported.metadata.nodes.map((n) => n.configurationVersion)).toEqual([1, 3, 0, 0, 0, undefined, 1]);
    expect(exported.metadata.connections).toEqual(tb.metadata.connections);
    expect(exported.metadata.firstNodeIndex).toBe(tb.metadata.firstNodeIndex);
  });

  it('export → import is the same chain; the second import has only the RPC warning (its Log nodes went out as JavaScript)', () => {
    const first = importChain(fixture42());
    expect(first.warnings).toEqual(ROOT_WARNINGS);
    const again = importChain(JSON.parse(JSON.stringify(toThingsboardExport('Root Rule Chain', true, first.document))));
    expect(ruleChainsEqual(again.document, first.document)).toBe(true);
    expect(again.warnings).toEqual([RPC_WARNING]);
  });

  it('the TB-L script rule reaches the API through @digilog/shared (the handlers\' contract): a stored TBEL config runs its TBEL text', () => {
    expect(RULE_SCRIPT_KEYS['tb:action:log']).toEqual(['jsScript', 'tbelScript']);
    expect(ruleNodeScriptKey('tb:action:log', { scriptLang: 'TBEL', jsScript: 'a', tbelScript: 'b' })).toBe('tbelScript');
    expect(ruleNodeScript('tb:action:create-alarm', { scriptLang: 'TBEL', alarmDetailsBuildJs: 'j', alarmDetailsBuildTbel: 't' })).toBe('t');
    // After an import there is nothing left to choose: the Log nodes are JavaScript.
    const log = importChain(fixture42()).document.nodes.find((n) => n.name === 'Log Other')!;
    expect(ruleNodeScriptKey(log.type, log.config)).toBe('jsScript');
  });

  it('imported as the ROOT chain, its TBEL "Log Other" RUNS on the REAL Log handler (review B C-1 acceptance — no stand-in)', async () => {
    restores.push(registerNode(DEVICE_PROFILE_TYPE, deviceProfile));
    restores.push(registerNode(MESSAGE_TYPE_SWITCH, messageTypeSwitch));
    restores.push(registerNode(LOG_TYPE, logNode));
    const info = vi.spyOn(logger, 'info');
    const mem = memoryDeps([chainOf('Root Rule Chain', importChain(fixture42()).document, { root: true, strict: true })]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    // A type ThingsBoard has no label for → "Other" → Log Other; a device RPC → Log RPC from Device.
    await engine.processNow(newMessage('MY_CUSTOM_EVENT', { type: 'INSTRUMENT', id: 'i1' }, { t: 21.5 }));
    await engine.processNow(newMessage('TO_SERVER_RPC_REQUEST', { type: 'INSTRUMENT', id: 'i1' }, { method: 'getTime' }));
    // A Log node that FAILED would end on its unconnected Failure (SCRIPT_LANGUAGE_UNSUPPORTED before TB-L).
    expect(engine.stats().counters.unhandled_failures ?? 0).toBe(0);
    const logged = info.mock.calls.map((c) => String(c[1]));
    expect(logged.find((t) => t.startsWith('[rule-chain Root Rule Chain/Log Other]'))).toContain('Incoming message:\n{"t":21.5}');
    expect(logged.find((t) => t.startsWith('[rule-chain Root Rule Chain/Log RPC from Device]'))).toContain('"method":"getTime"');
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
