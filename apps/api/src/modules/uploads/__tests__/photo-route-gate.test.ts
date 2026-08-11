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

  it('never gates /photo on a permission', () => {
    // Narrowed 2026-08-11. This used to assert the WHOLE module called
    // requirePermission zero times, which held only while /photo was the only
    // route here. /floorplan is deliberately gated on CONFIG_UPDATE (it writes
    // a shared asset, unlike a self-service profile photo), so the module-wide
    // form now fails for the right reason. The INTENT — /photo must stay
    // ungated, because gating it on USER_UPDATE once 403'd every non-admin
    // setting their own photo — is unchanged and asserted precisely.
    const photo = routes.find((r) => r.url === '/photo');
    expect(photo!.opts.preHandler).toBeUndefined();
    expect(app.requireAnyPermission).not.toHaveBeenCalled();
  });

  it('DOES gate /floorplan — it writes a shared asset, not the caller’s own', () => {
    const floorplan = routes.find((r) => r.url === '/floorplan');
    expect(floorplan).toBeDefined();
    expect(floorplan!.opts.preHandler).toBeDefined();
    expect(app.requirePermission).toHaveBeenCalledWith('CONFIG_UPDATE');
  });

  it('bounds floorplan upload frequency too', () => {
    const floorplan = routes.find((r) => r.url === '/floorplan');
    expect(floorplan!.opts.config?.rateLimit).toMatchObject({ max: 20, timeWindow: '1 hour' });
  });

  // Auth-only widened who can spend disk on a route that never unlinks and has
  // no quota, so the loop must stay bounded.
  it('bounds upload frequency with a route rate limit', () => {
    const photo = routes.find((r) => r.url === '/photo');
    expect(photo!.opts.config?.rateLimit).toMatchObject({ max: 30, timeWindow: '1 hour' });
  });
});
