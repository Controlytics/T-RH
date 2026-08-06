import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The gateway invariants (spec D2/D3/D6) live here rather than in `routes.ts`
 * because they are enforced TWICE per write, in two different ways:
 *
 *  1. `gatewayInvariantError` — a pre-flight read, before the transaction
 *     opens. It produces the good operator-facing message ("unlink C2, C7
 *     first") and handles the common path.
 *  2. `lockedGatewayRecheck` — the correctness backstop, inside the caller's
 *     transaction and under a row lock. The pre-flight ALONE is racy: two
 *     concurrent requests can each pass it and commit a state that every
 *     sequential path refuses.
 *
 * Neither can be a CHECK constraint: two of the three rules read a different
 * row. (The one that doesn't — "an instrument is not its own gateway" — IS
 * additionally a CHECK, `instruments_gateway_not_self`.)
 */

/** Thrown by `lockedGatewayRecheck`; rolls back the caller's transaction. */
export class GatewayInvariantViolation extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; message: string },
  ) {
    super(body.message);
    this.name = 'GatewayInvariantViolation';
  }
}

/**
 * Spec D2/D3 invariants. Returns an error payload, or null when the write is
 * allowed. Cannot be a CHECK constraint — two of the three rules read a
 * different row.
 */
export async function gatewayInvariantError(
  next: { isGateway?: boolean; gatewayId?: string | null },
  current: { id: string; isGateway: boolean; gatewayId: string | null } | null,
): Promise<{ status: number; body: { error: string; message: string } } | null> {
  const isGateway = next.isGateway ?? current?.isGateway ?? false;
  const gatewayId = next.gatewayId === undefined ? (current?.gatewayId ?? null) : next.gatewayId;

  if (isGateway && gatewayId) {
    return { status: 400, body: { error: 'NESTED_GATEWAY', message: 'A gateway cannot itself be linked to another gateway. Unlink it first.' } };
  }
  if (current && gatewayId === current.id) {
    return { status: 400, body: { error: 'SELF_GATEWAY', message: 'An instrument cannot be its own gateway.' } };
  }
  if (gatewayId) {
    const parent = await prisma.instrument.findUnique({
      where: { id: gatewayId }, select: { id: true, code: true, isGateway: true },
    });
    if (!parent) return { status: 400, body: { error: 'NOT_FOUND', message: 'The selected gateway does not exist.' } };
    if (!parent.isGateway) {
      return { status: 400, body: { error: 'NOT_A_GATEWAY', message: `Instrument "${parent.code}" is not configured as a gateway.` } };
    }
  }
  // Spec D6 — refusing beats silently unlinking, which would stop those
  // sensors reporting with nothing in the UI to say why.
  if (current?.isGateway && next.isGateway === false) {
    const kids = await prisma.instrument.findMany({ where: { gatewayId: current.id }, select: { code: true } });
    if (kids.length > 0) {
      return {
        status: 409,
        body: {
          error: 'GATEWAY_HAS_CHILDREN',
          message: `Unlink these instruments before disabling gateway mode: ${kids.map((k) => k.code).join(', ')}.`,
        },
      };
    }
  }
  return null;
}

type LockedRow = { id: string; code: string; is_gateway: boolean };

/** Postgres 40P01. Prisma surfaces raw-query deadlocks as an untyped message. */
export function isDeadlock(err: unknown): boolean {
  return err instanceof Error && /40P01|deadlock detected/i.test(err.message);
}

/**
 * Take `FOR UPDATE` row locks on the given instruments, in the order given,
 * and return what was locked (missing ids are simply absent).
 *
 * MUST BE THE FIRST STATEMENT OF THE CALLER'S TRANSACTION. Not a style rule —
 * a correctness one, for two separate reasons:
 *
 * 1. DEADLOCK. `auditLog` takes `pg_advisory_xact_lock(AUDIT_CHAIN_LOCK_ID)`
 *    as the first statement of every audit write and holds it to commit, so a
 *    request that mutates before locking runs in the order
 *    `own row -> advisory -> gateway row`. Against a concurrent link
 *    (`own row -> advisory` where "own row" IS the child) that cycles:
 *
 *      A: UPDATE GW [locks GW] -> auditLog -> WAITS on advisory
 *      B: UPDATE C  [locks C]  -> auditLog [holds advisory]
 *                              -> FOR UPDATE GW -> WAITS on A
 *
 *    Postgres breaks it with 40P01 after ~1s and the clean 409 becomes a 500.
 *    Locking first makes the order `gateway row -> own row -> advisory` on
 *    EVERY path, so nobody can hold the advisory lock while waiting for a
 *    gateway row.
 * 2. It makes the re-check's position moot. Holding the gateway row from the
 *    start means nothing can change underneath the check, so it is equally
 *    sound before or after the caller's mutation.
 *
 * LOCK ORDER IS THE CALLER'S ORDER, AND IT MUST BE **PARENT BEFORE SELF**.
 * This replaces an earlier "sort the ids" rule, which was safe only while the
 * set held two parents. It is not safe in general: `DELETE /GW` has to lock the
 * gateway BEFORE it can read a stable child list (a linker locks the parent, so
 * holding it is what stops a new child appearing), giving `GW -> children`. A
 * whole-object `PUT /C {gatewayId: GW, isGateway: false}` locks both GW and C,
 * and sorting by id puts C first whenever `C.id < GW.id` — inverting against
 * that delete about half the time. Parent-first matches the delete on every
 * path.
 *
 * Residual, deliberately accepted: two mirrored demote-and-link requests
 * (`PUT /G1 {isGateway:false, gatewayId:G2}` against its mirror on G2) acquire
 * two PARENTS in opposite orders, which no parent-before-self rule can order.
 * `PUT` retries once on a deadlock rather than distorting the general rule for
 * a pathological case.
 */
export async function lockInstrumentRows(
  tx: Prisma.TransactionClient,
  ids: (string | null | undefined)[],
): Promise<Map<string, LockedRow>> {
  const ordered = [...new Set(ids.filter((id): id is string => !!id))];
  const locked = new Map<string, LockedRow>();
  // One statement per id, in the caller's order: a single `WHERE id = ANY(...)`
  // would let the planner pick the lock order. There are never more than two.
  for (const id of ordered) {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT id, code, is_gateway FROM instruments WHERE id = ${id} FOR UPDATE
    `;
    if (rows[0]) locked.set(id, rows[0]);
  }
  return locked;
}

/**
 * Re-check the two cross-row invariants inside the caller's transaction, under
 * a row lock, and throw `GatewayInvariantViolation` (rolling the transaction
 * back) if they do not hold. Call it as the FIRST statement of the transaction
 * — see `lockInstrumentRows`.
 *
 * WHY THIS EXISTS. The pre-flight reads and returns before any transaction
 * opens, so this interleaving passes both checks and commits a gateway that is
 * `is_gateway = false` while a live child still points at it:
 *
 *     A: PUT /GW  {isGateway:false}   sees 0 children     -> allowed
 *     B: PUT /C   {gatewayId:GW}      sees GW.isGateway=t -> allowed
 *     A commit, B commit
 *
 * Moving the reads inside the transaction does NOT fix it: Prisma runs at Read
 * Committed, so both transactions still read pre-commit state.
 *
 * WHY A LOCK ON THE GATEWAY ROW, AND NOT ON THE CHILDREN. `SELECT ... WHERE
 * gateway_id = $self FOR UPDATE` locks the rows it can SEE — and in the race
 * above that set is empty, so it locks nothing and blocks nobody (Postgres has
 * no predicate locking below Serializable). The only row both sides of the
 * race have in common is the GATEWAY, so that is the row both sides take.
 *
 * NOT covered, deliberately: unlinking (`gatewayId: null`) locks nothing, so it
 * can race a concurrent disable of the OLD parent. Both orders are consistent —
 * either the disable sees the child and returns 409 (a retry then succeeds), or
 * the unlink lands first and the disable proceeds. No invariant breaks, so
 * there is nothing to serialise.
 *
 * `selfId` is the row the caller is about to UPDATE. It buys no invariant — the
 * caller's own `UPDATE` locks it anyway — but taking it here, before the
 * caller's before/after read, is what stops that read being stale: two
 * concurrent PUTs on the same instrument would otherwise let the loser read
 * pre-commit state, decide "gatewayId unchanged", and write no link row for a
 * link it really performed. Locked LAST, after the parents, per the
 * parent-before-self rule.
 */
export async function lockedGatewayRecheck(
  tx: Prisma.TransactionClient,
  opts: { linkTo?: string | null; disablingGatewayId?: string | null; selfId?: string | null },
): Promise<void> {
  // Parent (`linkTo`) BEFORE self — see lockInstrumentRows. `disablingGatewayId`
  // IS self on the PUT path, so the dedupe collapses the pair.
  const locked = await lockInstrumentRows(tx, [opts.linkTo, opts.disablingGatewayId, opts.selfId]);

  if (opts.linkTo) {
    const parent = locked.get(opts.linkTo);
    if (!parent) {
      throw new GatewayInvariantViolation(400, { error: 'NOT_FOUND', message: 'The selected gateway does not exist.' });
    }
    if (!parent.is_gateway) {
      throw new GatewayInvariantViolation(400, {
        error: 'NOT_A_GATEWAY',
        message: `Instrument "${parent.code}" is not configured as a gateway.`,
      });
    }
  }

  if (opts.disablingGatewayId) {
    const kids = await tx.$queryRaw<{ code: string }[]>`
      SELECT code FROM instruments WHERE gateway_id = ${opts.disablingGatewayId} ORDER BY code
    `;
    if (kids.length > 0) {
      throw new GatewayInvariantViolation(409, {
        error: 'GATEWAY_HAS_CHILDREN',
        message: `Unlink these instruments before disabling gateway mode: ${kids.map((k) => k.code).join(', ')}.`,
      });
    }
  }
}
