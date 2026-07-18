/**
 * Password-expiry notification sweep (2026-07-08).
 *
 * Idempotent daily sweep that warns each affected user as their password nears
 * expiry, then sends a one-time "expired" notice on the expiry day. Driven by
 * the `password_expiry_check` graphile-worker cron (crontab.txt, daily 00:00),
 * which the single Runner in app.ts starts alongside the API — so it fires in
 * any running instance (dev + prod). The manual admin trigger
 * `POST /api/users/password-expiry-sweep` runs it on demand (e.g. testing
 * without waiting for midnight).
 *
 * Config (General & Password Settings → Expiry group, key `password-policy`):
 *   - passwordExpiryDays       — the expiry period (0 = no expiry, feature off)
 *   - expiryNotificationDays   — warn daily for this many days before expiry
 *                                (0 = notifications off)
 *
 * Targeting: notifications are per-user (`forUserId = username`) so ONLY the
 * user whose password is expiring sees them. SUPER_ADMIN is excluded (exempt
 * from expiry, mirroring auth.service login enforcement); DISABLED users skip.
 *
 * Idempotency:
 *   - Warning: one per user per calendar day — skipped if a PASSWORD_EXPIRY_WARNING
 *     already exists for the user with createdAt >= start-of-today. A restart or
 *     manual re-run the same day therefore adds no duplicate.
 *   - Expired notice: one per expiry event — skipped if a PASSWORD_EXPIRED_NOTICE
 *     exists for the user created after their last password change. Changing the
 *     password moves that anchor forward and re-enables the next cycle.
 *
 * The anchor + day math come from lib/password-expiry.ts, the SAME source the
 * login block uses, so warnings and enforcement never disagree.
 */
import { prisma } from '../../lib/prisma.js';
import { createNotification } from '../notifications/notification.service.js';
import { isPasswordExpired, daysUntilPasswordExpiry } from '../../lib/password-expiry.js';

export async function sweepPasswordExpiryNotifications(): Promise<{ warned: number; expired: number }> {
  const policyRow = await prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
  const cfg = (policyRow?.configValue ?? {}) as { passwordExpiryDays?: number; expiryNotificationDays?: number };
  const expiryDays = Number(cfg.passwordExpiryDays ?? 0);
  const notifDays = Number(cfg.expiryNotificationDays ?? 0);
  // Feature off unless BOTH an expiry period and a notification window are set.
  if (!(expiryDays > 0) || !(notifDays > 0)) return { warned: 0, expired: 0 };
  const policyUpdatedAt = policyRow?.updatedAt ?? null;

  const users = await prisma.user.findMany({
    where: { status: 'ENABLED', role: { not: 'SUPER_ADMIN' } },
    select: { username: true, fullName: true, passwordChangedAt: true, createdAt: true },
  });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  let warned = 0;
  let expired = 0;

  for (const u of users) {
    // ── Already expired → one-time notice per expiry event ──────────────────
    // Sent to BOTH the expiring user (visible if they still hold an open
    // session) AND the ADMIN role (the party who can reset the password — an
    // expired user is blocked at login and can't otherwise see it). Each side is
    // deduped independently since the last password change: the user notice by
    // forUserId, the admin notice by (forRole=ADMIN, targetUserId).
    if (isPasswordExpired(u.passwordChangedAt, u.createdAt, expiryDays, policyUpdatedAt)) {
      const since = u.passwordChangedAt ?? u.createdAt;
      const [userNoticed, adminNoticed] = await Promise.all([
        prisma.notification.findFirst({
          where: { type: 'PASSWORD_EXPIRED_NOTICE', forUserId: u.username, createdAt: { gte: since } },
          select: { id: true },
        }),
        prisma.notification.findFirst({
          where: { type: 'PASSWORD_EXPIRED_NOTICE', forRole: 'ADMIN', targetUserId: u.username, createdAt: { gte: since } },
          select: { id: true },
        }),
      ]);
      let createdOne = false;
      if (!userNoticed) {
        await createNotification({
          type: 'PASSWORD_EXPIRED_NOTICE',
          title: 'Your password has expired',
          message: 'Your password has expired. You must set a new password at your next login. Contact an administrator if you need help.',
          forUserId: u.username,
          targetUserId: u.username,
          metadata: { kind: 'PASSWORD_EXPIRED_NOTICE' },
        });
        createdOne = true;
      }
      if (!adminNoticed) {
        await createNotification({
          type: 'PASSWORD_EXPIRED_NOTICE',
          title: `Password expired — ${u.username}`,
          message: `${u.fullName ?? u.username}'s password has expired. They must set a new password at next login; reset it if they need help.`,
          forRole: 'ADMIN',
          targetUserId: u.username,
          metadata: { kind: 'PASSWORD_EXPIRED_NOTICE', targetUsername: u.username },
        });
        createdOne = true;
      }
      if (createdOne) expired++;
      continue;
    }

    // ── Within the warning window → one warning per user per day ────────────
    const daysLeft = daysUntilPasswordExpiry(u.passwordChangedAt, u.createdAt, expiryDays, policyUpdatedAt);
    if (daysLeft === null || daysLeft < 1 || daysLeft > notifDays) continue;

    const warnedToday = await prisma.notification.findFirst({
      where: { type: 'PASSWORD_EXPIRY_WARNING', forUserId: u.username, createdAt: { gte: startOfToday } },
      select: { id: true },
    });
    if (warnedToday) continue;

    const dayLabel = daysLeft === 1 ? '1 day' : `${daysLeft} days`;
    await createNotification({
      type: 'PASSWORD_EXPIRY_WARNING',
      title: `Password expires in ${dayLabel}`,
      message: `Your password will expire in ${dayLabel}. Please change it before then to avoid being locked out.`,
      forUserId: u.username,
      targetUserId: u.username,
      metadata: { kind: 'PASSWORD_EXPIRY_WARNING', daysLeft },
    });
    warned++;
  }

  return { warned, expired };
}
