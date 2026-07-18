import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma, createNotification } = vi.hoisted(() => ({
  mockPrisma: {
    systemConfig: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    notification: { findFirst: vi.fn() },
  },
  createNotification: vi.fn(),
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification }));

import { sweepPasswordExpiryNotifications } from '../password-expiry-sweep.js';

const day = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * day);

// Policy: 90-day expiry, warn 5 days out. updatedAt is old so it never floors.
function policy(passwordExpiryDays: number, expiryNotificationDays: number) {
  mockPrisma.systemConfig.findUnique.mockResolvedValue({
    configValue: { passwordExpiryDays, expiryNotificationDays },
    updatedAt: daysAgo(365),
  });
}
function users(list: Array<{ username: string; changedDaysAgo: number }>) {
  mockPrisma.user.findMany.mockResolvedValue(
    list.map((u) => ({ username: u.username, fullName: u.username, passwordChangedAt: daysAgo(u.changedDaysAgo), createdAt: daysAgo(u.changedDaysAgo) })),
  );
}

describe('sweepPasswordExpiryNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.notification.findFirst.mockResolvedValue(null); // no dupes by default
  });

  it('is a no-op when the expiry period is disabled', async () => {
    policy(0, 5);
    users([{ username: 'RB0001', changedDaysAgo: 87 }]);
    const r = await sweepPasswordExpiryNotifications();
    expect(r).toEqual({ warned: 0, expired: 0 });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('is a no-op when the notification window is disabled', async () => {
    policy(90, 0);
    users([{ username: 'RB0001', changedDaysAgo: 87 }]);
    const r = await sweepPasswordExpiryNotifications();
    expect(r).toEqual({ warned: 0, expired: 0 });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('excludes SUPER_ADMIN and DISABLED users at the query level', async () => {
    policy(90, 5);
    users([{ username: 'RB0001', changedDaysAgo: 87 }]);
    await sweepPasswordExpiryNotifications();
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('ENABLED');
    expect(where.role).toEqual({ not: 'SUPER_ADMIN' });
  });

  it('warns a user inside the window, targeted to that user only', async () => {
    policy(90, 5);
    users([{ username: 'RB0001', changedDaysAgo: 87 }]); // 3 days left
    const r = await sweepPasswordExpiryNotifications();
    expect(r.warned).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const arg = createNotification.mock.calls[0][0];
    expect(arg.type).toBe('PASSWORD_EXPIRY_WARNING');
    expect(arg.forUserId).toBe('RB0001');
    expect(arg.title).toMatch(/3 days/);
  });

  it('does NOT warn a user outside the window', async () => {
    policy(90, 5);
    users([{ username: 'RB0001', changedDaysAgo: 10 }]); // ~80 days left
    const r = await sweepPasswordExpiryNotifications();
    expect(r.warned).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not double-warn when a warning already exists today (idempotent)', async () => {
    policy(90, 5);
    users([{ username: 'RB0001', changedDaysAgo: 87 }]);
    mockPrisma.notification.findFirst.mockResolvedValue({ id: 'existing' });
    const r = await sweepPasswordExpiryNotifications();
    expect(r.warned).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('sends a one-time expired notice to BOTH the user and the ADMIN role', async () => {
    policy(90, 5);
    users([{ username: 'RB0001', changedDaysAgo: 100 }]); // expired
    const r = await sweepPasswordExpiryNotifications();
    expect(r.expired).toBe(1); // counted once per user, even though 2 notifications
    expect(createNotification).toHaveBeenCalledTimes(2);
    const args = createNotification.mock.calls.map((c) => c[0]);
    expect(args.every((a) => a.type === 'PASSWORD_EXPIRED_NOTICE')).toBe(true);
    const userNotice = args.find((a) => a.forUserId === 'RB0001');
    const adminNotice = args.find((a) => a.forRole === 'ADMIN');
    expect(userNotice).toBeTruthy();
    expect(adminNotice).toBeTruthy();
    expect(adminNotice.targetUserId).toBe('RB0001'); // deduped/attributed by target
  });

  it('does not repeat the expired notice once one exists since the last change', async () => {
    policy(90, 5);
    users([{ username: 'RB0001', changedDaysAgo: 100 }]);
    mockPrisma.notification.findFirst.mockResolvedValue({ id: 'noticed' }); // both sides already sent
    const r = await sweepPasswordExpiryNotifications();
    expect(r.expired).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('handles a mixed batch: one warn, one expire, one clear', async () => {
    policy(90, 5);
    users([
      { username: 'WARN', changedDaysAgo: 88 },   // 2 days left
      { username: 'EXPIRED', changedDaysAgo: 120 },
      { username: 'CLEAR', changedDaysAgo: 1 },
    ]);
    const r = await sweepPasswordExpiryNotifications();
    expect(r).toEqual({ warned: 1, expired: 1 });
    // 1 warning (WARN) + 2 expiry notices (EXPIRED: user + admin) = 3 total.
    const types = createNotification.mock.calls.map((c) => c[0].type).sort();
    expect(types).toEqual(['PASSWORD_EXPIRED_NOTICE', 'PASSWORD_EXPIRED_NOTICE', 'PASSWORD_EXPIRY_WARNING']);
  });
});
