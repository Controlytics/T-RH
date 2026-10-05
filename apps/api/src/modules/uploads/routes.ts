import { type FastifyInstance, type FastifyReply } from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOADS_ROOT } from '../../lib/uploads-dir.js';

// Uploads directory. UPLOADS_ROOT honors UPLOAD_DIR (customer install) — must
// match the static serve root in app.ts, otherwise written photos 404.
const profilePhotosDir = path.join(UPLOADS_ROOT, 'photos');
const floorplansDir = path.join(UPLOADS_ROOT, 'floorplans');
// The app background image. `/uploads/branding/` is ALREADY in PUBLIC_GET_PATHS
// (apps/api/src/plugins/auth.ts) and must stay there: a CSS `background-image`
// cannot send an Authorization header, so a background served from a protected
// path would 401 for every viewer. Same reasoning that made floorplans public.
const brandingDir = path.join(UPLOADS_ROOT, 'branding');

// Ensure upload directories exist
async function ensureDirectories() {
  await mkdir(profilePhotosDir, { recursive: true });
  await mkdir(floorplansDir, { recursive: true });
  await mkdir(brandingDir, { recursive: true });
}

// Allowed image types — configurable via environment. Every entry MUST have a
// MAGIC_BYTES row; `assertUploadConfig()` below refuses to start otherwise.
const ALLOWED_TYPES = (process.env.UPLOAD_ALLOWED_TYPES ?? 'image/jpeg,image/png,image/gif,image/webp')
  .split(',').map((t) => t.trim()).filter(Boolean);
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE ?? `${5 * 1024 * 1024}`, 10); // default 5MB
const MAX_MB = MAX_FILE_SIZE / 1024 / 1024;
// Passed to EVERY `req.file()` call (audit 2026-10-03, API-20). The global
// `@fastify/multipart` registration in app.ts hard-codes 5 MB; a per-request
// `limits` is what makes MAX_FILE_SIZE the number actually applied, and it is
// also what sets `data.file.truncated` at the bound readValidatedImage reports.
const FILE_LIMITS = { limits: { fileSize: MAX_FILE_SIZE } } as const;

// Extension comes from the VALIDATED mime type, never the user-supplied
// filename — the filename is attacker-controlled and `evil.png.exe` is a real
// shape of that mistake.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  // ICO is reachable ONLY from /branding-favicon, which passes FAVICON_TYPES.
  // Being in this map does not admit it anywhere else — the allow-list is the gate.
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
};

const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47],
  'image/gif': [0x47, 0x49, 0x46],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF header
  // ICONDIR: reserved(0) + type. Type 1 is an icon, type 2 is a CURSOR, and
  // matching all four bytes is what refuses a .cur renamed to .ico.
  'image/x-icon': [0x00, 0x00, 0x01, 0x00],
  'image/vnd.microsoft.icon': [0x00, 0x00, 0x01, 0x00],
};

/**
 * What /branding-favicon accepts: the shared list PLUS the two mime types Windows
 * uses for a .ico, which is the format an operator most often has to hand for a
 * favicon. Derived from ALLOWED_TYPES rather than written out, so narrowing
 * UPLOAD_ALLOWED_TYPES narrows this route too.
 *
 * SVG IS DELIBERATELY ABSENT AND MUST STAY ABSENT. `/uploads/branding/` is in
 * PUBLIC_GET_PATHS and served from the API's own origin; an SVG can carry script,
 * so accepting one here would be same-origin script execution reachable by anyone
 * holding CONFIG_UPDATE. Every browser that matters renders a PNG favicon.
 */
const FAVICON_TYPES = [...ALLOWED_TYPES, 'image/x-icon', 'image/vnd.microsoft.icon'];

/**
 * The allowed types that have NO magic-byte signature (and so could never be
 * content-checked), plus a bad MAX_FILE_SIZE — the two ways the environment
 * can turn this module into a weaker one than the code reads as.
 *
 * Audit 2026-10-03, SEC-3: `UPLOAD_ALLOWED_TYPES=…,image/svg+xml` used to be
 * accepted as configured. SVG has no row in MAGIC_BYTES, the content check was
 * `if (expectedMagic && …)`, so the file was written UNCHECKED as `<uuid>.jpg`
 * into `/uploads/photos/` — a PUBLIC path served from the API's own origin.
 * That is stored script execution for every user who opens the link, reachable
 * by any authenticated account through `POST /api/uploads/photo`. The
 * invariant the comment above FAVICON_TYPES states ("SVG must stay absent") was
 * written down and enforced nowhere; this is where it is enforced.
 *
 * Pure, so the rule is unit-testable without the environment; `uploadRoutes`
 * applies it at registration, which fails the server's startup rather than
 * admitting the type.
 */
export function uploadConfigProblems(
  allowed: string[],
  magic: Record<string, number[]> = MAGIC_BYTES,
  maxFileSize: number = MAX_FILE_SIZE,
): string[] {
  const problems: string[] = [];
  const unsigned = allowed.filter((t) => !magic[t]);
  if (unsigned.length) {
    problems.push(
      `UPLOAD_ALLOWED_TYPES names type(s) with no magic-byte signature and therefore no content check: `
      + `${unsigned.join(', ')}. Only ${Object.keys(magic).join(', ')} can be allowed.`,
    );
  }
  if (!Number.isInteger(maxFileSize) || maxFileSize <= 0) {
    problems.push(`MAX_FILE_SIZE must be a positive integer number of bytes; got "${process.env.MAX_FILE_SIZE}".`);
  }
  return problems;
}

/**
 * Buffer an uploaded image and validate it, or return the reply code + body to
 * send back.
 *
 * Shared by ALL FOUR upload routes so none can drift into being the weaker one
 * (`/photo` carried its own copy until audit 2026-10-03, API-20, and that copy
 * had already drifted: it answered an oversize file with 400 where the others
 * answered 413). Two subtleties worth keeping in one place:
 *
 *  - @fastify/multipart SILENTLY TRUNCATES the stream at `fileSize` rather than
 *    throwing, so a post-buffer `length > MAX_FILE_SIZE` check is ALWAYS FALSE.
 *    `data.file.truncated` is the only reliable oversize signal.
 *  - The declared mime type is attacker-controlled, so the magic bytes are
 *    checked against it before anything touches disk — and a type with NO
 *    signature is REFUSED, never waved through (SEC-3). The startup check above
 *    makes that branch unreachable from the environment; it stays as the
 *    defence in depth for a caller that passes its own `allowed` list.
 *
 * Exported for the unit tests only.
 */
export async function readValidatedImage(
  data: { mimetype: string; file: NodeJS.ReadableStream & { truncated?: boolean } },
  allowed: string[] = ALLOWED_TYPES,
): Promise<{ ok: true; buffer: Buffer; ext: string } | { ok: false; code: 400 | 413; body: object }> {
  if (!allowed.includes(data.mimetype)) {
    return {
      ok: false, code: 400,
      // Named from the list actually in force, so a favicon 400 says ICO is
      // allowed and a background 400 does not. A generic message here sent an
      // operator hunting a server fault for a file the route was never going to take.
      body: {
        error: 'INVALID_FILE_TYPE',
        message: `Allowed image types: ${allowed.join(', ')}`,
      },
    };
  }

  // Resolved BEFORE the stream is read: a type that cannot be content-checked is
  // refused without buffering anything (SEC-3).
  const expectedMagic = MAGIC_BYTES[data.mimetype];
  if (!expectedMagic) {
    return {
      ok: false, code: 400,
      body: { error: 'INVALID_FILE_TYPE', message: `No content signature is known for ${data.mimetype}; it cannot be accepted.` },
    };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of data.file) chunks.push(chunk as Buffer);
  const buffer = Buffer.concat(chunks);

  if (data.file.truncated) {
    return {
      ok: false, code: 413,
      body: { error: 'FILE_TOO_LARGE', message: `File exceeds maximum size of ${MAX_MB} MB` },
    };
  }

  if (!expectedMagic.every((byte, i) => buffer[i] === byte)) {
    return {
      ok: false, code: 400,
      body: { error: 'INVALID_FILE', message: 'File content does not match declared type' },
    };
  }

  return { ok: true, buffer, ext: MIME_TO_EXT[data.mimetype] ?? '.jpg' };
}

/**
 * The catch-all every upload route shares. `FST_REQ_FILE_TOO_LARGE` is what
 * @fastify/multipart throws when `req.file()` itself refuses the part (rather
 * than truncating it), and it is 413 on EVERY route — `/photo` answered 400 for
 * it until audit 2026-10-03, API-20.
 */
function uploadFailure(app: FastifyInstance, reply: FastifyReply, err: unknown) {
  const e = err as { code?: string; statusCode?: number; message?: string };
  if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.code(413).send({
      error: 'FILE_TOO_LARGE',
      message: `File exceeds maximum size of ${MAX_MB} MB`,
    });
  }
  if (e.statusCode === 415 || e.message?.includes('multipart')) {
    return reply.code(400).send({
      error: 'INVALID_REQUEST',
      message: 'Request must be multipart/form-data with a file',
    });
  }
  app.log.error(err);
  return reply.code(500).send({ error: 'Failed to upload file' });
}

export default async function uploadRoutes(app: FastifyInstance) {
  // Refuse to start on an environment the validator cannot honour (SEC-3). A
  // thrown registration error stops `app.register(uploadRoutes)` and so the
  // server, which is the point: a misconfigured allow-list must be loud at
  // install time, not discovered as a stored-XSS report.
  const problems = uploadConfigProblems(ALLOWED_TYPES);
  if (problems.length) {
    throw new Error(`Upload configuration refused (audit 2026-10-03, SEC-3):\n  ${problems.join('\n  ')}`);
  }

  // Ensure directories exist on startup
  await ensureDirectories();

  // POST /api/uploads/photo - Upload profile photo (authenticated users only)
  //
  // Deliberately has no permission preHandler: this is self-service by
  // construction — the file is named after the CALLER's own id and the route
  // returns a URL, touching no other user's record. It was gated on USER_UPDATE
  // ("Edit Users"), an admin capability that 6 of 8 seeded roles don't hold, so
  // every non-admin got a 403 setting their own photo from the Profile page.
  // Auth comes from the global onRequest hook (/api/* is not in the public
  // allowlist; only GET /uploads/photos/ is, so images render in <img>).
  app.post('/photo', {
    // Nothing here ever unlinks a file and there is no quota, so each call
    // permanently costs up to MAX_FILE_SIZE of disk. Dropping the permission
    // gate above widened who can spend that from USER_UPDATE-holders to every
    // authenticated user, so bound the loop: 30/hour is far above real use
    // (a photo is set occasionally) and far below a disk-exhaustion rate.
    // Keyed by IP, not user — @fastify/rate-limit registers its onRequest hook
    // before the auth plugin's, so req.user isn't populated when the key is
    // computed. This bounds the surface; it is not the orphan-file GC, which
    // remains a separate open finding.
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: {
      tags: ['Uploads'],
      summary: 'Upload a profile photo',
      description: `Upload a profile photo image file (JPEG, PNG, GIF, or WebP). Maximum file size is ${MAX_MB} MB. Returns the URL path for the uploaded photo.`,
      consumes: ['multipart/form-data'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            photoUrl: { type: 'string', description: 'Relative URL path to the uploaded photo' },
            filename: { type: 'string', description: 'Generated filename on the server' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        413: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        500: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const data = await req.file(FILE_LIMITS);
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      // The SHARED validator (audit 2026-10-03, API-20). This route carried its
      // own inline copy of the type / truncation / magic checks, which had drifted
      // from the one the other three use.
      const result = await readValidatedImage(data as never);
      if (!result.ok) return reply.code(result.code).send(result.body);

      // Named after the CALLER, so a photo can never land on another user's record.
      const filename = `${req.user.sub}-${randomUUID()}${result.ext}`;
      await writeFile(path.join(profilePhotosDir, filename), result.buffer);

      return { success: true, photoUrl: `/uploads/photos/${filename}`, filename };
    } catch (err: unknown) {
      return uploadFailure(app, reply, err);
    }
  });

  // POST /api/uploads/floorplan — a floorplan background image.
  //
  // Gated on CONFIG_UPDATE, unlike /photo. That route is self-service by
  // construction (the file is named after the caller's own id); this one writes
  // a SHARED asset every user will see, and costs disk that nothing reclaims.
  //
  // Image DIMENSIONS are not read here. The browser has already loaded the
  // image to display it and therefore knows them; decoding server-side would
  // mean an image-parsing dependency for a value that is only ever used as the
  // aspect ratio the normalized room coordinates are drawn against. A wrong
  // value distorts the operator's own editor immediately and visibly, so it is
  // self-correcting in a way a security-relevant field would not be.
  app.post('/floorplan', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    // Same reasoning as /photo's limit: nothing here unlinks a file and there
    // is no quota, so each call permanently costs up to MAX_FILE_SIZE of disk.
    // Plans are uploaded rarely; 20/hour is far above real use.
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      tags: ['Uploads'],
      summary: 'Upload a floorplan background image',
      description: `Upload a floor layout image (JPEG, PNG, GIF, or WebP). Maximum ${MAX_MB} MB. Returns the URL to store on the floorplan record.`,
      consumes: ['multipart/form-data'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            url: { type: 'string', description: 'Relative URL path to the uploaded image' },
            filename: { type: 'string' },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        413: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    try {
      const data = await req.file(FILE_LIMITS);
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      const result = await readValidatedImage(data as never);
      if (!result.ok) return reply.code(result.code).send(result.body);

      const filename = `${randomUUID()}${result.ext}`;
      await writeFile(path.join(floorplansDir, filename), result.buffer);

      return { success: true, url: `/uploads/floorplans/${filename}`, filename };
    } catch (err: unknown) {
      return uploadFailure(app, reply, err);
    }
  });

  // The app background image (2026-08-27). Like /floorplan and unlike /photo, this
  // writes a SHARED asset every user sees, so it carries CONFIG_UPDATE rather than
  // bare authentication — otherwise any signed-in user could replace what the whole
  // site looks like.
  //
  // The resulting path is stored on the `branding` config as `backgroundUrl`. It is
  // a PATH, never a data URI: `system_config` is read constantly and a branding
  // change is audited, so an inlined image would land twice in a §11 before/after
  // record. The 512-char cap on that field is what holds the line.
  app.post('/branding-background', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    // Same reasoning as the other two: nothing here unlinks a file and there is no
    // quota, so each call permanently costs up to MAX_FILE_SIZE of disk. Replacing a
    // background is a rare act.
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      tags: ['Uploads'],
      summary: 'Upload the application background image',
      description: `Upload a background image (JPEG, PNG, GIF, or WebP). Maximum ${MAX_MB} MB. Returns the URL to store on the branding config.`,
      consumes: ['multipart/form-data'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            url: { type: 'string', description: 'Relative URL path to the uploaded image' },
            filename: { type: 'string' },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        413: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    try {
      const data = await req.file(FILE_LIMITS);
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      // The SHARED validator — magic bytes checked against the declared (and
      // therefore attacker-controlled) mime type, and `truncated` for oversize.
      // Reused rather than reimplemented so this route cannot drift into being the
      // weaker of the three.
      const result = await readValidatedImage(data as never);
      if (!result.ok) return reply.code(result.code).send(result.body);

      // Extension from the VALIDATED mime type, never the supplied filename.
      const filename = `${randomUUID()}${result.ext}`;
      await writeFile(path.join(brandingDir, filename), result.buffer);

      // The PREVIOUS background file is deliberately NOT deleted. It may still be
      // named by an audited before-value of a branding change, and a §11 record that
      // points at a missing file is worse than an orphaned image. Disk is reclaimed
      // by the operator, not silently by this route.
      return { success: true, url: `/uploads/branding/${filename}`, filename };
    } catch (err: unknown) {
      return uploadFailure(app, reply, err);
    }
  });

  // The browser-tab FAVICON (2026-09-03). Stored on the branding config as
  // `faviconUrl` and applied by apps/web/src/lib/document-identity.ts.
  //
  // Its own route rather than a reuse of /branding-background, which writes to the
  // same directory and would have "worked": the two differ in what they ACCEPT.
  // A favicon is the one case where an operator reaches for a .ico, so this route
  // passes FAVICON_TYPES. Folding them together would have meant admitting .ico as
  // a page background and a profile photo too, for no reason.
  //
  // CONFIG_UPDATE for the same reason as the other two shared assets: this is what
  // every user's browser tab shows, so bare authentication is not enough.
  app.post('/branding-favicon', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    // Nothing here unlinks a file and there is no quota, so each call permanently
    // costs disk. Replacing a favicon is a rare act.
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      tags: ['Uploads'],
      summary: 'Upload the browser tab icon (favicon)',
      description: `Upload a favicon (ICO, PNG, JPEG, GIF or WebP). Maximum ${MAX_MB} MB. Returns the URL to store on the branding config as faviconUrl.`,
      consumes: ['multipart/form-data'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            url: { type: 'string', description: 'Relative URL path to the uploaded icon' },
            filename: { type: 'string' },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        413: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    try {
      const data = await req.file(FILE_LIMITS);
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      // The SHARED validator, with this route's wider allow-list — magic bytes
      // checked against the declared (attacker-controlled) mime type, `truncated`
      // for oversize. Reused rather than reimplemented so this route cannot drift
      // into being the weakest of the four.
      const result = await readValidatedImage(data as never, FAVICON_TYPES);
      if (!result.ok) return reply.code(result.code).send(result.body);

      // Extension from the VALIDATED mime type, never the supplied filename. The
      // UUID also means every upload gets a fresh URL, which is what defeats the
      // browser's very aggressive favicon caching — no cache-buster is needed.
      const filename = `${randomUUID()}${result.ext}`;
      await writeFile(path.join(brandingDir, filename), result.buffer);

      // The PREVIOUS favicon is deliberately NOT deleted, same rule as the
      // background: it may still be named by an audited before-value of a branding
      // change, and a §11 record pointing at a missing file is worse than an
      // orphaned image.
      return { success: true, url: `/uploads/branding/${filename}`, filename };
    } catch (err: unknown) {
      return uploadFailure(app, reply, err);
    }
  });
}
