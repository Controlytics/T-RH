import { ruleNodeConfigWithDefaults, RULE_NODE_TYPE_BY_ID, type RuleChainNode, type RuleDebugMode } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { getChain as cachedChain, getRootChain as cachedRootChain, invalidateChainCache, type LoadedRuleChain } from './service.js';
import { getRuleEngineConfig, RULE_ENGINE_CONFIG_DEFAULTS, type RuleEngineConfig } from './config.js';
import { OriginatorQueue } from './queue.js';
import { getHandler, hasLifecycleHandlers, type RegisteredRuleNode } from './registry.js';
import {
  RuleDebugWriter, UNHANDLED_SUFFIX, UNCONNECTED_SUFFIX, NO_CALLER_SUFFIX,
  type RuleDebugDirection, type RuleDebugEventInput,
} from './debug.js';
import { setRuleEngineSink, emitCounters, type RuleEngineSink } from './emit.js';
import { createRuleServices, type RuleServices, type RuleServicesHandle, type RuleServicesHooks } from './services.js';
import { runScript as runVmScript, type RuleScriptKind } from './script-vm.js';
import { copyMessage, failureMessage, errorText, ruleNodeOrigin, type RuleMessage } from './message.js';
import type { RuleContext, RuleLogLevel } from './context.js';
import { registerAllNodes } from './nodes/index.js';

/**
 * THE RULE ENGINE (rule chains, 2026-11-03; spec §6) — ThingsBoard's rule
 * engine on this system's own events.
 *
 * A message enters the ROOT chain (or a given chain / node) through the Main
 * queue (queue.ts: in memory, bounded, FIFO per originator, `concurrency`
 * originators at once). Processing one message is one FLOW: start at the
 * chain's first node; run its handler; follow every relation it returned to
 * every connected node, a copy each; repeat until nothing is left. Then the
 * originator's next message may start.
 *
 *  - A handler that throws → `Failure` with `metadata.error` / `errorStack`.
 *  - A relation with no connection ends the message there.
 *  - HOP LIMIT (`hopLimit`, 200): a message that has entered that many nodes —
 *    a Rule chain → Output cycle counts — ENDS with `metadata.error =
 *    HOP_LIMIT` (recorded `Failure (unhandled)`, even if a Failure connection
 *    exists: routing it would spend more hops on the loop it is stopping).
 *  - BUDGET: 30 s per message. A handler still running at the deadline is
 *    abandoned: the message ends `MESSAGE_TIMEOUT`, and whatever that handler
 *    calls later is dropped (counted `late_dropped`).
 *  - Rule chain / Output: the Rule chain node pushes (its chain, itself) on
 *    the message's `_stack` and enters the target chain; an Output node pops
 *    it and the message leaves the CALLER node under the Output node's NAME.
 *    A chain with no Output ends the message; an Output nobody called ends it
 *    as `<label> (no caller)`.
 *  - A call a handler makes AFTER it settled (a timer) starts a new message
 *    at the node's connections, through the queue. `tellSelf` delivers to the
 *    node itself after a delay (in memory).
 *  - A node type with no registered handler → `Failure`, `UNSUPPORTED_NODE`.
 *  - Before the first node, an instrument message's `instrumentCode` /
 *    `instrumentName` / `profileName` metadata is filled from a 30 s cache —
 *    never on the ingest path.
 *
 * Debug rows (debug.ts) follow each NODE's `debugMode`; a chain's own
 * `debugMode` column is not used (ThingsBoard's is vestigial).
 *
 * Lifecycle: at start, and every 5 s while any registered type has
 * `onInit` / `onDestroy`, the engine compares `rule_chains (id, updated_at)`
 * with what it initialised: a new or changed node is (re)initialised, a
 * removed one destroyed. With no lifecycle type registered, it never polls.
 *
 * Configuration → Rule Engine is read on a 1 s timer into a snapshot, so the
 * emit helpers decide "accepting?" without awaiting anything. Switching it
 * OFF empties the queue.
 */
export interface InstrumentInfo {
  code: string;
  name: string;
  profileName: string | null;
}

export interface RuleEngineDeps {
  getChain(id: string): Promise<LoadedRuleChain | null>;
  getRootChain(): Promise<LoadedRuleChain | null>;
  loadConfig(): Promise<RuleEngineConfig>;
  invalidateChain(id: string): void;
  listChains(): Promise<{ id: string; updatedAt: Date }[]>;
  instrumentInfo(id: string): Promise<InstrumentInfo | null>;
  debug: { record(e: RuleDebugEventInput): void; start?(): void; stop?(): Promise<void>; flush?(): Promise<void> };
  services: (hooks: RuleServicesHooks) => RuleServicesHandle;
  registerNodes: () => void;
  /** Install the engine as the emit helpers' sink on start (the singleton does; most unit tests do not). */
  installSink: boolean;
  budgetMs: number;
  configRefreshMs: number;
  lifecyclePollMs: number;
}

export interface RuleEngineStats {
  started: boolean;
  enabled: boolean;
  queueDepth: number;
  inFlight: number;
  dropped: number;
  processedLastMinute: number;
  chains: { id: string; processedLastMinute: number }[];
  counters: Record<string, number>;
}

export interface RuleEngine {
  readonly started: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Into the ROOT chain. O(1); false when not admitted (not started, switched off, stopping). */
  enqueue(msg: RuleMessage): boolean;
  /**
   * Re-inject a message AFTER `nodeId` of `chainId`, out on `relations`
   * (default `Success`) — the durable task's path. Resolves when the message
   * has been processed; rejects when it was not admitted or was dropped.
   */
  resumeAfter(msg: RuleMessage, chainId: string, nodeId: string, relations?: string[]): Promise<void>;
  /** Run one message to completion now, bypassing the queue (tests). Into the root chain, or `chainId`'s first node. */
  processNow(msg: RuleMessage, opts?: { chainId?: string }): Promise<void>;
  stats(): RuleEngineStats;
  config(): RuleEngineConfig;
  /** Re-read Configuration → Rule Engine now (tests; the timer does it every second). */
  refreshConfig(): Promise<RuleEngineConfig>;
  runScript(kind: RuleScriptKind, script: string, msg: unknown, metadata: Record<string, string>, msgType: string): Promise<unknown>;
  /** Re-check every chain's lifecycle nodes now; `force` ignores the versions already seen (tests). */
  syncLifecycles(opts?: { force?: boolean }): Promise<void>;
  /** Resolves when the queue is empty and idle and the debug buffer is written (tests). */
  drain(): Promise<void>;
  /** The services handed to handlers. */
  readonly services: RuleServices;
}

// ─── internals ───────────────────────────────────────────────────────────────

type Emission =
  | { kind: 'next'; msg: RuleMessage; relations: string[] }
  | { kind: 'failure'; msg: RuleMessage; error: string }
  | { kind: 'output'; msg: RuleMessage; label: string }
  | { kind: 'chain'; msg: RuleMessage; chain: LoadedRuleChain };

/** An emission replayed from the queue: a late call, or a durable resume. */
type Replay =
  | { kind: 'next'; relations: string[] }
  | { kind: 'failure'; error: string }
  | { kind: 'output'; label: string }
  | { kind: 'chain'; targetChainId: string };

type Entry =
  | { kind: 'root' }
  | { kind: 'chain'; chainId: string }
  | { kind: 'node'; chainId: string; nodeId: string }
  | { kind: 'replay'; chainId: string; nodeId: string; replay: Replay };

interface QueueItem {
  msg: RuleMessage;
  entry: Entry;
  deferred?: { resolve(): void; reject(err: Error): void };
}

interface Step {
  chain: LoadedRuleChain;
  nodeId: string;
  msg: RuleMessage;
  inRelation: string | null;
}

interface Flow {
  deadline: number;
  steps: Step[];
  abandoned: boolean;
  chainsEntered: Set<string>;
}

interface LifecycleInstance {
  key: string;
  fingerprint: string;
  chain: LoadedRuleChain;
  node: RuleChainNode;
}

const BUDGET_EXCEEDED = Symbol('BUDGET_EXCEEDED');
const WINDOW_SECONDS = 60;

const isFailure = (e: Emission) => e.kind === 'failure' || (e.kind === 'next' && e.relations.includes('Failure'));
const fingerprintOf = (n: RuleChainNode) => `${n.type}\u0000${n.name}\u0000${n.debugMode}\u0000${JSON.stringify(n.config)}`;

class RuleEngineImpl implements RuleEngine {
  private isStarted = false;
  private stopping = false;
  private cfg: RuleEngineConfig = { ...RULE_ENGINE_CONFIG_DEFAULTS };
  private configLoaded = false;
  private readonly queue: OriginatorQueue<QueueItem>;
  private readonly counters = new Map<string, number>();
  private readonly window = new Map<number, { total: number; chains: Map<string, number> }>();
  private readonly selfTimers = new Set<NodeJS.Timeout>();
  private readonly instances = new Map<string, LifecycleInstance>();
  private readonly chainVersions = new Map<string, number>();
  private lifecycleBusy: Promise<void> | null = null;
  private configTimer: NodeJS.Timeout | null = null;
  private lifecycleTimer: NodeJS.Timeout | null = null;
  private lastDropLogAt = 0;
  private lastConfigErrorLogAt = 0;
  private readonly servicesHandle: RuleServicesHandle;

  constructor(private readonly deps: RuleEngineDeps) {
    this.queue = new OriginatorQueue<QueueItem>({
      capacity: this.cfg.queueCapacity,
      concurrency: this.cfg.concurrency,
      keyOf: (item) => `${item.msg.originator.type}:${item.msg.originator.id}`,
      process: (item) => this.processItem(item),
      onDrop: (item) => this.onDrop(item),
      onError: (err) => {
        this.inc('errors');
        logger.error({ err: errorText(err) }, '[rule-engine] a message failed outside any node');
      },
    });
    this.servicesHandle = deps.services({ config: () => this.cfg, inc: (name) => this.inc(name) });
  }

  get started(): boolean { return this.isStarted; }
  get services(): RuleServices { return this.servicesHandle; }

  config(): RuleEngineConfig { return this.cfg; }

  private inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  private accepting(): boolean {
    return this.isStarted && !this.stopping && this.cfg.enabled;
  }

  private readonly sink: RuleEngineSink = {
    accepting: () => this.accepting(),
    enqueue: (msg) => this.enqueue(msg),
    reEnterAllowed: async (chainId) => (await this.deps.getChain(chainId))?.reEnterOnRuleNodeWrites === true,
  };

  // ── lifecycle of the engine ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.stopping = false;
    try {
      this.deps.registerNodes();
    } catch (err) {
      logger.error({ err: errorText(err) }, '[rule-engine] registering the node handlers failed');
    }
    try {
      await this.refreshConfig();
    } catch (err) {
      logger.error({ err: errorText(err) }, '[rule-engine] Configuration → Rule Engine could not be read — running on the shipped defaults until it can');
    }
    this.deps.debug.start?.();
    this.queue.resume();
    this.isStarted = true;
    if (this.deps.installSink) setRuleEngineSink(this.sink);
    this.configTimer = setInterval(() => {
      this.refreshConfig().catch((err) => {
        this.inc('config_errors');
        // Once a minute: the timer fires every second, and a database outage would otherwise flood the log.
        const now = Date.now();
        if (now - this.lastConfigErrorLogAt < 60_000) return;
        this.lastConfigErrorLogAt = now;
        logger.warn({ err: errorText(err) }, '[rule-engine] could not re-read Configuration → Rule Engine — keeping the last settings (logged once a minute)');
      });
    }, this.deps.configRefreshMs);
    this.configTimer.unref();
    this.lifecycleTimer = setInterval(() => { void this.syncLifecycles(); }, this.deps.lifecyclePollMs);
    this.lifecycleTimer.unref();
    await this.syncLifecycles();
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.stopping = true;
    if (this.deps.installSink) setRuleEngineSink(null);
    if (this.configTimer) clearInterval(this.configTimer);
    if (this.lifecycleTimer) clearInterval(this.lifecycleTimer);
    this.configTimer = null;
    this.lifecycleTimer = null;
    for (const t of this.selfTimers) clearTimeout(t);
    this.selfTimers.clear();
    this.queue.pause();
    for (const item of this.queue.clear()) item.deferred?.reject(new Error('ENGINE_STOPPED'));
    await Promise.race([this.queue.onIdle(), new Promise((r) => setTimeout(r, 5_000).unref())]);
    if (this.lifecycleBusy) await this.lifecycleBusy;
    for (const key of [...this.instances.keys()]) await this.destroyInstance(key);
    this.chainVersions.clear();
    try {
      await this.deps.debug.stop?.();
    } catch (err) {
      logger.error({ err: errorText(err) }, '[rule-engine] debug writer stop failed');
    }
    await this.servicesHandle.dispose().catch(() => undefined);
    this.isStarted = false;
    this.stopping = false;
  }

  async refreshConfig(): Promise<RuleEngineConfig> {
    const next = await this.deps.loadConfig();
    const wasEnabled = this.cfg.enabled;
    this.cfg = next;
    this.configLoaded = true;
    this.queue.configure({ capacity: next.queueCapacity, concurrency: next.concurrency });
    if (wasEnabled && !next.enabled) {
      const cleared = this.queue.clear();
      for (const item of cleared) item.deferred?.reject(new Error('ENGINE_DISABLED'));
      if (cleared.length > 0) this.inc('cleared_on_disable', cleared.length);
    }
    return next;
  }

  private async ensureConfig(): Promise<void> {
    if (!this.configLoaded) await this.refreshConfig();
  }

  // ── admission ─────────────────────────────────────────────────────────────

  enqueue(msg: RuleMessage): boolean {
    if (!this.accepting()) return false;
    return this.queue.push({ msg, entry: { kind: 'root' } });
  }

  resumeAfter(msg: RuleMessage, chainId: string, nodeId: string, relations: string[] = ['Success']): Promise<void> {
    if (!this.accepting()) return Promise.reject(new Error(this.isStarted ? 'ENGINE_DISABLED' : 'ENGINE_NOT_STARTED'));
    return new Promise<void>((resolve, reject) => {
      const ok = this.queue.push({ msg, entry: { kind: 'replay', chainId, nodeId, replay: { kind: 'next', relations } }, deferred: { resolve, reject } });
      if (!ok) reject(new Error('QUEUE_REFUSED'));
    });
  }

  async processNow(msg: RuleMessage, opts: { chainId?: string } = {}): Promise<void> {
    await this.ensureConfig();
    await this.runFlow({ msg, entry: opts.chainId ? { kind: 'chain', chainId: opts.chainId } : { kind: 'root' } });
  }

  private onDrop(item: QueueItem): void {
    item.deferred?.reject(new Error('QUEUE_FULL'));
    const now = Date.now();
    if (now - this.lastDropLogAt >= 60_000) {
      this.lastDropLogAt = now;
      logger.warn({ dropped: this.queue.dropped, capacity: this.cfg.queueCapacity },
        '[rule-engine] the queue is full — the oldest message of the busiest originator was dropped (logged once a minute)');
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    try {
      await this.runFlow(item);
      item.deferred?.resolve();
    } catch (err) {
      item.deferred?.reject(err instanceof Error ? err : new Error(errorText(err)));
      throw err;
    }
  }

  // ── one message ───────────────────────────────────────────────────────────

  private async runFlow(item: QueueItem): Promise<void> {
    const flow: Flow = { deadline: Date.now() + this.deps.budgetMs, steps: [], abandoned: false, chainsEntered: new Set() };
    try {
      await this.hydrate(item.msg);
      await this.enter(flow, item.msg, item.entry);
      while (flow.steps.length > 0 && !flow.abandoned) {
        if (Date.now() > flow.deadline) {
          flow.abandoned = true;
          this.inc('timeouts');
          break;
        }
        await this.runStep(flow, flow.steps.shift()!);
      }
      if (flow.abandoned && flow.steps.length > 0) {
        this.inc('steps_abandoned', flow.steps.length);
        flow.steps.length = 0;
      }
    } finally {
      this.countProcessed(flow);
    }
  }

  private async enter(flow: Flow, msg: RuleMessage, entry: Entry): Promise<void> {
    if (entry.kind === 'root') {
      const root = await this.deps.getRootChain();
      if (!root) {
        this.inc('no_root_chain');
        return;
      }
      this.startChain(flow, root, msg);
      return;
    }
    const chain = await this.deps.getChain(entry.chainId);
    if (!chain) {
      this.inc('chain_missing');
      return;
    }
    if (entry.kind === 'chain') {
      this.startChain(flow, chain, msg);
      return;
    }
    const node = chain.nodesById.get(entry.nodeId);
    if (!node) {
      this.inc('node_missing');
      return;
    }
    flow.chainsEntered.add(chain.id);
    if (entry.kind === 'node') {
      flow.steps.push({ chain, nodeId: node.id, msg, inRelation: null });
      return;
    }
    const r = entry.replay;
    let emission: Emission;
    if (r.kind === 'next') emission = { kind: 'next', msg, relations: r.relations };
    else if (r.kind === 'failure') emission = { kind: 'failure', msg, error: r.error };
    else if (r.kind === 'output') emission = { kind: 'output', msg, label: r.label };
    else {
      const target = await this.deps.getChain(r.targetChainId);
      emission = target
        ? { kind: 'chain', msg, chain: target }
        : { kind: 'failure', msg: failureMessage(msg, `RULE_CHAIN_NOT_FOUND: rule chain ${r.targetChainId} does not exist`), error: `RULE_CHAIN_NOT_FOUND: rule chain ${r.targetChainId} does not exist` };
    }
    await this.applyEmissions(flow, chain, node, [emission]);
  }

  private startChain(flow: Flow, chain: LoadedRuleChain, msg: RuleMessage): void {
    flow.chainsEntered.add(chain.id);
    if (!chain.firstNodeId || !chain.nodesById.has(chain.firstNodeId)) {
      this.inc('chain_empty');
      return;
    }
    flow.steps.push({ chain, nodeId: chain.firstNodeId, msg, inRelation: null });
  }

  private record(chain: LoadedRuleChain, node: RuleChainNode, direction: RuleDebugDirection, relation: string | null, msg: RuleMessage, error: string | null = null): void {
    try {
      this.deps.debug.record({ chainId: chain.id, nodeId: node.id, direction, relation, msg, error });
    } catch {
      this.inc('debug_errors');
    }
  }

  private async runStep(flow: Flow, step: Step): Promise<void> {
    const { chain, msg } = step;
    const node = chain.nodesById.get(step.nodeId);
    if (!node) {
      this.inc('node_missing');
      return;
    }
    const mode: RuleDebugMode = node.debugMode;
    msg._hops = (msg._hops ?? 0) + 1;
    if (msg._hops > this.cfg.hopLimit) {
      this.inc('hop_limit');
      if (mode !== 'off') {
        this.record(chain, node, 'IN', step.inRelation, msg);
        this.record(chain, node, 'OUT', `Failure${UNHANDLED_SUFFIX}`, failureMessage(msg, 'HOP_LIMIT'), 'HOP_LIMIT');
      }
      return;
    }
    if (mode === 'all') this.record(chain, node, 'IN', step.inRelation, msg);

    const emissions: Emission[] = [];
    const { ctx, close } = this.contextFor(chain, node, flow, emissions);
    const registered = getHandler(node.type);
    let timedOut = false;
    try {
      if (!registered) {
        const label = RULE_NODE_TYPE_BY_ID.get(node.type)?.label ?? node.type;
        throw new Error(`UNSUPPORTED_NODE: "${label}" has no handler in this system`);
      }
      await this.withBudget(() => registered.handler(ctx, msg), flow.deadline);
    } catch (err) {
      if (err === BUDGET_EXCEEDED) timedOut = true;
      else emissions.push({ kind: 'failure', msg: failureMessage(msg, err), error: errorText(err) });
    } finally {
      close();
    }

    if (timedOut) {
      flow.abandoned = true;
      this.inc('timeouts');
      if (mode === 'failures') this.record(chain, node, 'IN', step.inRelation, msg);
      if (mode !== 'off') this.record(chain, node, 'OUT', `Failure${UNHANDLED_SUFFIX}`, failureMessage(msg, 'MESSAGE_TIMEOUT'), 'MESSAGE_TIMEOUT');
      return;
    }
    if (mode === 'failures' && emissions.some(isFailure)) this.record(chain, node, 'IN', step.inRelation, msg);
    await this.applyEmissions(flow, chain, node, emissions);
  }

  private async withBudget(fn: () => Promise<void> | void, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw BUDGET_EXCEEDED;
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(BUDGET_EXCEEDED), remaining);
      timer.unref();
    });
    try {
      await Promise.race([Promise.resolve().then(fn), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async applyEmissions(flow: Flow, chain: LoadedRuleChain, node: RuleChainNode, emissions: Emission[]): Promise<void> {
    // Every delivery gets its own message: the first use of an object takes it, any further use a copy.
    const used = new Set<RuleMessage>();
    const take = (m: RuleMessage) => {
      if (!used.has(m)) {
        used.add(m);
        return m;
      }
      return copyMessage(m);
    };
    for (const e of emissions) {
      if (flow.abandoned) return;
      if (e.kind === 'next') {
        for (const relation of e.relations) this.routeOut(flow, chain, node, e.msg, relation, take, null);
      } else if (e.kind === 'failure') {
        this.routeOut(flow, chain, node, e.msg, 'Failure', take, e.error);
      } else if (e.kind === 'output') {
        await this.routeOutput(flow, chain, node, take(e.msg), e.label);
      } else {
        const msg = take(e.msg);
        msg._stack = [...(msg._stack ?? []), { chainId: chain.id, nodeId: node.id }];
        this.startChain(flow, e.chain, msg);
      }
    }
  }

  private routeOut(
    flow: Flow, chain: LoadedRuleChain, node: RuleChainNode, msg: RuleMessage, relation: string,
    take: (m: RuleMessage) => RuleMessage, error: string | null,
  ): void {
    const targets = chain.outgoing.get(node.id)?.get(relation) ?? [];
    const failure = relation === 'Failure';
    const record = node.debugMode === 'all' || (node.debugMode === 'failures' && failure);
    const err = failure ? (error ?? msg.metadata.error ?? null) : null;
    if (targets.length === 0) {
      if (record) this.record(chain, node, 'OUT', `${relation}${failure ? UNHANDLED_SUFFIX : UNCONNECTED_SUFFIX}`, msg, err);
      if (failure) this.inc('unhandled_failures');
      return;
    }
    if (record) this.record(chain, node, 'OUT', relation, msg, err);
    for (const to of targets) flow.steps.push({ chain, nodeId: to, msg: take(msg), inRelation: relation });
  }

  private async routeOutput(flow: Flow, chain: LoadedRuleChain, node: RuleChainNode, msg: RuleMessage, label: string): Promise<void> {
    const stack = msg._stack ?? [];
    const frame = stack[stack.length - 1];
    if (!frame) {
      if (node.debugMode === 'all') this.record(chain, node, 'OUT', `${label}${NO_CALLER_SUFFIX}`, msg);
      return;
    }
    if (node.debugMode === 'all') this.record(chain, node, 'OUT', label, msg);
    msg._stack = stack.slice(0, -1);
    const caller = await this.deps.getChain(frame.chainId);
    const callerNode = caller?.nodesById.get(frame.nodeId);
    if (!caller || !callerNode) {
      this.inc('caller_missing');
      return;
    }
    flow.chainsEntered.add(caller.id);
    this.routeOut(flow, caller, callerNode, msg, label, (m) => m, null);
  }

  // ── node contexts ─────────────────────────────────────────────────────────

  /**
   * A context bound to one node. While `open` (the handler is running for a
   * flow) its calls are collected into `emissions`; afterwards — or always,
   * for a lifecycle context (`flow` null) — a call is a NEW message through
   * the queue, unless the flow was abandoned.
   */
  private contextFor(chain: LoadedRuleChain, node: RuleChainNode, flow: Flow | null, emissions: Emission[] | null): { ctx: RuleContext; close(): void } {
    let open = emissions !== null;
    const config = ruleNodeConfigWithDefaults(node.type, node.config);
    const late = (replay: Replay, msg: RuleMessage) => {
      if (flow?.abandoned || !this.accepting()) {
        this.inc('late_dropped');
        return;
      }
      if (!this.queue.push({ msg, entry: { kind: 'replay', chainId: chain.id, nodeId: node.id, replay } })) this.inc('late_dropped');
    };
    const ctx: RuleContext = {
      node: { id: node.id, name: node.name, type: node.type, config, debugMode: node.debugMode },
      chain: { id: chain.id, name: chain.name },
      config,
      services: this.servicesHandle,
      origin: ruleNodeOrigin(chain.id, node.id),
      tellNext: (msg, relations) => {
        const list = Array.isArray(relations) ? [...relations] : [relations];
        if (open) emissions!.push({ kind: 'next', msg, relations: list });
        else late({ kind: 'next', relations: list }, msg);
      },
      tellFailure: (msg, err) => {
        const failed = failureMessage(msg, err);
        if (open) emissions!.push({ kind: 'failure', msg: failed, error: errorText(err) });
        else late({ kind: 'failure', error: errorText(err) }, failed);
      },
      tellSelf: async (msg, delayMs) => {
        if (!this.accepting() || flow?.abandoned) {
          this.inc('late_dropped');
          return;
        }
        const timer = setTimeout(() => {
          this.selfTimers.delete(timer);
          if (!this.accepting() || !this.queue.push({ msg, entry: { kind: 'node', chainId: chain.id, nodeId: node.id } })) this.inc('late_dropped');
        }, Math.max(0, delayMs));
        timer.unref();
        this.selfTimers.add(timer);
      },
      callChain: async (chainId, msg) => {
        const target = await this.deps.getChain(chainId);
        if (!target) {
          ctx.tellFailure(msg, new Error(`RULE_CHAIN_NOT_FOUND: rule chain ${chainId} does not exist`));
          return;
        }
        if (open) emissions!.push({ kind: 'chain', msg, chain: target });
        else late({ kind: 'chain', targetChainId: chainId }, msg);
      },
      output: (msg, label) => {
        if (open) emissions!.push({ kind: 'output', msg, label });
        else late({ kind: 'output', label }, msg);
      },
      log: (level: RuleLogLevel, text: string) => {
        logger[level]({ chainId: chain.id, nodeId: node.id }, `[rule-chain ${chain.name}/${node.name}] ${text}`);
      },
    };
    return { ctx, close: () => { open = false; } };
  }

  // ── enrichment ────────────────────────────────────────────────────────────

  private async hydrate(msg: RuleMessage): Promise<void> {
    const md = msg.metadata;
    const instrumentId = msg.originator.type === 'INSTRUMENT' ? msg.originator.id : md.instrumentId;
    if (!instrumentId) return;
    if (md.instrumentCode && md.instrumentName && md.profileName && (msg.originator.type !== 'INSTRUMENT' || msg.originator.code)) return;
    try {
      const info = await this.deps.instrumentInfo(instrumentId);
      if (!info) return;
      if (!md.instrumentCode) md.instrumentCode = info.code;
      if (!md.instrumentName) md.instrumentName = info.name;
      if (!md.profileName && info.profileName) md.profileName = info.profileName;
      if (msg.originator.type === 'INSTRUMENT' && !msg.originator.code) msg.originator.code = info.code;
    } catch (err) {
      this.inc('hydrate_errors');
      logger.debug({ err: errorText(err) }, '[rule-engine] instrument metadata could not be filled in');
    }
  }

  // ── node lifecycles ───────────────────────────────────────────────────────

  syncLifecycles(opts: { force?: boolean } = {}): Promise<void> {
    if (this.lifecycleBusy) return this.lifecycleBusy;
    this.lifecycleBusy = this.doSyncLifecycles(opts.force === true).finally(() => { this.lifecycleBusy = null; });
    return this.lifecycleBusy;
  }

  private async doSyncLifecycles(force: boolean): Promise<void> {
    try {
      if (!hasLifecycleHandlers() && this.instances.size === 0) return;
      const rows = await this.deps.listChains();
      const live = new Set(rows.map((r) => r.id));
      for (const [key, inst] of [...this.instances]) if (!live.has(inst.chain.id)) await this.destroyInstance(key);
      for (const row of rows) {
        const version = row.updatedAt.getTime();
        if (!force && this.chainVersions.get(row.id) === version) continue;
        this.chainVersions.set(row.id, version);
        this.deps.invalidateChain(row.id);
        const chain = await this.deps.getChain(row.id);
        if (!chain) continue;
        const wanted = new Map<string, RuleChainNode>();
        for (const node of chain.document.nodes) {
          const reg = getHandler(node.type);
          if (reg?.onInit || reg?.onDestroy) wanted.set(`${chain.id}:${node.id}`, node);
        }
        for (const [key, inst] of [...this.instances]) {
          if (inst.chain.id !== chain.id) continue;
          const node = wanted.get(key);
          if (!node || fingerprintOf(node) !== inst.fingerprint) await this.destroyInstance(key);
        }
        for (const [key, node] of wanted) if (!this.instances.has(key)) await this.initInstance(key, chain, node);
      }
      for (const id of [...this.chainVersions.keys()]) if (!live.has(id)) this.chainVersions.delete(id);
    } catch (err) {
      this.inc('lifecycle_errors');
      logger.error({ err: errorText(err) }, '[rule-engine] node lifecycles could not be synchronised');
    }
  }

  private async initInstance(key: string, chain: LoadedRuleChain, node: RuleChainNode): Promise<void> {
    const reg = getHandler(node.type) as RegisteredRuleNode | undefined;
    this.instances.set(key, { key, fingerprint: fingerprintOf(node), chain, node });
    if (!reg?.onInit) return;
    try {
      await reg.onInit(this.contextFor(chain, node, null, null).ctx);
    } catch (err) {
      this.inc('init_errors');
      logger.error({ err: errorText(err), chain: chain.name, node: node.name }, '[rule-engine] a node failed to start');
    }
  }

  private async destroyInstance(key: string): Promise<void> {
    const inst = this.instances.get(key);
    if (!inst) return;
    this.instances.delete(key);
    const reg = getHandler(inst.node.type) as RegisteredRuleNode | undefined;
    if (!reg?.onDestroy) return;
    try {
      await reg.onDestroy(this.contextFor(inst.chain, inst.node, null, null).ctx);
    } catch (err) {
      this.inc('destroy_errors');
      logger.error({ err: errorText(err), chain: inst.chain.name, node: inst.node.name }, '[rule-engine] a node failed to stop');
    }
  }

  // ── stats ─────────────────────────────────────────────────────────────────

  private countProcessed(flow: Flow): void {
    const sec = Math.floor(Date.now() / 1000);
    let bucket = this.window.get(sec);
    if (!bucket) {
      bucket = { total: 0, chains: new Map() };
      this.window.set(sec, bucket);
      for (const s of this.window.keys()) if (s <= sec - WINDOW_SECONDS) this.window.delete(s);
    }
    bucket.total++;
    for (const id of flow.chainsEntered) bucket.chains.set(id, (bucket.chains.get(id) ?? 0) + 1);
    this.inc('processed');
  }

  stats(): RuleEngineStats {
    const since = Math.floor(Date.now() / 1000) - WINDOW_SECONDS;
    let total = 0;
    const perChain = new Map<string, number>();
    for (const [sec, bucket] of this.window) {
      if (sec <= since) continue;
      total += bucket.total;
      for (const [id, n] of bucket.chains) perChain.set(id, (perChain.get(id) ?? 0) + n);
    }
    return {
      started: this.isStarted,
      enabled: this.cfg.enabled,
      queueDepth: this.queue.size,
      inFlight: this.queue.inFlight,
      dropped: this.queue.dropped,
      processedLastMinute: total,
      chains: [...perChain.entries()].map(([id, n]) => ({ id, processedLastMinute: n })).sort((a, b) => b.processedLastMinute - a.processedLastMinute),
      counters: { ...Object.fromEntries(this.counters), ...emitCounters() },
    };
  }

  async runScript(kind: RuleScriptKind, script: string, msg: unknown, metadata: Record<string, string>, msgType: string): Promise<unknown> {
    if (!this.configLoaded) await this.refreshConfig().catch(() => undefined);
    return runVmScript(kind, script, msg, metadata, msgType, this.cfg.scriptTimeoutMs);
  }

  async drain(): Promise<void> {
    await this.queue.onIdle();
    await this.deps.debug.flush?.();
  }
}

// ─── defaults and the singleton ──────────────────────────────────────────────

const INFO_TTL_MS = 30_000;
const INFO_MAX = 5_000;
const infoCache = new Map<string, { value: InstrumentInfo | null; at: number }>();

/** An instrument's code, name and profile name, cached 30 s (a missing one too). */
export async function cachedInstrumentInfo(id: string): Promise<InstrumentInfo | null> {
  const now = Date.now();
  const hit = infoCache.get(id);
  if (hit && now - hit.at < INFO_TTL_MS) return hit.value;
  const row = await prisma.instrument.findUnique({ where: { id }, select: { code: true, name: true, profile: { select: { name: true } } } });
  const value = row ? { code: row.code, name: row.name, profileName: row.profile?.name ?? null } : null;
  if (infoCache.size >= INFO_MAX) infoCache.clear();
  infoCache.set(id, { value, at: now });
  return value;
}

/** Test seam. */
export function clearInstrumentInfoCache(): void {
  infoCache.clear();
}

export function defaultRuleEngineDeps(): RuleEngineDeps {
  const writer = new RuleDebugWriter();
  return {
    getChain: cachedChain,
    getRootChain: cachedRootChain,
    loadConfig: getRuleEngineConfig,
    invalidateChain: (id) => invalidateChainCache(id),
    listChains: () => prisma.ruleChain.findMany({ select: { id: true, updatedAt: true } }),
    instrumentInfo: cachedInstrumentInfo,
    debug: writer,
    services: (hooks) => createRuleServices(hooks),
    registerNodes: registerAllNodes,
    installSink: true,
    budgetMs: 30_000,
    configRefreshMs: 1_000,
    lifecyclePollMs: 5_000,
  };
}

/** An engine; anything not given is the production default. */
export function createRuleEngine(deps: Partial<RuleEngineDeps> = {}): RuleEngine {
  const base = defaultRuleEngineDeps();
  return new RuleEngineImpl({ ...base, ...deps });
}

/** THE engine of this process: started by app.ts after the job runner, stopped on shutdown. */
export const ruleEngine: RuleEngine = createRuleEngine();
