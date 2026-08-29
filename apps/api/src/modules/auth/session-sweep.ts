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

  // The per-session audit row is NOT the N+1 — §11 needs one record per
  // terminated session and the hash chain forces those writes to be serial.
  // The session UPDATE is the batchable half, so it is hoisted into a single
  // updateMany AFTER the audit writes: if the process dies mid-sweep the
  // sessions stay active and are swept again next tick, which is recoverable.
  // Marking them inactive first and then failing to audit would not be — it
  // would lose the §11 record of a termination that had already happened.
  let swept = 0;
  const sweptIds: string[] = [];
  for (const s of stale) {
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
    });
    sweptIds.push(s.id);
    swept++;
  }

  if (sweptIds.length > 0) {
    await prisma.session.updateMany({
      where: { id: { in: sweptIds } },
      data: { isActive: false, terminationReason: 'session_timeout' },
    });
  }

  return { swept };
}
