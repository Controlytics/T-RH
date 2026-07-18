import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getProducer, getRunnerOptions, closeProducer } from '../connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://digilog:digilog123@localhost:5432/digilog_test_db';

describe('queue connection', () => {
  beforeAll(() => {
    // Point the lazy DATABASE_URL read inside getProducer/getRunnerOptions at the test DB.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterAll(async () => {
    await closeProducer();
  });

  it('getProducer returns a graphile-worker addJob-capable client', async () => {
    const producer = await getProducer();
    expect(producer).toHaveProperty('addJob');
    expect(typeof producer.addJob).toBe('function');
  });

  it('getRunnerOptions exposes the correct task list', () => {
    const opts = getRunnerOptions({
      taskList: {
        ingestion: async () => {},
        notification: async () => {},
      },
    });
    expect(Object.keys(opts.taskList!)).toContain('ingestion');
    expect(Object.keys(opts.taskList!)).toContain('notification');
  });

  it('passes crontabPath through to runner.crontab', () => {
    const opts = getRunnerOptions({
      taskList: { dlq_check: async () => {} },
      crontabPath: path.resolve(__dirname, '../../crontab.txt'),
    });
    expect(opts.crontab).toMatch(/dlq_check/);
  });
});
