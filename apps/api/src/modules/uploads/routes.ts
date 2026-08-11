import { type FastifyInstance } from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOADS_ROOT } from '../../lib/uploads-dir.js';

// Uploads directory. UPLOADS_ROOT honors UPLOAD_DIR (customer install) — must
// match the static serve root in app.ts, otherwise written photos 404.
const profilePhotosDir = path.join(UPLOADS_ROOT, 'photos');
const floorplansDir = path.join(UPLOADS_ROOT, 'floorplans');

// Ensure upload directories exist
async function ensureDirectories() {
  await mkdir(profilePhotosDir, { recursive: true });
  await mkdir(floorplansDir, { recursive: true });
}

// Allowed image types — configurable via environment
const ALLOWED_TYPES = (process.env.UPLOAD_ALLOWED_TYPES ?? 'image/jpeg,image/png,image/gif,image/webp').split(',');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE ?? `${5 * 1024 * 1024}`, 10); // default 5MB

// Extension comes from the VALIDATED mime type, never the user-supplied
// filename — the filename is attacker-controlled and `evil.png.exe` is a real
// shape of that mistake.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
};

const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47],
  'image/gif': [0x47, 0x49, 0x46],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF header
};

/**
 * Buffer an uploaded image and validate it, or return the reply code + body to
 * send back.
 *
 * Shared by both upload routes so neither can drift into being the weaker one.
 * Two subtleties worth keeping in one place:
 *
 *  - @fastify/multipart SILENTLY TRUNCATES the stream at `fileSize` rather than
 *    throwing, so a post-buffer `length > MAX_FILE_SIZE` check is ALWAYS FALSE.
 *    `data.file.truncated` is the only reliable oversize signal.
 *  - The declared mime type is attacker-controlled, so the magic bytes are
 *    checked against it before anything touches disk.
 */
async function readValidatedImage(
  data: { mimetype: string; file: NodeJS.ReadableStream & { truncated?: boolean } },
): Promise<{ ok: true; buffer: Buffer; ext: string } | { ok: false; code: 400 | 413; body: object }> {
  if (!ALLOWED_TYPES.includes(data.mimetype)) {
    return {
      ok: false, code: 400,
      body: { error: 'INVALID_FILE_TYPE', message: 'Only JPEG, PNG, GIF, and WebP images are allowed' },
    };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of data.file) chunks.push(chunk as Buffer);
  const buffer = Buffer.concat(chunks);

  if (data.file.truncated) {
    return {
      ok: false, code: 413,
      body: { error: 'FILE_TOO_LARGE', message: `File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB` },
    };
  }

  const expectedMagic = MAGIC_BYTES[data.mimetype];
  if (expectedMagic && !expectedMagic.every((byte, i) => buffer[i] === byte)) {
    return {
      ok: false, code: 400,
      body: { error: 'INVALID_FILE', message: 'File content does not match declared type' },
    };
  }

  return { ok: true, buffer, ext: MIME_TO_EXT[data.mimetype] ?? '.jpg' };
}

export default async function uploadRoutes(app: FastifyInstance) {
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
      description: 'Upload a profile photo image file (JPEG, PNG, GIF, or WebP). Maximum file size is 5 MB. Returns the URL path for the uploaded photo.',
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
      const data = await req.file();

      if (!data) {
        return reply.code(400).send({ error: 'No file uploaded' });
      }

      // Validate file type
      if (!ALLOWED_TYPES.includes(data.mimetype)) {
        return reply.code(400).send({
          error: 'INVALID_FILE_TYPE',
          message: 'Only JPEG, PNG, GIF, and WebP images are allowed'
        });
      }

      // Generate unique filename — derive extension from validated MIME type, not user-supplied filename
      const MIME_TO_EXT: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
      };
      const ext = MIME_TO_EXT[data.mimetype] || '.jpg';
      const filename = `${req.user.sub}-${randomUUID()}${ext}`;
      const filepath = path.join(profilePhotosDir, filename);

      // Buffer the file first
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Check truncation flag — @fastify/multipart silently TRUNCATES the stream
      // at the configured fileSize limit instead of throwing. The post-buffer
      // length check (buffer.length > MAX_FILE_SIZE) is therefore always false
      // because the buffer is capped at exactly MAX_FILE_SIZE bytes. Checking
      // data.file.truncated is the only reliable way to detect oversized uploads.
      if ((data.file as any).truncated) {
        return reply.code(413).send({
          error: 'FILE_TOO_LARGE',
          message: `File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB`,
        });
      }

      // Validate magic bytes
      const MAGIC_BYTES: Record<string, number[]> = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/gif': [0x47, 0x49, 0x46],
        'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF header
      };
      const expectedMagic = MAGIC_BYTES[data.mimetype];
      if (expectedMagic) {
        const matches = expectedMagic.every((byte, i) => buffer[i] === byte);
        if (!matches) {
          return reply.code(400).send({ error: 'INVALID_FILE', message: 'File content does not match declared type' });
        }
      }

      // Write to disk
      await writeFile(filepath, buffer);

      // Return the URL
      const photoUrl = `/uploads/photos/${filename}`;

      return {
        success: true,
        photoUrl,
        filename,
      };
    } catch (err: any) {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(400).send({ error: 'FILE_TOO_LARGE', message: 'File exceeds maximum size of 5MB' });
      }
      if (err.statusCode === 415 || err.message?.includes('multipart')) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'Request must be multipart/form-data with a file' });
      }
      app.log.error(err);
      return reply.code(500).send({ error: 'Failed to upload file' });
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
      description: 'Upload a floor layout image (JPEG, PNG, GIF, or WebP). Maximum 5 MB. Returns the URL to store on the floorplan record.',
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
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      const result = await readValidatedImage(data as never);
      if (!result.ok) return reply.code(result.code).send(result.body);

      const filename = `${randomUUID()}${result.ext}`;
      await writeFile(path.join(floorplansDir, filename), result.buffer);

      return { success: true, url: `/uploads/floorplans/${filename}`, filename };
    } catch (err: unknown) {
      const e = err as { code?: string; statusCode?: number; message?: string };
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({
          error: 'FILE_TOO_LARGE',
          message: `File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB`,
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
  });
}
