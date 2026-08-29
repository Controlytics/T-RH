/**
 * Child ROSTER downlink — telling a gateway which instruments are under it.
 *
 * The attribute downlink (`attribute-downlink.ts`) already reaches a gateway
 * for each child, addressed as `instruments/<gw>/attributes/<child>`. But that
 * only ever announces a child that CHANGED: a linked child whose attributes
 * have never been touched is invisible to its gateway, and link/unlink itself
 * publishes nothing at all. A gateway therefore could not answer "which
 * instruments am I responsible for" from the broker alone.
 *
 * This closes that. One retained slot per gateway, carrying the whole
 * membership.
 *
 * ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * Not an authorisation surface. The roster is a convenience for the device; the
 * DATABASE decides which credential may write for which instrument, via
 * `gateway-children.ts` / `gateway-fanout.ts`. A gateway that acts on a stale
 * roster still cannot write for an instrument that is no longer its child — the
 * ingest path refuses it. Every failure here is logged and swallowed, exactly
 * as on the attribute path.
 */

import { publishRetained, type PublishLogger } from './attribute-downlink.js';
import { logger } from '../../lib/logger.js';

/** One line of the roster. */
export interface RosterChild {
  code: string;
  name: string;
  isActive: boolean;
}

/**
 * A SEPARATE topic, deliberately not a segment under `…/attributes/`. The
 * attribute subtree addresses children in its last segment, so a reserved word
 * there would have to be one no id could ever equal — a sibling topic needs no
 * such argument.
 *
 * The segment is the gateway's UUID, not its code (2026-08-07): the code became
 * free text, and a code containing `/`, `+` or `#` would forge a topic shape or
 * match the ACL against every instrument.
 *
 * The gateway subscribes `instruments/<gatewayId>/children`. Its ACL rule
 * (`{allow, all, subscribe, ["instruments/${clientid}/children"]}`) rests on the
 * same client-id binding as every other rule: the auth hook refuses a CONNECT
 * whose client id is not the token's instrument id, so `${clientid}` is a
 * proven identity, not a claim.
 *
 * Only a GATEWAY has a roster. Never call this with a standalone or child id.
 */
export function childRosterTopic(gatewayId: string): string {
  return `instruments/${gatewayId}/children`;
}

/**
 * Its own prefix. Sharing `publishRetained` must not mean sharing the attribute
 * path's `[downlink:attributes]` tag — an operator grepping the log for why a
 * gateway is out of date should not be told the wrong subsystem.
 */
const rosterLog: PublishLogger = (msg, meta) => logger.warn(`[downlink:children] ${msg}`, meta ?? '');

export interface ChildRosterPayload {
  children: RosterChild[];
  ts: string;
}

/**
 * The whole membership, every time — never a delta.
 *
 * The retained message is the only copy on the broker, so a gateway coming back
 * from a power cut has to reconstruct the truth from one message. A delta
 * ("child X was added") is unreconstructable in that situation, which is the
 * same reasoning that puts the complete attribute set in the attribute payload.
 *
 * INACTIVE children are INCLUDED, carrying `isActive: false`. Dropping them
 * would make a deactivated instrument indistinguishable from an unlinked one,
 * and those need different handling: an unlinked child has moved out of this
 * gateway's world, a deactivated one is still its responsibility and is
 * expected back.
 *
 * Sorted by code so that a gateway diffing two messages sees a difference only
 * when the membership actually differs — `findMany` gives no ordering
 * guarantee, and an unordered array would produce spurious diffs.
 */
export function buildChildRosterPayload(children: RosterChild[], ts: Date): ChildRosterPayload {
  return {
    children: [...children].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    ts: ts.toISOString(),
  };
}

/**
 * Publish one gateway's roster. NEVER THROWS.
 *
 * CALL AFTER THE TRANSACTION COMMITS, and read `children` after it too: an
 * in-transaction read is internally consistent but blind to a concurrent commit
 * that linked or unlinked a DIFFERENT child, so it could retain a membership
 * that was never true. Post-commit is the fresher answer — the same rule, for
 * the same reason, as `announceAttributeChange`.
 */
export async function publishChildRoster(
  gatewayId: string,
  children: RosterChild[],
  ts: Date,
  log?: PublishLogger,
): Promise<void> {
  await publishRetained(
    childRosterTopic(gatewayId),
    JSON.stringify(buildChildRosterPayload(children, ts)),
    'roster NOT DELIVERED — the gateway was not told about this membership change',
    log ?? rosterLog,
  );
}

/**
 * Clear a gateway's slot with a zero-byte retained publish.
 *
 * A retained message is cleared ONLY this way, and nothing else in this
 * codebase does it: `LOCAL_SETUP_WINDOWS.md` names three cases where a slot is
 * stranded after the thing it describes is gone. A deleted gateway would be a
 * fourth — and a worse one, because a roster names instruments that are still
 * live and now belong to nobody. Deleting the gateway clears it here instead.
 */
export async function clearChildRoster(gatewayId: string, log?: PublishLogger): Promise<void> {
  await publishRetained(
    childRosterTopic(gatewayId),
    '',
    'roster NOT CLEARED — the broker still holds a membership for a deleted gateway',
    log ?? rosterLog,
  );
}
