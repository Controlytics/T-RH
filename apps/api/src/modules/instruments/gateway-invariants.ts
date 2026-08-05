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

/**
 * Take `FOR UPDATE` row locks on the given instruments, **ordered by id**, and
 * return what was locked (missing ids are simply absent).
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
 * The `ORDER BY id` matters for the one request that locks TWO gateways —
 * `PUT /G1 {isGateway:false, gatewayId:G2}`, which stops being a gateway and
 * becomes a child in the same call. Its mirror on G2 would otherwise acquire
 * the same pair in the opposite order and deadlock.
 */
export async function lockInstrumentRows(
  tx: Prisma.TransactionClient,
  ids: (string | null | undefined)[],
): Promise<Map<string, LockedRow>> {
  const ordered = [...new Set(ids.filter((id): id is string => !!id))].sort();
  const locked = new Map<string, LockedRow>();
  // One statement per id, in sorted order: a single `WHERE id = ANY(...)
  // ORDER BY id FOR UPDATE` would rely on the planner keeping LockRows above
  // the Sort, which is not a contract worth betting a deadlock on. There are
  // never more than two ids.
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
 */
export async function lockedGatewayRecheck(
  tx: Prisma.TransactionClient,
  opts: { linkTo?: string | null; disablingGatewayId?: string | null },
): Promise<void> {
  const locked = await lockInstrumentRows(tx, [opts.linkTo, opts.disablingGatewayId]);

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
