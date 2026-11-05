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
import {
  copyMessage, failureMessage, errorText, ruleNodeOrigin, ruleNodeKey, isRuleNodeOrigin, RULE_ENGINE_ORIGIN_KEY, type RuleMessage,
} from './message.js';
import { runInFlow, REENTRY_DEPTH_MAX, type RuleContext, type RuleLogLevel } from './context.js';
import { registerAllNodes } from './nodes/index.js';
import { unsupportedNodeMessage } from './nodes/unsupported.js';

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
 * removed one destroyed. A node that fails to start gets a best-effort
 * onDestroy and is retried after 5 s, 10 s, 20 s … at most every 5 minutes,
 * at once when its chain is saved. With no lifecycle type registered, it
 * never polls.
 *
 * Configuration → Rule Engine is read on a 1 s timer into a snapshot, so the
 * emit helpers decide "accepting?" without awaiting anything. Switching it
 * OFF empties the queue.
 *
 * RE-ENTRY (ruling RE-1): every flow runs in a flow context (context.ts)
 * carrying the re-entry depth decided when its message was admitted; a rule
 * node's write inside a re-entered flow emits nothing (emit.ts).
 *
 * DURABLE RESUMES (ruling RE-2): a Delay / Checkpoint message the durable
 * worker re-injects (`resumeAfter`) is the only copy once admitted — the full
 * queue never evicts it (it refuses a new one instead), and `stop()` hands
 * every one still waiting back to graphile (`durable_requeued`; a failed hand-
 * back is `durable_dropped`, logged). Ordinary messages still waiting at stop
 * are dropped, as before.
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
  debug: { record(e: RuleDebugEventInput): void; start?(): void; stop?(): Promise<void>; flush?(): Promise<void>; configure?(opts: { maxPerNode?: number }): void };
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
   * (default `Success`) — the durable task's path. True once the Main queue
   * ADMITTED it (the job then completes); false when it was refused (engine
   * stopping or not accepting, or the queue FULL — ruling RE-2). `reentryDepth`
   * is the depth of the flow that handed it over (the job's
   * `message._reentryDepth`; ruling RE-1). Once admitted it is the message's
   * only copy, so (RE-2) a full queue never evicts it and a graceful `stop()`
   * hands it back to graphile (`services.durable.enqueue`); switching the
   * engine OFF drops it, as the worker drops a job while off. Only a CRASH
   * between admission and processing loses it (ruled 2026-11-04, review I5: a
   * job holding its graphile slot for the whole flow blocked the per-originator
   * queue behind a slow chain).
   */
  resumeAfter(msg: RuleMessage, chainId: string, nodeId: string, relations?: string[], opts?: { reentryDepth?: number }): boolean;
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
  /**
   * The flow's re-entry depth (ruling RE-1; context.ts), decided at ADMISSION —
   * from the origin an emit helper stamped a moment earlier for a root entry,
   * from the flow it came from for a late call / tellSelf, from the job for a
   * durable resume — and never re-read from metadata, which a script can rewrite.
   */
  reentryDepth: number;
  /**
   * A resume from the durable worker (ruling RE-2): its graphile job already
   * COMPLETED when the queue admitted it, so this is its only copy — the queue
   * never evicts it, `stop()` hands it back to graphile.
   */
  durable?: true;
}

/** A message admitted with a rule node's origin re-entered: depth 1. Anything else: 0. */
const admittedDepth = (msg: RuleMessage): number => (isRuleNodeOrigin(msg.metadata[RULE_ENGINE_ORIGIN_KEY]) ? 1 : 0);

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
  /** The entering item's depth: what its late calls, tellSelf and durable hand-overs carry on. */
  reentryDepth: number;
}

interface LifecycleInstance {
  key: string;
  fingerprint: string;
  chain: LoadedRuleChain;
  node: RuleChainNode;
}

const BUDGET_EXCEEDED = Symbol('BUDGET_EXCEEDED');
const WINDOW_SECONDS = 60;
/** A failed lifecycle start is retried after 5 s, 10 s, 20 s … at most 5 minutes apart (m3). */
const INIT_RETRY_BASE_MS = 5_000;
const INIT_RETRY_MAX_MS = 300_000;

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
  /** The version each chain's lifecycle nodes were ALL started at — absent until every one started. */
  private readonly chainVersions = new Map<string, number>();
  /** Every chain's version as the last sync READ it, started or not — what a lifecycle node's script strikes key on (m1). */
  private readonly liveVersions = new Map<string, number>();
  /** A chain whose lifecycle start failed: retried at `at` (backoff), or at once when its version moves or `force` (m3). */
  private readonly initRetry = new Map<string, { version: number; failures: number; at: number }>();
  private lifecycleBusy: Promise<void> | null = null;
  private configTimer: NodeJS.Timeout | null = null;
  private lifecycleTimer: NodeJS.Timeout | null = null;
  private lastDropLogAt = 0;
  private lastConfigErrorLogAt = 0;
  private readonly lastInitErrorLogAt = new Map<string, number>();
  private readonly servicesHandle: RuleServicesHandle;

  constructor(private readonly deps: RuleEngineDeps) {
    this.queue = new OriginatorQueue<QueueItem>({
      capacity: this.cfg.queueCapacity,
      concurrency: this.cfg.concurrency,
      keyOf: (item) => `${item.msg.originator.type}:${item.msg.originator.id}`,
      isDroppable: (item) => item.durable !== true,
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
    // RE-2: a waiting durable resume is the only copy of its message (its job completed) —
    // back to graphile while the database and the job runner are still up. The rest is dropped.
    await this.handBackDurable(this.queue.clear());
    await Promise.race([this.queue.onIdle(), new Promise((r) => setTimeout(r, 5_000).unref())]);
    if (this.lifecycleBusy) await this.lifecycleBusy;
    for (const key of [...this.instances.keys()]) await this.destroyInstance(key);
    this.chainVersions.clear();
    this.liveVersions.clear();
    this.initRetry.clear();
    this.lastInitErrorLogAt.clear();
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
    this.deps.debug.configure?.({ maxPerNode: next.debugMaxEventsPerNode });
    if (wasEnabled && !next.enabled) {
      const cleared = this.queue.clear();
      if (cleared.length > 0) this.inc('cleared_on_disable', cleared.length);
      // Switched OFF drops them, as the worker drops a durable job while off (dropped_disabled).
      const durable = cleared.filter((i) => i.durable).length;
      if (durable > 0) this.inc('durable_dropped', durable);
    }
    return next;
  }

  /** Each waiting durable resume back to graphile with its relation and depth (RE-2). Never throws. */
  private async handBackDurable(items: QueueItem[]): Promise<void> {
    for (const item of items) {
      if (!item.durable || item.entry.kind !== 'replay' || item.entry.replay.kind !== 'next') continue;
      const { chainId, nodeId, replay } = item.entry;
      try {
        await this.servicesHandle.durable.enqueue(item.msg, chainId, nodeId, undefined,
          { reentryDepth: item.reentryDepth, relation: replay.relations[0] ?? 'Success' });
        this.inc('durable_requeued');
      } catch (err) {
        this.inc('durable_dropped');
        logger.error({ err: errorText(err), msgId: item.msg.id, chainId, nodeId },
          '[rule-engine] a durable (Delay / Checkpoint) message could not be handed back to the job queue on stop — it is LOST');
      }
    }
  }

  private async ensureConfig(): Promise<void> {
    if (!this.configLoaded) await this.refreshConfig();
  }

  // ── admission ─────────────────────────────────────────────────────────────

  enqueue(msg: RuleMessage): boolean {
    if (!this.accepting()) return false;
    return this.queue.push({ msg, entry: { kind: 'root' }, reentryDepth: admittedDepth(msg) });
  }

  resumeAfter(msg: RuleMessage, chainId: string, nodeId: string, relations: string[] = ['Success'], opts: { reentryDepth?: number } = {}): boolean {
    if (!this.accepting()) return false;
    // RE-2: a full queue REFUSES a resume (graphile keeps the job and tries again) — it never evicts for one.
    if (this.queue.size >= this.cfg.queueCapacity) {
      this.inc('durable_refused');
      return false;
    }
    const depth = Math.min(REENTRY_DEPTH_MAX, Math.max(0, Math.floor(Number(opts.reentryDepth) || 0)));
    return this.queue.push({ msg, entry: { kind: 'replay', chainId, nodeId, replay: { kind: 'next', relations } }, reentryDepth: depth, durable: true });
  }

  async processNow(msg: RuleMessage, opts: { chainId?: string } = {}): Promise<void> {
    await this.ensureConfig();
    await this.runFlow({ msg, entry: opts.chainId ? { kind: 'chain', chainId: opts.chainId } : { kind: 'root' }, reentryDepth: admittedDepth(msg) });
  }

  private onDrop(_item: QueueItem): void {
    const now = Date.now();
    if (now - this.lastDropLogAt >= 60_000) {
      this.lastDropLogAt = now;
      logger.warn({ dropped: this.queue.dropped, capacity: this.cfg.queueCapacity },
        '[rule-engine] the queue is full — the oldest message of the busiest originator was dropped (logged once a minute)');
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    await this.runFlow(item);
  }

  // ── one message ───────────────────────────────────────────────────────────

  /**
   * ALWAYS inside its own flow context (RE-1): the queue dispatches from a
   * `setImmediate` / `.finally` that inherits whichever flow pushed or finished
   * last, so a flow must never take its depth from the context it starts in.
   */
  private runFlow(item: QueueItem): Promise<void> {
    return runInFlow({ reentryDepth: item.reentryDepth }, () => this.runFlowInContext(item));
  }

  private async runFlowInContext(item: QueueItem): Promise<void> {
    const flow: Flow = { deadline: Date.now() + this.deps.budgetMs, steps: [], abandoned: false, chainsEntered: new Set(), reentryDepth: item.reentryDepth };
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
        throw new Error(unsupportedNodeMessage(RULE_NODE_TYPE_BY_ID.get(node.type)?.label ?? node.type));
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
    // RE-1: what this node sends later belongs to the flow it came from; a lifecycle node's message (a Generator tick) starts at 0.
    const reentryDepth = flow?.reentryDepth ?? 0;
    const late = (replay: Replay, msg: RuleMessage) => {
      if (flow?.abandoned || !this.accepting()) {
        this.inc('late_dropped');
        return;
      }
      if (!this.queue.push({ msg, entry: { kind: 'replay', chainId: chain.id, nodeId: node.id, replay }, reentryDepth })) this.inc('late_dropped');
    };
    const ctx: RuleContext = {
      node: { id: node.id, name: node.name, type: node.type, config, debugMode: node.debugMode },
      chain: { id: chain.id, name: chain.name },
      config,
      services: this.servicesHandle,
      origin: ruleNodeOrigin(chain.id, node.id),
      nodeKey: ruleNodeKey(chain.id, node.id),
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
          if (!this.accepting() || !this.queue.push({ msg, entry: { kind: 'node', chainId: chain.id, nodeId: node.id }, reentryDepth })) this.inc('late_dropped');
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
      // Keyed to this node AND the chain's CURRENT version: a save (a new updatedAt) re-enables a disabled
      // script. A handler's chain is the one just loaded; a lifecycle context (a Generator) outlives saves
      // that do not touch its node, so it reads the version the last sync saw (m1), not the one it started with.
      runScript: (kind, script, msg) => runVmScript(kind, script, msg.data, msg.metadata, msg.type, this.cfg.scriptTimeoutMs, {
        key: `${ruleNodeKey(chain.id, node.id)}:${flow ? chain.updatedAt.getTime() : (this.liveVersions.get(chain.id) ?? chain.updatedAt.getTime())}`,
      }) as never,
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
        this.liveVersions.set(row.id, version);
        if (!force && this.chainVersions.get(row.id) === version) continue;
        // A start that failed for THIS version waits out its backoff: no hot retry, and no
        // cache drop (each one cost the chain's next message a database read). A save moves
        // the version and is tried at once; `force` (tests) ignores the backoff.
        const retry = this.initRetry.get(row.id);
        if (!force && retry && retry.version === version && Date.now() < retry.at) continue;
        this.deps.invalidateChain(row.id);
        const chain = await this.deps.getChain(row.id);
        // Not recorded: a chain that could not be read is tried again at the next sync.
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
        let initialised = true;
        for (const [key, node] of wanted) {
          if (!this.instances.has(key) && !(await this.initInstance(key, chain, node))) initialised = false;
        }
        // The version is recorded only once EVERY lifecycle node of the chain started:
        // a failed onInit is retried — after 5 s, 10 s, 20 s … at most 5 min (m3) — not forgotten.
        if (initialised) {
          this.chainVersions.set(row.id, version);
          this.initRetry.delete(row.id);
        } else {
          const failures = (retry && retry.version === version ? retry.failures : 0) + 1;
          this.initRetry.set(row.id, { version, failures, at: Date.now() + Math.min(INIT_RETRY_MAX_MS, INIT_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 20)) });
        }
      }
      for (const id of [...this.chainVersions.keys()]) if (!live.has(id)) this.chainVersions.delete(id);
      for (const id of [...this.liveVersions.keys()]) if (!live.has(id)) this.liveVersions.delete(id);
      for (const id of [...this.initRetry.keys()]) if (!live.has(id)) this.initRetry.delete(id);
      for (const key of [...this.lastInitErrorLogAt.keys()]) if (!live.has(key.slice(0, key.indexOf(':')))) this.lastInitErrorLogAt.delete(key);
    } catch (err) {
      this.inc('lifecycle_errors');
      logger.error({ err: errorText(err) }, '[rule-engine] node lifecycles could not be synchronised');
    }
  }

  /**
   * True when the node started (or has no onInit). A failed start is NOT kept, so a later sync
   * retries it (after its backoff); first it gets a best-effort onDestroy (m3), since an onInit
   * that failed half way may already hold a timer or a connection.
   */
  private async initInstance(key: string, chain: LoadedRuleChain, node: RuleChainNode): Promise<boolean> {
    const reg = getHandler(node.type) as RegisteredRuleNode | undefined;
    this.instances.set(key, { key, fingerprint: fingerprintOf(node), chain, node });
    if (!reg?.onInit) return true;
    try {
      await reg.onInit(this.contextFor(chain, node, null, null).ctx);
      this.lastInitErrorLogAt.delete(key);
      return true;
    } catch (err) {
      this.instances.delete(key);
      this.inc('init_errors');
      let destroyErr: string | null = null;
      if (reg.onDestroy) {
        try {
          await reg.onDestroy(this.contextFor(chain, node, null, null).ctx);
        } catch (e) {
          this.inc('destroy_errors');
          destroyErr = errorText(e);
        }
      }
      // Once a minute per node at most (the backoff already spaces the attempts).
      const now = Date.now();
      if (now - (this.lastInitErrorLogAt.get(key) ?? 0) >= 60_000) {
        this.lastInitErrorLogAt.set(key, now);
        logger.error({ err: errorText(err), ...(destroyErr ? { cleanupErr: destroyErr } : {}), chain: chain.name, node: node.name },
          '[rule-engine] a node failed to start — retried after 5 s, 10 s, 20 s … at most every 5 min, and at once when its chain is saved');
      }
      return false;
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
