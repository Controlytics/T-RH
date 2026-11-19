/**
 * Wait for the database before the API's first query (Windows packaging plan,
 * Phase A2 — audit 2026-11-19 N4).
 *
 * The first database query at boot is the config registry's `seedDefaults()`
 * (`discoverAndRegisterConfigs()` in app.ts). Before this, a database that was not
 * answering yet — a machine just switched on, the database service still starting,
 * an update restarting it — made that query throw, the process exit, and the service
 * wrapper restart it every 10 s with nothing in the log but a stack trace. Now the
 * API waits: one quiet `SELECT 1` every 5 s, a "waiting for database" line each time
 * saying why, and after 10 minutes a single clear error and exit.
 *
 * Only a CONNECTION failure is waited for — `Prisma.PrismaClientInitializationError`.
 * Measured on Prisma 6.19.2 (2026-11-19): a refused port, a connection the server
 * accepts and drops, and a rejected password all raise that class, its `errorCode`
 * is undefined (so the code cannot be used to tell them apart), and the SAME client
 * connects on a later query once the database answers. Any other error is not "the
 * database is not up yet" and is thrown at once.
 *
 * A wrong password is a connection failure too, so it is waited on for the full ten
 * minutes; each attempt logs Prisma's own reason ("Authentication failed …"), which
 * names the cause in the service log.
 */
import { Prisma } from '@prisma/client';

export const DB_BOOT_RETRY_INTERVAL_MS = 5_000;
export const DB_BOOT_MAX_WAIT_MS = 10 * 60_000;

export interface WaitForDatabaseLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface WaitForDatabaseOptions {
  /** One probe query; resolves when the database answered. */
  query: () => Promise<unknown>;
  log: WaitForDatabaseLog;
  /** What to call the database in messages: host:port/name, never the password. */
  target?: string;
  intervalMs?: number;
  maxWaitMs?: number;
  /** Seams for the unit test. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  isConnectionFailure?: (err: unknown) => boolean;
}

export class DatabaseNotReadyError extends Error {
  readonly attempts: number;
  readonly waitedMs: number;
  constructor(message: string, attempts: number, waitedMs: number, cause: unknown) {
    super(message, { cause });
    this.name = 'DatabaseNotReadyError';
    this.attempts = attempts;
    this.waitedMs = waitedMs;
  }
}

export function isDatabaseConnectionFailure(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientInitializationError;
}

/**
 * Prisma's message without its "Invalid `prisma.$queryRaw()` invocation:" preamble,
 * on one line. Prisma names the host, port and user — never the password.
 */
export function describeDatabaseError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Invalid `prisma\./.test(l));
  return (lines.join(' ') || 'no reason given').slice(0, 400);
}

/** `host:port/database` from a connection URL, for messages; never the credentials. */
export function databaseTarget(url: string | undefined): string {
  if (!url) return 'the database (DATABASE_URL is not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return 'the database (DATABASE_URL is not a valid URL)';
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForDatabase(opts: WaitForDatabaseOptions): Promise<{ attempts: number; waitedMs: number }> {
  const intervalMs = opts.intervalMs ?? DB_BOOT_RETRY_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DB_BOOT_MAX_WAIT_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const isConnectionFailure = opts.isConnectionFailure ?? isDatabaseConnectionFailure;
  const target = opts.target ?? 'the database';

  const started = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await opts.query();
      const waitedMs = now() - started;
      if (attempts > 1) {
        opts.log.info({ target, attempts, waitedSeconds: Math.round(waitedMs / 1000) }, 'database answered; continuing startup');
      }
      return { attempts, waitedMs };
    } catch (err) {
      if (!isConnectionFailure(err)) throw err;
      const waitedMs = now() - started;
      const reason = describeDatabaseError(err);
      if (waitedMs >= maxWaitMs) {
        throw new DatabaseNotReadyError(
          `${target} did not answer for ${Math.round(waitedMs / 60_000)} minute(s) (${attempts} attempts). ` +
            `Check that the database service is running and that DATABASE_URL is right. Last error: ${reason}`,
          attempts,
          waitedMs,
          err,
        );
      }
      opts.log.warn(
        { target, attempt: attempts, waitedSeconds: Math.round(waitedMs / 1000), retryInSeconds: Math.round(intervalMs / 1000), reason },
        'waiting for database',
      );
      await sleep(intervalMs);
    }
  }
}
