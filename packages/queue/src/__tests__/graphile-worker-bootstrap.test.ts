import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, run, quickAddJob } from 'graphile-worker';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://digilog:digilog123@localhost:5432/digilog_test_db';

describe('graphile-worker bootstrap', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await runMigrations({ connectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
    await pool.end();
  });

  it('installs the graphile_worker schema', async () => {
    const { rows } = await pool.query(`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = 'graphile_worker'
    `);
    expect(rows).toHaveLength(1);
  });

  it('round-trips a single job through enqueue + worker', async () => {
    let receivedPayload: unknown = null;
    const runner = await run({
      connectionString: TEST_DATABASE_URL,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: {
        echo: async (payload) => {
          receivedPayload = payload;
        },
      },
    });
    await quickAddJob({ connectionString: TEST_DATABASE_URL }, 'echo', { msg: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runner.stop();
    expect(receivedPayload).toEqual({ msg: 'hello' });
  });
});
