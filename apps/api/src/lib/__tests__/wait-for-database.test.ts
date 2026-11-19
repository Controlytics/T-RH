import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  waitForDatabase,
  describeDatabaseError,
  databaseTarget,
  isDatabaseConnectionFailure,
  DatabaseNotReadyError,
  DB_BOOT_RETRY_INTERVAL_MS,
  DB_BOOT_MAX_WAIT_MS,
} from '../wait-for-database.js';

/** The message shape Prisma 6.19.2 produced for a refused port (measured 2026-11-19). */
const UNREACHABLE =
  "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `127.0.0.1:5433`\n\nPlease make sure your database server is running at `127.0.0.1:5433`.";

function initError(message = UNREACHABLE) {
  return new Prisma.PrismaClientInitializationError(message, '6.19.2');
}

/** A fake clock: sleep() advances it, and every probe costs `probeMs`. */
function fakeClock(probeMs = 0) {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    probeCost: () => {
      t += probeMs;
    },
  };
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('waitForDatabase', () => {
  it('a database that answers at once: one probe, no log, no sleep', async () => {
    const clock = fakeClock();
    const log = fakeLog();
    const query = vi.fn().mockResolvedValue([{ ok: 1 }]);
    const r = await waitForDatabase({ query, log, now: clock.now, sleep: clock.sleep });
    expect(r).toEqual({ attempts: 1, waitedMs: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('waits through connection failures, every 5 s, then continues once the database answers', async () => {
    const clock = fakeClock();
    const log = fakeLog();
    const query = vi.fn().mockRejectedValueOnce(initError()).mockRejectedValueOnce(initError()).mockResolvedValue([{ ok: 1 }]);
    const r = await waitForDatabase({ query, log, now: clock.now, sleep: clock.sleep, target: '127.0.0.1:5433/digilog_db' });
    expect(r.attempts).toBe(3);
    expect(r.waitedMs).toBe(2 * DB_BOOT_RETRY_INTERVAL_MS);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenNthCalledWith(1, DB_BOOT_RETRY_INTERVAL_MS);
    expect(log.warn).toHaveBeenCalledTimes(2);
    const [fields, msg] = log.warn.mock.calls[0];
    expect(msg).toBe('waiting for database');
    expect(fields).toMatchObject({ target: '127.0.0.1:5433/digilog_db', attempt: 1, retryInSeconds: 5 });
    expect(fields.reason).toContain("Can't reach database server");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ attempts: 3 }), 'database answered; continuing startup');
  });

  it('gives up after ten minutes with one clear error naming the database and the last reason', async () => {
    const clock = fakeClock(2_000); // a refused connection took ~2 s here
    const log = fakeLog();
    const query = vi.fn(async () => {
      clock.probeCost();
      throw initError();
    });
    const err = await waitForDatabase({ query, log, now: clock.now, sleep: clock.sleep, target: '127.0.0.1:5433/digilog_db' }).catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseNotReadyError);
    expect(err.message).toContain('127.0.0.1:5433/digilog_db did not answer for 10 minute(s)');
    expect(err.message).toContain("Can't reach database server");
    expect(err.message).toContain('database service');
    expect(err.waitedMs).toBeGreaterThanOrEqual(DB_BOOT_MAX_WAIT_MS);
    // Attempt k fails 7(k-1) + 2 s in (2 s probe + 5 s wait per round); the first
    // attempt to fail at or past 10 minutes gives up instead of waiting again.
    expect(err.attempts).toBe(Math.ceil((DB_BOOT_MAX_WAIT_MS - 2_000) / 7_000) + 1);
    expect(err.waitedMs - DB_BOOT_MAX_WAIT_MS).toBeLessThan(7_000);
    expect(err.cause).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect(log.warn).toHaveBeenCalledTimes(err.attempts - 1);
  });

  it('an error that is not a connection failure is thrown at once, never waited on', async () => {
    const clock = fakeClock();
    const log = fakeLog();
    const boom = new Error('relation "system_config" does not exist');
    const query = vi.fn().mockRejectedValue(boom);
    await expect(waitForDatabase({ query, log, now: clock.now, sleep: clock.sleep })).rejects.toBe(boom);
    expect(query).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('a rejected password is a connection failure — waited on, and the reason is in every log line', async () => {
    const clock = fakeClock();
    const log = fakeLog();
    const auth = initError(
      '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nAuthentication failed against database server, the provided database credentials for `digilog` are not valid.\n\nPlease make sure to provide valid database credentials for the database server at the configured address.',
    );
    const query = vi.fn().mockRejectedValueOnce(auth).mockResolvedValue([]);
    await waitForDatabase({ query, log, now: clock.now, sleep: clock.sleep });
    expect(log.warn.mock.calls[0][0].reason).toMatch(/^Authentication failed/);
  });
});

describe('isDatabaseConnectionFailure', () => {
  it('only the Prisma initialization error class', () => {
    expect(isDatabaseConnectionFailure(initError())).toBe(true);
    expect(isDatabaseConnectionFailure(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: '6.19.2' }))).toBe(false);
    expect(isDatabaseConnectionFailure(new Error("Can't reach database server"))).toBe(false);
  });
});

describe('describeDatabaseError', () => {
  it('drops the "Invalid `prisma…` invocation" preamble and joins the rest on one line', () => {
    expect(describeDatabaseError(initError())).toBe(
      "Can't reach database server at `127.0.0.1:5433` Please make sure your database server is running at `127.0.0.1:5433`.",
    );
  });
  it('a non-Error value is described, not lost', () => {
    expect(describeDatabaseError('socket hang up')).toBe('socket hang up');
    expect(describeDatabaseError(new Error(''))).toBe('no reason given');
  });
});

describe('databaseTarget', () => {
  it('host:port/database — never the user or password', () => {
    const t = databaseTarget('postgresql://digilog:s3cret-value@127.0.0.1:5433/digilog_db?connection_limit=10');
    expect(t).toBe('127.0.0.1:5433/digilog_db');
    expect(t).not.toContain('s3cret');
    expect(t).not.toContain('digilog:');
  });
  it('the default port when none is given', () => {
    expect(databaseTarget('postgresql://u:p@db.local/app')).toBe('db.local:5432/app');
  });
  it('says so when DATABASE_URL is missing or unreadable', () => {
    expect(databaseTarget(undefined)).toContain('not set');
    expect(databaseTarget('not a url')).toContain('not a valid URL');
  });
});
