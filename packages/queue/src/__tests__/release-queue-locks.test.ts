import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, quickAddJob } from 'graphile-worker';
import { releaseQueueLocks } from '../job-runner.js';

/**
 * Audit 2026-10-12 #2 follow-up. Every alarm_evaluation job now runs on ONE
 * named serial queue. graphile-worker leaves a queue LOCKED when the process
 * holding it dies without shutting down (stop-app.ps1 force-kills node), and
 * only frees it after FOUR HOURS — during which no alarm pass, OFFLINE included,
 * could run. Before the queue existed a dead pass stranded one row and the next
 * tick ran anyway. At boot of this single-process app any lock on that queue is
 * a dead process's, and `startJobRunner` releases it.
 *
 * Needs TEST_DATABASE_URL (a disposable database); skipped without it.
 */
const URL = process.env.TEST_DATABASE_URL;
const QUEUE = `release-locks-test-${Date.now()}`;

describe.skipIf(!URL)('releaseQueueLocks', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    await runMigrations({ connectionString: URL! });
  });

  afterAll(async () => {
    await pool.query(
      `delete from graphile_worker._private_jobs j using graphile_worker._private_job_queues q
        where j.job_queue_id = q.id and q.queue_name = $1`, [QUEUE]);
    await pool.query(`delete from graphile_worker._private_job_queues where queue_name = $1`, [QUEUE]);
    await pool.end();
  });

  it('unlocks a queue (and its job) left locked by a dead worker', async () => {
    const job = await quickAddJob({ connectionString: URL! }, 'noop_task', {}, { queueName: QUEUE });
    // What a killed worker leaves behind: the queue and its job locked "now".
    await pool.query(
      `update graphile_worker._private_job_queues set locked_at = now(), locked_by = 'dead-worker' where queue_name = $1`, [QUEUE]);
    await pool.query(
      `update graphile_worker._private_jobs set locked_at = now(), locked_by = 'dead-worker' where id = $1`, [job.id]);

    await releaseQueueLocks(URL!, [QUEUE]);

    const q = await pool.query(`select locked_at, locked_by from graphile_worker._private_job_queues where queue_name = $1`, [QUEUE]);
    expect(q.rows[0].locked_at).toBeNull();
    expect(q.rows[0].locked_by).toBeNull();
    const j = await pool.query(`select locked_at from graphile_worker._private_jobs where id = $1`, [job.id]);
    expect(j.rows[0].locked_at).toBeNull();
  });
});
