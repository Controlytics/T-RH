import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuleDebugMode } from '@digilog/shared';
import type { RuleMessage } from './message.js';
import type { RuleServices } from './services.js';
import type { RuleScriptKind, RuleScriptResult } from './script-vm.js';

/**
 * What a node HANDLER is given (rule chains, 2026-11-03; spec §6): the node,
 * its chain, its configuration (already merged over the type's defaults with
 * `ruleNodeConfigWithDefaults`), the services, and the ways a message leaves.
 *
 * ── The handler contract ──
 * `handler(ctx, msg)` decides where `msg` (or the messages it makes) goes by
 * calling, zero or more times:
 *  - `tellNext(msg, relations)` — out on one or more relation labels; the
 *    message is copied to every node connected under each label. A label with
 *    no connection ends the message there (recorded in debug as
 *    `<relation> (unconnected)`).
 *  - `tellFailure(msg, err)` — out on `Failure`, with `metadata.error` (the
 *    error's message) and `metadata.errorStack` (its first three frames).
 *  - `output(msg, label)` — the Output node: back to the node that called this
 *    chain, under `label` (the Output node's NAME).
 *  - `callChain(chainId, msg)` — the Rule chain node: into another chain's
 *    first node; that chain's Output nodes return to THIS node's connections.
 * A handler that THROWS is a `tellFailure` with the thrown error. A handler
 * that calls nothing ends the message (ThingsBoard's "acknowledged").
 *
 * Every call made while the handler is running belongs to the message being
 * processed. A call made AFTER the handler settled (a timer, a deduplication
 * window) is not lost: it enters the main queue as a new message starting at
 * this node's connections — unless the message was abandoned (the 30 s budget
 * ran out), when it is dropped and counted.
 *
 * `tellSelf(msg, delayMs)` delivers `msg` to THIS node again after `delayMs`
 * (in memory; a restart loses it — `services.durable.enqueue` survives one).
 */
export type RuleLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuleContextNode<C> {
  id: string;
  name: string;
  type: string;
  config: C;
  debugMode: RuleDebugMode;
}

export interface RuleContext<C = Record<string, unknown>> {
  node: RuleContextNode<C>;
  /**
   * `version` is the chain version `runScript` keys a node's script switch-off on (`<chainId>:<nodeId>:<version>`),
   * and Copy / Delete keys their key-pattern switch-off: ONE value, read through one function in the engine. A
   * flow's is the chain it runs on; a LIFECYCLE context (a Generator's) outlives saves that do not restart its node,
   * so its version is the one the last sync saw — read it when needed, never keep a copy (FW-N3 follow-up c).
   */
  chain: { readonly id: string; readonly name: string; readonly version: number };
  /** The same object as `node.config`. */
  config: C;
  services: RuleServices;
  /** `rule_node:<chainId>:<nodeId>` — the origin a write made by this node passes to the services (spec §5's loop guard). */
  origin: string;
  /** `<chainId>:<nodeId>` — the key for ANY per-node state (an MQTT client, a window, a counter). Two chains may share node ids. */
  nodeKey: string;
  tellNext(msg: RuleMessage, relations: string | string[]): void;
  tellFailure(msg: RuleMessage, err: unknown): void;
  tellSelf(msg: RuleMessage, delayMs: number): Promise<void>;
  callChain(chainId: string, msg: RuleMessage): Promise<void>;
  output(msg: RuleMessage, label: string): void;
  log(level: RuleLogLevel, text: string): void;
  /**
   * Run a node script on `msg` (its data, metadata and type) with the
   * configured time budget. USE THIS, not script-vm's `runScript` directly:
   * it is keyed to this node and chain version, so a script that times out 3
   * times in a row is disabled (`SCRIPT_DISABLED`) until the chain is saved.
   * Throws `RuleScriptError` (a handler that lets it propagate sends the
   * message to Failure with `metadata.error`).
   */
  runScript<K extends RuleScriptKind>(kind: K, script: string, msg: RuleMessage): RuleScriptResult<K>;
}

export type RuleNodeHandler<C = Record<string, unknown>> = (ctx: RuleContext<C>, msg: RuleMessage) => Promise<void> | void;

// ─── the flow context (ruling RE-1) ─────────────────────────────────────────

/**
 * THE FLOW CONTEXT (ruling RE-1, 2026-11-05): what the engine knows about the
 * message whose flow is running, carried by `AsyncLocalStorage` from
 * `runFlow` (engine.ts) through every await of every handler and service —
 * the write path, a promise another context resolves, a timer — down to the
 * emit helpers' `deliver()` (emit.ts).
 *
 * It is decided ONCE, when the message is ADMITTED, and carried on the queue
 * item — never read from metadata, which a script can rewrite:
 *  - a message an emit helper admits with a `rule_node:` origin has depth 1
 *    (it RE-ENTERED); any other origin (a device, a person, the system, the
 *    REST API) depth 0;
 *  - a late call, a `tellSelf` and a Delay / Checkpoint resume keep the depth
 *    of the flow they came from (the durable job carries it as
 *    `message._reentryDepth`); a lifecycle node's message (a Generator tick)
 *    starts at 0.
 *
 * A rule node's write made while the depth is ≥ `REENTRY_DEPTH_MAX` emits
 * nothing (`loop_skipped`): re-entry goes ONE generation deep, so a chain
 * whose writes change on every pass (Save time series with `useServerTs`, a
 * transform adding 1, a Create alarm fed its own ALARM) still ends. Stricter
 * than ThingsBoard, which has no re-enter switch at all.
 */
export interface RuleFlowContext {
  readonly reentryDepth: number;
}

/** A rule node's write re-enters only from a flow whose depth is below this. */
export const REENTRY_DEPTH_MAX = 1;

const flowStorage = new AsyncLocalStorage<RuleFlowContext>();

/** Run `fn` as one flow: everything it awaits sees `flow` (engine.ts `runFlow` — and tests). */
export function runInFlow<T>(flow: RuleFlowContext, fn: () => T): T {
  return flowStorage.run(flow, fn);
}

/** The running flow's re-entry depth; 0 outside any flow (ingest, a route, a test calling a service). */
export function currentReentryDepth(): number {
  return flowStorage.getStore()?.reentryDepth ?? 0;
}
