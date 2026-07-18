import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Single source of truth for where user-uploaded files live.
 *
 * The customer installer sets UPLOAD_DIR to C:\ProgramData\DigiLog\uploads so
 * uploads land OUTSIDE the program dir (which is read-only and replaced wholesale
 * on upgrade). Every writer + the static serve MUST resolve through this constant
 * so they can never drift apart (a mismatch = 404 on served photos, or files
 * written where the next upgrade deletes them). See EXE-PACKAGING-PLAN.md §9.6b.
 *
 * Fallback (no UPLOAD_DIR set, i.e. local dev) = apps/api/uploads, computed from
 * THIS file's own location so it is stable regardless of process.cwd(). Both the
 * tsx/dev path (src/lib) and the compiled path (dist/lib) resolve to apps/api/uploads.
 */
export const UPLOADS_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');
