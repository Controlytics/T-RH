import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) }));

import { writeFile } from 'node:fs/promises';
import uploadRoutes, { uploadConfigProblems, readValidatedImage } from '../routes.js';

/**
 * Audit 2026-10-03, SEC-3 and API-20 (uploads).
 *
 * SEC-3: `UPLOAD_ALLOWED_TYPES` could name a type with no magic-byte row, and
 * the content check was `if (expectedMagic && …)` — so that type was written
 * UNCHECKED into a publicly served folder. With `image/svg+xml` that is stored
 * script on the API origin. Two guards now exist and both are pinned here: the
 * module refuses to REGISTER on such an environment, and the validator refuses
 * such a type even when handed it directly.
 *
 * API-20: `MAX_FILE_SIZE` was read and never applied (`req.file()` took no
 * limits), and `/photo` had its own copy of the validation that answered an
 * oversize part with 400 where the other three answered 413.
 */

const reply = () => {
  const r: any = { statusCode: 200, body: undefined };
  r.code = (c: number) => { r.statusCode = c; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
};

const fakeApp = () => {
  const routes: Array<{ url: string; opts: any; handler: any }> = [];
  const app: any = {
    post: (url: string, opts: any, handler: any) => routes.push({ url, opts, handler }),
    requirePermission: vi.fn(() => vi.fn()),
    requireAnyPermission: vi.fn(() => vi.fn()),
    log: { error: vi.fn() },
  };
  return { app, routes };
};

const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A];
const stream = (bytes: number[], truncated = false) => {
  const s: any = (async function* () { yield Buffer.from(bytes); })();
  if (truncated) s.truncated = true;
  return s;
};

describe('uploadConfigProblems — the environment the validator can honour', () => {
  it('names every allowed type that has no magic-byte signature', () => {
    const problems = uploadConfigProblems(['image/jpeg', 'image/svg+xml', 'text/html']);
    expect(problems).toHaveLength(1);
    // The unsigned types, and ONLY those, are what is named as the problem.
    expect(problems[0]).toMatch(/no content check: image\/svg\+xml, text\/html\./);
  });

  it('accepts the shipped list', () => {
    expect(uploadConfigProblems(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])).toEqual([]);
  });

  it('refuses a MAX_FILE_SIZE that is not a positive integer', () => {
    expect(uploadConfigProblems(['image/png'], undefined, Number.NaN)).toHaveLength(1);
    expect(uploadConfigProblems(['image/png'], undefined, 0)).toHaveLength(1);
    expect(uploadConfigProblems(['image/png'], undefined, 1024)).toEqual([]);
  });
});

describe('uploadRoutes refuses to register on a bad environment (SEC-3)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.resetModules();
  });

  it('throws when UPLOAD_ALLOWED_TYPES names a type with no signature', async () => {
    process.env.UPLOAD_ALLOWED_TYPES = 'image/jpeg,image/png,image/svg+xml';
    vi.resetModules();
    const fresh = (await import('../routes.js')).default;
    const { app } = fakeApp();
    await expect(fresh(app)).rejects.toThrow(/image\/svg\+xml/);
  });

  it('throws when MAX_FILE_SIZE is not a number', async () => {
    process.env.MAX_FILE_SIZE = 'five megabytes';
    vi.resetModules();
    const fresh = (await import('../routes.js')).default;
    const { app } = fakeApp();
    await expect(fresh(app)).rejects.toThrow(/MAX_FILE_SIZE/);
  });

  it('registers on the shipped environment', async () => {
    delete process.env.UPLOAD_ALLOWED_TYPES;
    delete process.env.MAX_FILE_SIZE;
    vi.resetModules();
    const fresh = (await import('../routes.js')).default;
    const { app, routes } = fakeApp();
    await fresh(app);
    expect(routes.map((r) => r.url).sort()).toEqual(['/branding-background', '/branding-favicon', '/floorplan', '/photo']);
  });
});

describe('readValidatedImage — the magic check is mandatory (SEC-3)', () => {
  it('refuses a type with no signature even when the allow-list it is given admits it, without reading the stream', async () => {
    let read = false;
    const file: any = (async function* () { read = true; yield Buffer.from('<svg onload="1"/>'); })();
    const out = await readValidatedImage({ mimetype: 'image/svg+xml', file }, ['image/svg+xml']);
    expect(out.ok).toBe(false);
    expect((out as { code: number }).code).toBe(400);
    expect(read).toBe(false);
  });

  it('still accepts a PNG whose bytes match', async () => {
    const out = await readValidatedImage({ mimetype: 'image/png', file: stream(PNG) }, ['image/png']);
    expect(out.ok).toBe(true);
    expect((out as { ext: string }).ext).toBe('.png');
  });
});

describe('POST /api/uploads/photo goes through the shared validator (API-20)', () => {
  const { app, routes } = fakeApp();
  const route = () => routes.find((r) => r.url === '/photo')!;
  const req = (file: () => Promise<unknown>) => ({ user: { sub: 'u-1' }, file: vi.fn(file) });

  beforeEach(async () => {
    routes.length = 0;
    vi.clearAllMocks();
    await uploadRoutes(app);
  });

  it('asks req.file() for the configured size limit — every route does', async () => {
    for (const url of ['/photo', '/floorplan', '/branding-background', '/branding-favicon']) {
      const r = req(async () => ({ mimetype: 'image/png', file: stream(PNG) }));
      await routes.find((x) => x.url === url)!.handler(r, reply());
      expect(r.file, url).toHaveBeenCalledWith({ limits: { fileSize: 5 * 1024 * 1024 } });
    }
  });

  it('writes a valid PNG under the caller\'s id', async () => {
    const res = reply();
    const out = await route().handler(req(async () => ({ mimetype: 'image/png', file: stream(PNG) })), res);
    expect(out.success).toBe(true);
    expect(out.photoUrl).toMatch(/^\/uploads\/photos\/u-1-[0-9a-f-]+\.png$/);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('answers a truncated (oversize) part with 413, like the other three routes', async () => {
    const res = reply();
    await route().handler(req(async () => ({ mimetype: 'image/png', file: stream(PNG, true) })), res);
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toBe('FILE_TOO_LARGE');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('answers FST_REQ_FILE_TOO_LARGE from req.file() with 413, not 400', async () => {
    const res = reply();
    await route().handler(req(async () => { throw Object.assign(new Error('too big'), { code: 'FST_REQ_FILE_TOO_LARGE' }); }), res);
    expect(res.statusCode).toBe(413);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes contradict its declared type', async () => {
    const res = reply();
    await route().handler(req(async () => ({ mimetype: 'image/png', file: stream([0x3C, 0x3F, 0x70]) })), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('INVALID_FILE');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('refuses a disallowed type', async () => {
    const res = reply();
    await route().handler(req(async () => ({ mimetype: 'image/svg+xml', file: stream([0x3C]) })), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('INVALID_FILE_TYPE');
    expect(writeFile).not.toHaveBeenCalled();
  });
});
