/**
 * Bypass-flow guards (Phase 8.5).
 *
 * Pure portions of bypass() in
 * `apps/api/src/modules/filter-operations/filter-operations.service.ts`
 * (lines 1604-1616).
 */
import type { GuardResult, LocalContext } from './types.js';

/** Guard #38: bypass requires `flowMode === 'BYPASS_ENABLED'`. */
export function assertBypassAllowed(
  _ctx: LocalContext,
  flowMode: string | null | undefined,
): GuardResult {
  if (flowMode === 'BYPASS_ENABLED') return { ok: true };
  return {
    ok: false,
    code: 'BYPASS_FORBIDDEN',
    message: 'Profile flow mode is STRICT — bypass not allowed',
  };
}

/** Guard #39: bypass target must be a STAGE node in the pipeline. */
export function assertBypassTargetStateValid(
  _ctx: LocalContext,
  targetState: string,
  validStates: (string | null)[],
): GuardResult {
  const cleanedValid = validStates.filter((s): s is string => typeof s === 'string');
  if (cleanedValid.includes(targetState)) return { ok: true };
  return {
    ok: false,
    code: 'INVALID_TARGET',
    message: `Invalid target state: ${targetState}. Valid: ${cleanedValid.join(', ')}`,
  };
}

/**
 * Tape-generator helper — `assertCanBypassTo`: pipeline-node membership +
 * "not the current state" check. Different shape from #39 because the tape
 * generator emits BYPASS_STAGE actions for ALL stages except current; the
 * server's bypass() route validates submission against the same set
 * (validStates). Keeping both names for clarity at call sites.
 */
export function assertCanBypassTo(
  ctx: LocalContext,
  targetStateKey: string,
): GuardResult {
  const validStates = ctx.profile.nodes
    .filter(s => s.nodeType === 'STAGE' && s.stateKey)
    .map(s => s.stateKey as string);
  if (!validStates.includes(targetStateKey)) {
    return {
      ok: false,
      code: 'INVALID_TARGET',
      message: `Invalid target state: ${targetStateKey}. Valid: ${validStates.join(', ')}`,
    };
  }
  if (ctx.filter.currentLifecycleState === targetStateKey) {
    return {
      ok: false,
      code: 'INVALID_TARGET',
      message: `Cannot bypass to current state: ${targetStateKey}`,
    };
  }
  return { ok: true };
}
