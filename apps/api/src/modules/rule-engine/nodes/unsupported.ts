import { RULE_NODE_TYPE_BY_ID, UNSUPPORTED_NODE_TYPE } from '@digilog/shared';
import { registerNode } from '../registry.js';

/**
 * `tb:unsupported` — a ThingsBoard node imported with a class this system
 * does not know, or a known class whose configuration failed its schema
 * (`fromThingsboardExport` / the forgiving read). Every message goes to
 * `Failure` with `metadata.error = "UNSUPPORTED_NODE: …"` naming the original
 * class (spec §2).
 *
 * The engine words a node type with NO registered handler (a `later` / `none`
 * node, or a built one before its task lands) the same way, through
 * `unsupportedNodeMessage` — one wording for both.
 */
export function unsupportedNodeMessage(what: string): string {
  return `UNSUPPORTED_NODE: "${what}" has no handler in this system`;
}

/** What an Unsupported node stands for: its ThingsBoard class, else the type it was read as. */
export function unsupportedNodeName(config: Record<string, unknown>): string {
  const tbClass = typeof config.tbClass === 'string' && config.tbClass ? config.tbClass : null;
  const type = typeof config.type === 'string' && config.type ? config.type : null;
  const known = type ? RULE_NODE_TYPE_BY_ID.get(type)?.label : undefined;
  return tbClass ?? known ?? type ?? UNSUPPORTED_NODE_TYPE;
}

export function registerUnsupportedNode(): void {
  registerNode(UNSUPPORTED_NODE_TYPE, (ctx, msg) => {
    ctx.tellFailure(msg, new Error(unsupportedNodeMessage(unsupportedNodeName(ctx.config))));
  });
}
