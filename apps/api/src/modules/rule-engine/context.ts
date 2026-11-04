import type { RuleDebugMode } from '@digilog/shared';
import type { RuleMessage } from './message.js';
import type { RuleServices } from './services.js';

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
  chain: { id: string; name: string };
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
}

export type RuleNodeHandler<C = Record<string, unknown>> = (ctx: RuleContext<C>, msg: RuleMessage) => Promise<void> | void;
