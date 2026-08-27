import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) }));

import { writeFile } from 'node:fs/promises';
import uploadRoutes from '../routes.js';

/**
 * POST /api/uploads/branding-background (2026-08-27) — the app background image.
 *
 * It writes a SHARED asset every user sees, like /floorplan and unlike /photo
 * (which is self-service and named after the caller). So it carries the same
 * CONFIG_UPDATE gate and the same rate limit, and it must reuse the shared
 * validator rather than growing its own weaker copy.
 */
describe('POST /api/uploads/branding-background', () => {
  const routes: Array<{ url: string; opts: any; handler: any }> = [];
  const app: any = {
    post: (url: string, opts: any, handler: any) => routes.push({ url, opts, handler }),
    requirePermission: vi.fn((p: string) => Object.assign(vi.fn(), { __perm: p })),
    requireAnyPermission: vi.fn(() => vi.fn()),
    log: { error: vi.fn() },
  };

  const route = () => routes.find(r => r.url === '/branding-background')!;

  const reply = () => {
    const r: any = { statusCode: 200, body: undefined };
    r.code = (c: number) => { r.statusCode = c; return r; };
    r.send = (b: unknown) => { r.body = b; return r; };
    return r;
  };

  /** A PNG whose magic bytes match its declared mime type. */
  const pngFile = () => ({
    mimetype: 'image/png',
    file: (async function* () { yield Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]); })(),
  });

  beforeEach(async () => {
    routes.length = 0;
    vi.clearAllMocks();
    await uploadRoutes(app);
  });

  it('is registered', () => {
    expect(route()).toBeTruthy();
  });

  it('is gated on CONFIG_UPDATE, not merely authentication', () => {
    // A background is a shared asset: any authenticated user being able to replace
    // what every other user sees is the defect this pins.
    expect(app.requirePermission).toHaveBeenCalledWith('CONFIG_UPDATE');
    expect(route().opts.preHandler).toHaveLength(1);
  });

  it('is rate limited, because nothing here reclaims the disk it costs', () => {
    expect(route().opts.config.rateLimit).toBeTruthy();
  });

  it('writes the file and returns a /uploads/branding/ URL', async () => {
    const res = reply();
    const out = await route().handler({ file: async () => pngFile() }, res);
    expect(out.success).toBe(true);
    expect(out.url).toMatch(/^\/uploads\/branding\/[0-9a-f-]+\.png$/);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  /**
   * `/uploads/branding/` is already in PUBLIC_GET_PATHS, and it has to be: a CSS
   * `background-image` cannot send an Authorization header. Writing anywhere else
   * would produce a background that 401s for every viewer.
   */
  it('writes into the directory that is publicly readable', async () => {
    const res = reply();
    await route().handler({ file: async () => pngFile() }, res);
    const written = (writeFile as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(String(written).replace(/\\/g, '/')).toContain('/branding/');
  });

  it('refuses a file whose magic bytes contradict its declared mime type', async () => {
    const res = reply();
    // Declared PNG, actually not — the declared type is attacker-controlled.
    await route().handler({
      file: async () => ({ mimetype: 'image/png', file: (async function* () { yield Buffer.from('<?php echo 1; ?>'); })() }),
    }, res);
    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('refuses a disallowed mime type', async () => {
    const res = reply();
    await route().handler({
      file: async () => ({ mimetype: 'image/svg+xml', file: (async function* () { yield Buffer.from([0x3C]); })() }),
    }, res);
    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('refuses a request with no file', async () => {
    const res = reply();
    await route().handler({ file: async () => undefined }, res);
    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  /**
   * @fastify/multipart SILENTLY TRUNCATES at fileSize rather than throwing, so a
   * post-buffer length check is always false. `truncated` is the only signal.
   */
  it('refuses a truncated (oversize) upload', async () => {
    const res = reply();
    const stream: any = (async function* () { yield Buffer.from([0x89, 0x50, 0x4E, 0x47]); })();
    stream.truncated = true;
    await route().handler({ file: async () => ({ mimetype: 'image/png', file: stream }) }, res);
    expect(res.statusCode).toBe(413);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
