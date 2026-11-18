/**
 * Audit 2026-11-07, S2-H1 — a database drop while the job runner is RUNNING.
 *
 * In graphile-worker 0.16.6 a dropped database rejects the runner's cron or
 * worker-pool promise — here within a second of the cut, with `read ECONNRESET`;
 * a failed minute-boundary schedule takes the same path — and graphile's own
 * `.finally(...)` on each (`dist/runner.js`) left a SECOND, unhandled rejection:
 * Node exited the whole API before the runner's `promise` could report the error,
 * so `lib/job-runner-supervisor.ts` never got to restart anything.
 * `patches/graphile-worker+0.16.6.patch` (applied by the root `postinstall`)
 * handles those derived promises, as graphile 0.18 does. Mutation-checked
 * 2026-11-17: with the unpatched `runner.js` this test fails with exactly that
 * unhandled `read ECONNRESET`.
 *
 * This drives the REAL path end to end — real graphile, the real `startJobRunner`
 * and the real supervisor — against the test database through a TCP proxy that is
 * cut mid-run and then restored:
 * - no unhandled rejection (the process would have exited);
 * - the supervisor sees the runner die (`failed`) and starts a new one once the
 *   database answers again (`running`).
 *
 * The wait allows a minute in case only the next cron schedule notices the cut;
 * in practice the connection reset is seen at once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { startJobRunner, stopJobRunner } from '@digilog/queue';
import { prisma } from '../lib/prisma.js';
import { superviseJobRunner, type JobRunnerStatus, type JobRunnerSupervisor } from '../lib/job-runner-supervisor.js';

const TASK = 's2h1_db_drop_probe';

/** A TCP proxy to Postgres that can be cut (every socket destroyed, listener closed) and restored on the same port. */
function makeProxy(targetHost: string, targetPort: number) {
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  let port = 0;
  return {
    get port() { return port; },
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        const s = net.createServer((client) => {
          const upstream = net.connect(targetPort, targetHost);
          sockets.add(client);
          sockets.add(upstream);
          const drop = () => {
            client.destroy();
            upstream.destroy();
            sockets.delete(client);
            sockets.delete(upstream);
          };
          client.on('error', drop).on('close', drop);
          upstream.on('error', drop).on('close', drop);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => {
          port = (s.address() as net.AddressInfo).port;
          server = s;
          resolve();
        });
      });
    },
    cut(): Promise<void> {
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      const s = server;
      server = null;
      return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
    },
  };
}

describe('S2-H1: the job runner survives a database drop mid-run', () => {
  const dbUrl = new URL(process.env.DATABASE_URL!);
  const proxy = makeProxy(dbUrl.hostname, Number(dbUrl.port || 5432));
  const savedQueueUrl = process.env.DATABASE_URL_QUEUE;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const statuses: JobRunnerStatus[] = [];
  let supervisor: JobRunnerSupervisor | null = null;
  let crontabDir = '';

  beforeAll(async () => {
    await proxy.listen();
    const proxied = new URL(dbUrl.toString());
    proxied.hostname = '127.0.0.1';
    proxied.port = String(proxy.port);
    // Only the queue goes through the proxy; Prisma keeps its own direct connection.
    process.env.DATABASE_URL_QUEUE = proxied.toString();
    crontabDir = mkdtempSync(path.join(os.tmpdir(), 's2h1-'));
    process.on('unhandledRejection', onUnhandled);
  });

  afterAll(async () => {
    // Restore shared state FIRST, each step on its own, so a failing test still hands it back.
    process.off('unhandledRejection', onUnhandled);
    if (savedQueueUrl === undefined) delete process.env.DATABASE_URL_QUEUE;
    else process.env.DATABASE_URL_QUEUE = savedQueueUrl;
    supervisor?.stop();
    try { await stopJobRunner(); } catch { /* the runner may already be gone — nothing to stop */ }
    await proxy.cut();
    rmSync(crontabDir, { recursive: true, force: true });
    // The probe's cron registration and any job it scheduled, from the test database.
    await prisma.$executeRawUnsafe(
      `delete from graphile_worker._private_jobs where task_id in (select id from graphile_worker._private_tasks where identifier = $1)`,
      TASK,
    );
    await prisma.$executeRawUnsafe(`delete from graphile_worker._private_known_crontabs where identifier = $1`, TASK);
  });

  it('reports the dead runner and starts a new one when the database answers again — and never exits the process', async () => {
    const crontabPath = path.join(crontabDir, 'crontab.txt');
    // Every minute, so a cut is noticed at the next minute boundary.
    writeFileSync(crontabPath, `* * * * * ${TASK}\n`);
    supervisor = superviseJobRunner(
      () => startJobRunner({
        taskList: { [TASK]: async () => undefined },
        crontabPath,
        onExit: (err) => supervisor?.notifyExit(err),
      }),
      (status) => { statuses.push(status); },
      [500],
    );
    await supervisor.ready;
    expect(statuses).toEqual(['starting', 'running']);

    await proxy.cut();
    await vi.waitFor(() => expect(statuses).toContain('failed'), { timeout: 75_000, interval: 250 });

    await proxy.listen();
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('running'), { timeout: 20_000, interval: 250 });

    // Unpatched graphile left a rejection here that Node turns into a process exit.
    expect(unhandled).toEqual([]);
  }, 120_000);
});
