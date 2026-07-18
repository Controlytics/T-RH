import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) }));

import uploadRoutes from '../routes.js';

/**
 * Enterprise-audit finding (2026-07-15): POST /api/uploads/photo was gated on
 * USER_UPDATE — the admin "Edit Users" capability. The endpoint is self-service
 * by construction (it writes `${req.user.sub}-<uuid>` and returns a URL, never
 * touching another user's record), and the Profile page shows the upload button
 * to everyone, so the 6 of 8 seeded roles without USER_UPDATE got a 403 setting
 * their own photo. It must stay authenticated-only: authentication comes from
 * the global onRequest hook, which is NOT a permission check — re-adding a
 * permission preHandler reintroduces the lockout.
 */
describe('POST /api/uploads/photo — permission gate', () => {
  const routes: Array<{ url: string; opts: any }> = [];
  const app: any = {
    post: (url: string, opts: any) => routes.push({ url, opts }),
    requirePermission: vi.fn(() => vi.fn()),
    requireAnyPermission: vi.fn(() => vi.fn()),
    log: { error: vi.fn() },
  };

  beforeEach(async () => {
    routes.length = 0;
    vi.clearAllMocks();
    await uploadRoutes(app);
  });

  it('registers /photo with no permission preHandler', () => {
    const photo = routes.find((r) => r.url === '/photo');
    expect(photo).toBeDefined();
    expect(photo!.opts.preHandler).toBeUndefined();
  });

  it('never asks for a permission gate at all', () => {
    expect(app.requirePermission).not.toHaveBeenCalled();
    expect(app.requireAnyPermission).not.toHaveBeenCalled();
  });

  // Auth-only widened who can spend disk on a route that never unlinks and has
  // no quota, so the loop must stay bounded.
  it('bounds upload frequency with a route rate limit', () => {
    const photo = routes.find((r) => r.url === '/photo');
    expect(photo!.opts.config?.rateLimit).toMatchObject({ max: 30, timeWindow: '1 hour' });
  });
});
