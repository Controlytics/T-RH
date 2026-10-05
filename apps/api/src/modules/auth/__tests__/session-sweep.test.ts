import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { sweepExpiredSessions } from '../session-sweep.js';

/**
 * The session reaper writes ONE `LOGOUT` row per terminated session, in the
 * SAME transaction as the termination (audit 2026-10-03, DATA-15). Against
 * the real test database: two expired sessions are swept with one audit row
 * each; a session that vanishes between the read and the write is rolled
 * back with its audit row — no LOGOUT for a termination that did not happen
 * here — and does not stop the others being reaped.
 */
const USERNAME = 'sweep_test_user';
let userId = '';
const created: string[] = [];

async function expiredSession(): Promise<string> {
  const s = await prisma.session.create({
    data: {
      userId, tokenHash: `sweep-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      isActive: true, expiresAt: new Date(Date.now() - 60_000), lastActiveAt: new Date(Date.now() - 3_600_000),
      ipAddress: '127.0.0.1', userAgent: 'vitest',
    },
    select: { id: true },
  });
  created.push(s.id);
  return s.id;
}

beforeAll(async () => {
  const { hashPassword } = await import('../../../lib/password.js');
  const user = await prisma.user.upsert({
    where: { username: USERNAME },
    update: { status: 'ENABLED' },
    create: { username: USERNAME, passwordHash: await hashPassword('Sweep@Test1'), fullName: 'Sweep Test', email: 'sweep@test.example', role: 'OPERATOR', status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false },
    select: { id: true },
  });
  userId = user.id;
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await prisma.session.deleteMany({ where: { id: { in: created } } });
});

describe('sweepExpiredSessions', () => {
  it('terminates each expired session with exactly one LOGOUT row, in one transaction', async () => {
    const a = await expiredSession();
    const b = await expiredSession();
    const { swept } = await sweepExpiredSessions();
    expect(swept).toBeGreaterThanOrEqual(2);
    for (const id of [a, b]) {
      const s = await prisma.session.findUnique({ where: { id } });
      expect(s?.isActive).toBe(false);
      expect(s?.terminationReason).toBe('session_timeout');
      const rows = await prisma.auditTrail.findMany({ where: { action: 'LOGOUT', targetId: id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(USERNAME);
      expect(rows[0].sessionId).toBe(id);
    }
    // A second sweep finds nothing to do and writes nothing more.
    await sweepExpiredSessions();
    expect(await prisma.auditTrail.count({ where: { action: 'LOGOUT', targetId: { in: [a, b] } } })).toBe(2);
  });

  it('rolls the audit row back when the session is no longer active by the time it is reached, and sweeps the rest', async () => {
    const live = await expiredSession();
    const gone = await expiredSession();
    // The read returns both; the second has been closed by someone else in
    // between (the user's own logout, another sweep). Stale list, real DB.
    const real = prisma.session.findMany.bind(prisma.session);
    vi.spyOn(prisma.session, 'findMany').mockImplementationOnce(async (args) => {
      const rows = await real(args as never);
      await prisma.session.update({ where: { id: gone }, data: { isActive: false, terminationReason: 'user_logout' } });
      return rows;
    });
    const { swept } = await sweepExpiredSessions();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await prisma.auditTrail.count({ where: { action: 'LOGOUT', targetId: live } })).toBe(1);
    // No LOGOUT for the one this sweep did not terminate — the transaction
    // rolled back, and its termination reason is still the other party's.
    expect(await prisma.auditTrail.count({ where: { action: 'LOGOUT', targetId: gone } })).toBe(0);
    expect((await prisma.session.findUnique({ where: { id: gone } }))?.terminationReason).toBe('user_logout');
  });
});
