/**
 * Server-side session reaper (2026-06-03).
 *
 * Terminates active sessions that have expired (past `expiresAt`) or gone idle
 * beyond the configured idle timeout, and records a `LOGOUT` audit (reason
 * `session_timeout`) for each. This is what makes a tablet app-close /
 * window-close / crash / network-loss actually END the session AND appear in
 * the audit trail — the client process is gone in those cases and can never
 * call POST /logout, so the server is the only reliable place to record it.
 *
 * The idle sweep runs only when auto-logout is enabled and uses
 * `idleTimeoutMinutes + 2` so an OPEN app's client-side idle logout (which
 * records reason `idle_timeout`) always lands first — the server only catches
 * sessions the client couldn't terminate itself. `expiresAt` is the always-on
 * hard cap regardless of the idle setting.
 *
 * Triggered by the `session_sweep` graphile-worker cron (every 5 min). Returns
 * the number of sessions reaped (for the cron log + tests).
 */
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { authRepository } from './auth.repository.js';

export async function sweepExpiredSessions(): Promise<{ swept: number }> {
  const raw = (await authRepository.getSessionConfig()) as any;
  // Config may be flat or `{ value: {...} }` depending on how it was saved.
  const cfg = raw?.value && typeof raw.value === 'object' ? raw.value : (raw ?? {});
  const now = new Date();

  const or: any[] = [{ expiresAt: { lt: now } }]; // hard expiry — always
  if (cfg.autoLogoutEnabled !== false) {
    const idleMin = Number.isFinite(Number(cfg.idleTimeoutMinutes)) ? Number(cfg.idleTimeoutMinutes) : 15;
    const cutoff = new Date(now.getTime() - (idleMin + 2) * 60_000);
    or.push({ lastActiveAt: { lt: cutoff } });
  }

  // Bounded 2026-08-29 (audit M3). This was an unbounded findMany: after a
  // service restart or a spell of DB maintenance it loaded EVERY stale session,
  // each with its user relation, into memory at once. A batch keeps the working
  // set flat; the caller runs on a cron, so anything left over is swept a
  // minute later.
  const SWEEP_BATCH = 1000;
  const stale = await prisma.session.findMany({
    where: { isActive: true, OR: or },
    include: { user: { select: { username: true, role: true } } },
    take: SWEEP_BATCH,
  });

  // ONE TRANSACTION PER SESSION: the LOGOUT audit row and the session's
  // termination commit together or not at all (audit 2026-10-03, DATA-15).
  // Until then every audit row was written standalone and the sessions were
  // flipped in one updateMany afterwards — so a crash between the two left
  // the sessions active with their termination already recorded, and the
  // next tick wrote a SECOND LOGOUT for each: duplicate §11 terminations.
  //
  // The update is conditional on `isActive` still being true. If another
  // sweep (or the user's own logout) closed the session between the read
  // above and this write, the update matches nothing and the transaction is
  // rolled back — taking the audit row with it — because a termination that
  // did not happen here must not be recorded here. The per-session rows stay
  // serial (the hash chain forces that) and the batchable half was never the
  // bottleneck.
  let swept = 0;
  for (const s of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        await auditLog({
          userId: s.user?.username ?? s.userId,
          userRole: s.user?.role ?? 'UNKNOWN',
          action: 'LOGOUT',
          targetType: 'session',
          targetId: s.id,
          afterValue: { username: s.user?.username, reason: 'session_timeout' },
          reason: 'Session ended by server (idle/expiry) — app closed, timed out, or connection lost',
          signatureMeaning: `Session for "${s.user?.username ?? s.userId}" terminated by server timeout`,
          ipAddress: s.ipAddress ?? '127.0.0.1',
          userAgent: s.userAgent ?? undefined,
          sessionId: s.id,
        }, tx);
        const { count } = await tx.session.updateMany({
          where: { id: s.id, isActive: true },
          data: { isActive: false, terminationReason: 'session_timeout' },
        });
        if (count !== 1) throw new SessionAlreadyClosed(s.id);
      });
      swept++;
    } catch (err) {
      if (err instanceof SessionAlreadyClosed) continue;   // closed by someone else first — nothing to record
      // One bad session must not stop the rest being reaped; the cron retries
      // it on the next tick, and the rollback means nothing half-recorded.
      console.error(`[session-sweep] session ${s.id} not swept: ${(err as Error).message}`);
    }
  }

  return { swept };
}

/** Rollback sentinel: the session was no longer active when the sweep reached it. */
class SessionAlreadyClosed extends Error {
  constructor(id: string) {
    super(`session ${id} already inactive`);
    this.name = 'SessionAlreadyClosed';
  }
}
