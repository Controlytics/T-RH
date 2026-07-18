/**
 * Real-DB integration test for the password-expiry notification sweep.
 * Runs against digilog_test_db (vitest.env.ts swaps DATABASE_URL). Seeds its own
 * users + policy config, exercises the actual Prisma queries + the new
 * NotificationType enum inserts, then cleans up.
 *
 * The policy row's updated_at is aged 300 days so the grace floor
 * (policyUpdatedAt) does not reset the seeded users' expiry windows — matching a
 * steady-state install where the policy hasn't been edited recently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { sweepPasswordExpiryNotifications } from '../modules/auth/password-expiry-sweep.js';

const day = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * day);
const TAG = `pexp_${Date.now()}`;

let warnU: string;
let expU: string;
let clearU: string;
let savedConfigValue: unknown;

async function mkUser(suffix: string, changedDaysAgo: number): Promise<string> {
  const username = `${TAG}_${suffix}`;
  await prisma.user.create({
    data: {
      username, fullName: `Test ${suffix}`, passwordHash: 'x', role: 'OPERATOR',
      status: 'ENABLED', passwordChangedAt: daysAgo(changedDaysAgo),
      forcePasswordChange: false, isTemporaryPassword: false,
    },
  });
  return username;
}

describe('password-expiry sweep (real DB)', () => {
  beforeAll(async () => {
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
    savedConfigValue = existing?.configValue ?? null;
    const base = (existing?.configValue as Record<string, unknown> | undefined) ?? {};
    await prisma.systemConfig.upsert({
      where: { configKey: 'password-policy' },
      update: { configValue: { ...base, passwordExpiryDays: 90, expiryNotificationDays: 5 } },
      create: { configKey: 'password-policy', configValue: { passwordExpiryDays: 90, expiryNotificationDays: 5 }, configType: 'security' },
    });
    // Age the policy so the grace floor doesn't reset the seeded users' windows.
    await prisma.$executeRawUnsafe(`UPDATE system_config SET updated_at = now() - interval '300 days' WHERE config_key = 'password-policy'`);

    warnU = await mkUser('warn', 88);   // ~2 days left  → warning
    expU = await mkUser('exp', 120);    // long expired  → expired notice
    clearU = await mkUser('clear', 1);  // ~89 days left → nothing
  });

  afterAll(async () => {
    const usernames = [warnU, expU, clearU].filter(Boolean);
    // Admin-targeted expiry notices have forUserId=null but targetUserId=<user>.
    await prisma.notification.deleteMany({
      where: { OR: [{ forUserId: { in: usernames } }, { targetUserId: { in: usernames } }] },
    });
    await prisma.user.deleteMany({ where: { username: { in: usernames } } });
    if (savedConfigValue !== null) {
      await prisma.systemConfig.update({ where: { configKey: 'password-policy' }, data: { configValue: savedConfigValue as any } });
    }
  });

  it('warns the in-window user, notices the expired user, and skips the clear user', async () => {
    const r = await sweepPasswordExpiryNotifications();
    expect(r.warned).toBeGreaterThanOrEqual(1);
    expect(r.expired).toBeGreaterThanOrEqual(1);

    const warn = await prisma.notification.findFirst({ where: { forUserId: warnU, type: 'PASSWORD_EXPIRY_WARNING' } });
    expect(warn).toBeTruthy();
    expect(warn!.title).toMatch(/2 days/);

    const exp = await prisma.notification.findFirst({ where: { forUserId: expU, type: 'PASSWORD_EXPIRED_NOTICE' } });
    expect(exp).toBeTruthy();
    // Expiry notice also goes to the ADMIN role, attributed via targetUserId.
    const adminNotice = await prisma.notification.findFirst({ where: { forRole: 'ADMIN', targetUserId: expU, type: 'PASSWORD_EXPIRED_NOTICE' } });
    expect(adminNotice).toBeTruthy();

    const clear = await prisma.notification.findFirst({ where: { forUserId: clearU } });
    expect(clear).toBeNull();
  });

  it('is idempotent within the same day (no duplicate notifications)', async () => {
    await sweepPasswordExpiryNotifications();
    const warnCount = await prisma.notification.count({ where: { forUserId: warnU, type: 'PASSWORD_EXPIRY_WARNING' } });
    expect(warnCount).toBe(1);
    const expCount = await prisma.notification.count({ where: { forUserId: expU, type: 'PASSWORD_EXPIRED_NOTICE' } });
    expect(expCount).toBe(1);
  });
});
