/**
 * Which webhook targets an alarm on a given instrument should fire.
 *
 * Pure over already-loaded data so it is testable without a database. The query
 * lives in the worker.
 *
 * Scope is modelled on role_configs.instrument_scope: functional locations, with a
 * Block expanding to its Areas via resolveLocationIds(), UNIONED with an explicit
 * instrument list. No fourth grouping concept — CLAUDE.md is explicit that there are
 * three (FunctionalLocation = logical, roomId = geometry, profileId = device type).
 */

import { resolveLocationIds, type FlNode } from '../functional-locations/tree.js';
import type { AlarmWebhookEvent, AlarmWebhookTargetShape } from '@digilog/shared';

export interface MatchContext {
  event: AlarmWebhookEvent;
  severity: string;
  instrumentId: string;
  functionalLocationId: string | null;
  /** Pre-expanded from the target's scopeLocationIds — see expandLocations. */
  locations: Set<string>;
}

/** A Block yields itself plus its Areas; an Area yields itself; an unknown id, nothing. */
export function expandLocations(scopeLocationIds: string[], nodes: FlNode[]): Set<string> {
  const out = new Set<string>();
  for (const id of scopeLocationIds) {
    for (const resolved of resolveLocationIds(id, nodes)) out.add(resolved);
  }
  return out;
}

function firesOn(t: AlarmWebhookTargetShape, event: AlarmWebhookEvent): boolean {
  if (event === 'RAISED') return t.fireOnRaised;
  if (event === 'CLEARED') return t.fireOnCleared;
  if (event === 'ACKNOWLEDGED') return t.fireOnAcknowledged;
  // TEST is an operator pressing a button on this specific target. It deliberately
  // ignores the fire flags and the scope — commissioning a hooter must not require
  // first configuring the conditions you are trying to test.
  return true;
}

export function targetMatches(t: AlarmWebhookTargetShape, ctx: MatchContext): boolean {
  if (!t.isActive) return false;
  if (!firesOn(t, ctx.event)) return false;
  if (ctx.event === 'TEST') return true;

  // NULL severities = every severity. An EMPTY ARRAY is a deliberate "none" — the same
  // asymmetry as the scope lists below, and for the same reason.
  if (t.severities !== null && !t.severities.includes(ctx.severity)) return false;

  // BOTH LISTS EMPTY MATCHES NOTHING. Never everything. A silent target is a bug
  // someone finds and fixes; a target that buzzes every hooter in the plant gets the
  // feature switched off at the panel and never switched back on.
  if (t.scopeInstrumentIds.includes(ctx.instrumentId)) return true;
  if (ctx.functionalLocationId && ctx.locations.has(ctx.functionalLocationId)) return true;
  return false;
}
