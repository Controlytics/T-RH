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

/**
 * Re-check the two cross-row invariants inside the caller's transaction, under
 * a row lock, and throw `GatewayInvariantViolation` (rolling the transaction
 * back) if they no longer hold.
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
 * no predicate locking below Serializable). The only row both sides of the race
 * have in common is the GATEWAY, so that is the row both sides take:
 *
 *   - disabling a gateway  -> the caller's own `UPDATE instruments ... WHERE
 *                             id = GW` already write-locks it; the explicit
 *                             `FOR UPDATE` below documents and re-asserts it.
 *   - linking a child      -> the caller updates the CHILD, so it must lock the
 *                             gateway row explicitly.
 *
 * Both re-checks run AFTER the caller's mutation, so the lock is taken while
 * the write is already pending. Whichever request reaches the gateway row
 * second blocks, then re-reads committed state and refuses. Lock order is
 * always "the gateway row", so two concurrent links cannot deadlock.
 */
export async function lockedGatewayRecheck(
  tx: Prisma.TransactionClient,
  opts: { linkTo?: string | null; disablingGatewayId?: string | null },
): Promise<void> {
  if (opts.linkTo) {
    const rows = await tx.$queryRaw<{ id: string; code: string; is_gateway: boolean }[]>`
      SELECT id, code, is_gateway FROM instruments WHERE id = ${opts.linkTo} FOR UPDATE
    `;
    const parent = rows[0];
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
    await tx.$queryRaw`SELECT id FROM instruments WHERE id = ${opts.disablingGatewayId} FOR UPDATE`;
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
