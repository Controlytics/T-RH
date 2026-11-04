import { randomUUID } from 'node:crypto';
import type { RuleChain } from '@prisma/client';
import { ruleNodeConfigWithDefaults, type RuleChainDocument, type RuleChainNode, type RuleDebugMode } from '@digilog/shared';
import { RULE_ENGINE_CONFIG_DEFAULTS, type RuleEngineConfig } from '../modules/rule-engine/config.js';
import { loadChainFromRow, type LoadedRuleChain } from '../modules/rule-engine/service.js';
import { failureMessage, newMessage, ruleNodeOrigin, ruleNodeKey, type RuleMessage, type RuleOriginator } from '../modules/rule-engine/message.js';
import type { RuleContext, RuleLogLevel } from '../modules/rule-engine/context.js';
import type { RuleServices } from '../modules/rule-engine/services.js';
import { runScript as runVmScript } from '../modules/rule-engine/script-vm.js';
import type { RuleDebugEventInput } from '../modules/rule-engine/debug.js';

/**
 * Test support for rule nodes and the rule engine (rule chains, 2026-11-03).
 * Here, not under `__tests__`, so `tsc -p apps/api` type-checks it; no vitest
 * import, so it compiles anywhere.
 *
 * ── For a node handler (Tasks 4-6) ──
 *   const { ctx, calls } = fakeContext({ type: 'tb:filter:script', config: { jsScript: 'return msg.t > 20;' } });
 *   await handler(ctx, testMessage({ t: 21 }));
 *   expect(calls.next).toEqual([{ msg: expect.anything(), relations: ['True'] }]);
 * `ctx.config` is the type's defaults merged with `config`, exactly as the
 * engine merges them. Every service throws "not stubbed" unless given:
 *   fakeContext({ services: { telemetry: { write: async () => {} } } })
 * `calls` records every way the message left; `calls.relations()` flattens
 * `next` (and `Failure` for each `tellFailure`) in call order.
 *
 * ── For the engine ──
 *   chainOf / docOf build a LoadedRuleChain from nodes and connections;
 *   memoryDeps(chains) gives `createRuleEngine` in-memory chains and a recording debug sink.
 */
export interface FakeContextCalls {
  next: { msg: RuleMessage; relations: string[] }[];
  failures: { msg: RuleMessage; error: string }[];
  self: { msg: RuleMessage; delayMs: number }[];
  chains: { chainId: string; msg: RuleMessage }[];
  outputs: { msg: RuleMessage; label: string }[];
  logs: { level: RuleLogLevel; text: string }[];
  /** Every relation in call order — `next` labels, and `Failure` for each failure. */
  relations(): string[];
}

type ServiceOverrides = { [K in keyof RuleServices]?: RuleServices[K] extends (...args: never[]) => unknown ? RuleServices[K] : Partial<RuleServices[K]> };

function notStubbed(path: string) {
  return () => { throw new Error(`fakeServices: ${path} was not stubbed`); };
}

/** Every service throws "not stubbed" unless overridden; `config()` is the shipped defaults; `stats.inc` counts into `counters`. */
export function fakeServices(overrides: ServiceOverrides = {}, config: Partial<RuleEngineConfig> = {}): RuleServices & { counters: Record<string, number> } {
  const counters: Record<string, number> = {};
  const group = <G extends object>(name: string, keys: string[], over: Partial<G> | undefined): G =>
    Object.fromEntries(keys.map((k) => [k, (over as Record<string, unknown> | undefined)?.[k] ?? notStubbed(`${name}.${k}`)])) as G;
  const base: RuleServices = {
    prisma: (overrides.prisma ?? new Proxy({}, { get: (_t, p) => notStubbed(`prisma.${String(p)}`)() })) as RuleServices['prisma'],
    telemetry: group('telemetry', ['write', 'latest', 'history'], overrides.telemetry),
    attributes: group('attributes', ['get', 'save', 'delete'], overrides.attributes),
    instruments: group('instruments', ['byId', 'byCode', 'gatewayOf', 'fields'], overrides.instruments),
    alarms: group('alarms', ['createOrUpdate', 'clear', 'byId'], overrides.alarms),
    notifications: group('notifications', ['email', 'sms', 'byTemplate'], overrides.notifications),
    http: group('http', ['fetch'], overrides.http),
    mqtt: group('mqtt', ['publish', 'close'], overrides.mqtt),
    appAttributes: overrides.appAttributes ?? notStubbed('appAttributes'),
    appDetails: overrides.appDetails ?? notStubbed('appDetails'),
    config: overrides.config ?? (() => ({ ...RULE_ENGINE_CONFIG_DEFAULTS, ...config })),
    durable: group('durable', ['enqueue'], overrides.durable),
    stats: { inc: (name: string) => { counters[name] = (counters[name] ?? 0) + 1; } },
    log: {
      debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined,
      ...(overrides.log ?? {}),
    },
  };
  return Object.assign(base, { counters });
}

export interface FakeContextOptions {
  type?: string;
  config?: Record<string, unknown>;
  name?: string;
  nodeId?: string;
  chainId?: string;
  chainName?: string;
  debugMode?: RuleDebugMode;
  services?: ServiceOverrides | RuleServices;
}

export function fakeContext<C = Record<string, unknown>>(opts: FakeContextOptions = {}): { ctx: RuleContext<C>; calls: FakeContextCalls } {
  const type = opts.type ?? 'test:node';
  const config = ruleNodeConfigWithDefaults(type, opts.config ?? {}) as C;
  const nodeId = opts.nodeId ?? randomUUID();
  const chainId = opts.chainId ?? randomUUID();
  const order: string[] = [];
  const calls: FakeContextCalls = {
    next: [], failures: [], self: [], chains: [], outputs: [], logs: [],
    relations: () => [...order],
  };
  const services = opts.services && 'telemetry' in opts.services && typeof (opts.services as RuleServices).config === 'function'
    && 'stats' in opts.services
    ? opts.services as RuleServices
    : fakeServices((opts.services ?? {}) as ServiceOverrides);
  const ctx: RuleContext<C> = {
    node: { id: nodeId, name: opts.name ?? type, type, config, debugMode: opts.debugMode ?? 'off' },
    chain: { id: chainId, name: opts.chainName ?? 'Test chain' },
    config,
    services,
    origin: ruleNodeOrigin(chainId, nodeId),
    nodeKey: ruleNodeKey(chainId, nodeId),
    tellNext(msg, relations) {
      const list = Array.isArray(relations) ? [...relations] : [relations];
      calls.next.push({ msg, relations: list });
      order.push(...list);
    },
    tellFailure(msg, err) {
      const failed = failureMessage(msg, err);
      calls.failures.push({ msg: failed, error: failed.metadata.error });
      order.push('Failure');
    },
    async tellSelf(msg, delayMs) {
      calls.self.push({ msg, delayMs });
    },
    async callChain(id, msg) {
      calls.chains.push({ chainId: id, msg });
    },
    output(msg, label) {
      calls.outputs.push({ msg, label });
    },
    log(level, text) {
      calls.logs.push({ level, text });
    },
    // As the engine's: keyed to this node (version 0), so three consecutive time-outs disable the script.
    runScript: (kind, script, msg) => runVmScript(kind, script, msg.data, msg.metadata, msg.type, services.config().scriptTimeoutMs,
      { key: `${ruleNodeKey(chainId, nodeId)}:0` }) as never,
  };
  return { ctx, calls };
}

/** A message for a test: an instrument originator by default. */
export function testMessage(data: unknown, opts: { type?: string; metadata?: Record<string, unknown>; originator?: Partial<RuleOriginator> } = {}): RuleMessage {
  return newMessage(
    opts.type ?? 'POST_TELEMETRY_REQUEST',
    { type: 'INSTRUMENT', id: 'instrument-1', code: 'TEST-001', ...(opts.originator ?? {}) } as RuleOriginator,
    data,
    { instrumentCode: 'TEST-001', ...(opts.metadata ?? {}) },
  );
}

// ─── engine harness ──────────────────────────────────────────────────────────

/** A node for a test document. */
export function nodeOf(type: string, name: string, opts: { id?: string; debugMode?: RuleDebugMode; config?: Record<string, unknown> } = {}): RuleChainNode {
  return { id: opts.id ?? randomUUID(), type, name, debugMode: opts.debugMode ?? 'off', config: opts.config ?? {}, x: 0, y: 0 };
}

export function docOf(nodes: RuleChainNode[], connections: [RuleChainNode, string, RuleChainNode][], first: RuleChainNode | null = nodes[0] ?? null): RuleChainDocument {
  return {
    version: 1,
    firstNodeId: first?.id ?? null,
    nodes,
    connections: connections.map(([from, relation, to]) => ({ from: from.id, to: to.id, relation })),
  };
}

/**
 * A LoadedRuleChain as the engine's chain cache returns it. `strict: true`
 * goes through the real `loadChainFromRow` (whose FORGIVING read turns any type
 * outside the catalogue into `tb:unsupported`); the default builds the same
 * shape directly, so a test-only type id (`test:route`) survives.
 */
export function chainOf(
  name: string,
  document: RuleChainDocument,
  opts: { id?: string; root?: boolean; reEnterOnRuleNodeWrites?: boolean; strict?: boolean } = {},
): LoadedRuleChain {
  const now = new Date();
  const id = opts.id ?? randomUUID();
  if (opts.strict) {
    const row: RuleChain = {
      id, name, root: opts.root ?? false, debugMode: false, firstNodeId: document.firstNodeId,
      document: document as unknown as RuleChain['document'], reEnterOnRuleNodeWrites: opts.reEnterOnRuleNodeWrites ?? false,
      createdAt: now, updatedAt: now, createdBy: null, updatedBy: null,
    };
    return loadChainFromRow(row);
  }
  const outgoing = new Map<string, Map<string, string[]>>();
  for (const c of document.connections) {
    const byRelation = outgoing.get(c.from) ?? new Map<string, string[]>();
    byRelation.set(c.relation, [...(byRelation.get(c.relation) ?? []), c.to]);
    outgoing.set(c.from, byRelation);
  }
  return {
    id, name, root: opts.root ?? false, debugMode: false, reEnterOnRuleNodeWrites: opts.reEnterOnRuleNodeWrites ?? false,
    firstNodeId: document.firstNodeId, document, nodesById: new Map(document.nodes.map((n) => [n.id, n])), outgoing, updatedAt: now,
  };
}

/** In-memory engine dependencies: the chains given (the first `root: true` one is the root) and a recording debug sink. */
export function memoryDeps(chains: LoadedRuleChain[], config: Partial<RuleEngineConfig> = {}) {
  const byId = new Map(chains.map((c) => [c.id, c]));
  const events: RuleDebugEventInput[] = [];
  return {
    chains: byId,
    events,
    deps: {
      getChain: async (id: string) => byId.get(id) ?? null,
      getRootChain: async () => [...byId.values()].find((c) => c.root) ?? null,
      loadConfig: async () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS, ...config }),
      debug: { record: (e: RuleDebugEventInput) => { events.push({ ...e, msg: JSON.parse(JSON.stringify(e.msg)) as RuleMessage }); } },
      instrumentInfo: async () => null,
      invalidateChain: () => undefined,
      listChains: async () => [...byId.values()].map((c) => ({ id: c.id, updatedAt: c.updatedAt })),
      registerNodes: () => undefined,
      installSink: false,
    },
  };
}
