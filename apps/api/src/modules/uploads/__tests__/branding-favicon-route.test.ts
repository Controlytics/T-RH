import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) }));

import { writeFile } from 'node:fs/promises';
import uploadRoutes from '../routes.js';

/**
 * POST /api/uploads/branding-favicon (2026-09-03) — the browser tab icon.
 *
 * It exists separately from /branding-background, which writes to the same
 * directory and would have "worked", because the two differ in what they ACCEPT:
 * a favicon is the one case where an operator reaches for a .ico. Everything else
 * — the CONFIG_UPDATE gate, the rate limit, the shared validator — is deliberately
 * identical, and these tests are what stop it drifting into the weakest of the four.
 */
describe('POST /api/uploads/branding-favicon', () => {
  const routes: Array<{ url: string; opts: any; handler: any }> = [];
  const app: any = {
    post: (url: string, opts: any, handler: any) => routes.push({ url, opts, handler }),
    requirePermission: vi.fn((p: string) => Object.assign(vi.fn(), { __perm: p })),
    requireAnyPermission: vi.fn(() => vi.fn()),
    log: { error: vi.fn() },
  };

  const route = () => routes.find(r => r.url === '/branding-favicon')!;

  const reply = () => {
    const r: any = { statusCode: 200, body: undefined };
    r.code = (c: number) => { r.statusCode = c; return r; };
    r.send = (b: unknown) => { r.body = b; return r; };
    return r;
  };

  const upload = (mimetype: string, bytes: number[]) => ({
    mimetype,
    file: (async function* () { yield Buffer.from(bytes); })(),
  });

  const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A];
  /** ICONDIR: reserved 0, type 1 (icon), one image. */
  const ICO = [0x00, 0x00, 0x01, 0x00, 0x01, 0x00];
  /** Same header with type 2 — a CURSOR, not an icon. */
  const CUR = [0x00, 0x00, 0x02, 0x00, 0x01, 0x00];

  beforeEach(async () => {
    routes.length = 0;
    vi.clearAllMocks();
    await uploadRoutes(app);
  });

  it('is registered', () => {
    expect(route()).toBeTruthy();
  });

  // Asserted off THIS route's own preHandler, not off the shared mock: three other
  // routes also call requirePermission('CONFIG_UPDATE'), so a call-level assertion
  // would pass even with this route left ungated.
  it('is gated on CONFIG_UPDATE — the favicon is what every user\'s tab shows', () => {
    expect(route().opts.preHandler).toHaveLength(1);
    expect((route().opts.preHandler[0] as any).__perm).toBe('CONFIG_UPDATE');
  });

  it('is rate limited, because nothing here reclaims the disk it costs', () => {
    expect(route().opts.config.rateLimit).toBeTruthy();
  });

  it('writes a PNG and returns a /uploads/branding/ URL', async () => {
    const res = reply();
    const out = await route().handler({ file: async () => upload('image/png', PNG) }, res);
    expect(out.success).toBe(true);
    expect(out.url).toMatch(/^\/uploads\/branding\/[0-9a-f-]+\.png$/);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  /**
   * The capability this route exists for. /branding-background REFUSES this file —
   * ICO is not in the shared ALLOWED_TYPES — which is exactly why the two are not
   * one route.
   */
  it('accepts a .ico, which the background route does not', async () => {
    const res = reply();
    const out = await route().handler({ file: async () => upload('image/x-icon', ICO) }, res);
    expect(out.url).toMatch(/\.ico$/);

    const bg = routes.find(r => r.url === '/branding-background')!;
    const bgRes = reply();
    await bg.handler({ file: async () => upload('image/x-icon', ICO) }, bgRes);
    expect(bgRes.statusCode).toBe(400);
  });

  it('accepts the other mime type Windows uses for a .ico', async () => {
    const res = reply();
    const out = await route().handler({ file: async () => upload('image/vnd.microsoft.icon', ICO) }, res);
    expect(out.url).toMatch(/\.ico$/);
  });

  /**
   * A .cur shares the ICONDIR header and differs only in the type word. Matching
   * all four bytes is what refuses it; matching two would not.
   */
  it('refuses a cursor renamed to .ico', async () => {
    const res = reply();
    await route().handler({ file: async () => upload('image/x-icon', CUR) }, res);
    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  /**
   * The security line. `/uploads/branding/` is in PUBLIC_GET_PATHS and served from
   * the API's own origin, so an SVG — which can carry script — would be same-origin
   * script execution reachable by anyone holding CONFIG_UPDATE. Widening
   * FAVICON_TYPES to "support SVG favicons" is what this pins against.
   */
  it('refuses an SVG', async () => {
    const res = reply();
    await route().handler({ file: async () => upload('image/svg+xml', [0x3C]) }, res);
    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('names the types it accepts when it refuses one', async () => {
    const res = reply();
    await route().handler({ file: async () => upload('application/pdf', [0x25]) }, res);
    expect(res.body.message).toContain('image/x-icon');
  });

  it('refuses a file whose magic bytes contradict its declared mime type', async () => {
    const res = reply();
    await route().handler({
      file: async () => ({ mimetype: 'image/png', file: (async function* () { yield Buffer.from('<?php echo 1; ?>'); })() }),
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

  // @fastify/multipart SILENTLY TRUNCATES at fileSize rather than throwing, so a
  // post-buffer length check is always false. `truncated` is the only signal.
  it('refuses a truncated (oversize) upload', async () => {
    const res = reply();
    const stream: any = (async function* () { yield Buffer.from(PNG); })();
    stream.truncated = true;
    await route().handler({ file: async () => ({ mimetype: 'image/png', file: stream }) }, res);
    expect(res.statusCode).toBe(413);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes into the publicly readable branding directory', async () => {
    const res = reply();
    await route().handler({ file: async () => upload('image/png', PNG) }, res);
    const written = (writeFile as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(String(written).replace(/\\/g, '/')).toContain('/branding/');
  });
});
