/**
 * Integration test for startJobRunner.
 *
 * Phase 2 Task 2.8 — proves the single-Runner model: boot one Runner with
 * multiple task identifiers, enqueue one job per identifier, assert each
 * handler received its own payload. Runs against `digilog_test_db` and
 * piggy-backs on the same singleFork pool the bootstrap test uses, so the
 * two integration tests can't race on the schema.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { startJobRunner, stopJobRunner } from '../job-runner.js';
import { getProducer, closeProducer } from '../connection.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://digilog:digilog123@localhost:5432/digilog_test_db';

describe('startJobRunner integration', () => {
  let pool: Pool;

  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await stopJobRunner();
    await closeProducer();
    await pool.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
    await pool.end();
  });

  it('boots a Runner with multiple task identifiers and dispatches each correctly', async () => {
    const ingestionRan = vi.fn();
    const dlqRan = vi.fn();

    await startJobRunner({
      taskList: {
        ingestion: async (payload) => {
          ingestionRan(payload);
        },
        dlq_check: async (payload) => {
          dlqRan(payload);
        },
      },
    });

    const producer = await getProducer();
    await producer.addJob('ingestion', { msg: { messageId: 'm1' } });
    await producer.addJob('dlq_check', { tick: 1 });

    // Poll up to 3s for both handlers to fire.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (ingestionRan.mock.calls.length > 0 && dlqRan.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(ingestionRan).toHaveBeenCalledWith({ msg: { messageId: 'm1' } });
    expect(dlqRan).toHaveBeenCalledWith({ tick: 1 });
  }, 10_000);
});
