import type { RuleContext, RuleNodeHandler } from './context.js';

/**
 * The node HANDLER registry (rule chains, 2026-11-03; spec §6). One handler
 * per node type id (`tb:filter:message-type-switch` …). The type catalogue —
 * labels, relations, config schemas — is `@digilog/shared`'s `rule-nodes.ts`;
 * this holds only what RUNS.
 *
 * A type with no registered handler (a `later` / `none` node, an Unsupported
 * import, or a built node before its task lands) sends every message to
 * `Failure` with `metadata.error = "UNSUPPORTED_NODE: …"` — engine.ts.
 *
 * Lifecycle (a Generator's timer, an MQTT node's connection): `onInit(ctx)` is
 * called when a chain holding the node is loaded — at engine start, and when a
 * save changes the node — with a context bound to that node (its `tellNext`
 * starts a NEW message at the node's connections). `onDestroy(ctx)` is called
 * when the node is removed or changed, its chain deleted, or the engine stops.
 */
export interface RuleNodeLifecycle<C = Record<string, unknown>> {
  onInit?(ctx: RuleContext<C>): Promise<void> | void;
  onDestroy?(ctx: RuleContext<C>): Promise<void> | void;
}

export interface RegisteredRuleNode<C = Record<string, unknown>> extends RuleNodeLifecycle<C> {
  id: string;
  handler: RuleNodeHandler<C>;
}

const registry = new Map<string, RegisteredRuleNode<any>>();

/**
 * Register (or replace) the handler for a node type. Returns a function that
 * puts back whatever was registered before — tests override a real type id
 * with a stand-in and restore it.
 */
export function registerNode<C = Record<string, unknown>>(
  id: string,
  handler: RuleNodeHandler<C>,
  opts: RuleNodeLifecycle<C> = {},
): () => void {
  const previous = registry.get(id);
  registry.set(id, { id, handler, ...(opts.onInit ? { onInit: opts.onInit } : {}), ...(opts.onDestroy ? { onDestroy: opts.onDestroy } : {}) });
  return () => {
    if (previous) registry.set(id, previous);
    else registry.delete(id);
  };
}

export function getHandler(id: string): RegisteredRuleNode | undefined {
  return registry.get(id);
}

export function registeredNodeTypes(): string[] {
  return [...registry.keys()].sort();
}

/** Whether any registered type has a lifecycle — when none has, the engine never polls for saved chains. */
export function hasLifecycleHandlers(): boolean {
  for (const r of registry.values()) if (r.onInit || r.onDestroy) return true;
  return false;
}

/** Test seam. */
export function clearRegistry(): void {
  registry.clear();
}
