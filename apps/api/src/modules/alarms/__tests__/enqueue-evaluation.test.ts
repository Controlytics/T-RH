import { describe, it, expect, vi, beforeEach } from 'vitest';

const addJob = vi.fn();
const getProducer = vi.fn(async () => ({ addJob }));

vi.mock('@digilog/queue', () => ({ getProducer: (...a: unknown[]) => getProducer(...(a as [])) }));

import { enqueueAlarmEvaluation, ALARM_EVALUATION_JOB_KEY } from '../enqueue-evaluation.js';

/**
 * Evaluate-on-ingest (2026-08-27).
 *
 * The evaluator ran only on a one-minute cron while telemetry arrives every
 * 15-35s, so an excursion waited up to 60s to raise and another 60s to clear.
 * This enqueues an evaluation when a reading lands.
 */
describe('enqueueAlarmEvaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addJob.mockResolvedValue(undefined);
    getProducer.mockResolvedValue({ addJob });
  });

  it('enqueues the same task the cron runs', async () => {
    await enqueueAlarmEvaluation();
    expect(addJob).toHaveBeenCalledTimes(1);
    expect(addJob.mock.calls[0][0]).toBe('alarm_evaluation');
  });

  /**
   * THE LOAD-BEARING ASSERTION. Telemetry arrives every 15-35s PER INSTRUMENT; with
   * a fleet that is many writes a minute, and one evaluation job each would flood
   * the queue with passes that all read the same overview. A job key coalesces every
   * enqueue arriving before the next run into ONE pending job.
   */
  it('coalesces bursts onto one pending job via a job key', async () => {
    await enqueueAlarmEvaluation();
    await enqueueAlarmEvaluation();
    await enqueueAlarmEvaluation();

    for (const call of addJob.mock.calls) {
      expect(call[2]?.jobKey).toBe(ALARM_EVALUATION_JOB_KEY);
    }
  });

  /**
   * `preserve_run_at` keeps the ORIGINAL run time when an existing pending job is
   * replaced. Without it every new reading pushes the scheduled run later, so a
   * chatty device could starve its own evaluation indefinitely — the queue would
   * look busy and the alarm would never fire.
   */
  it('does not let a later enqueue push the pending run further out', async () => {
    await enqueueAlarmEvaluation();
    expect(addJob.mock.calls[0][2]?.jobKeyMode).toBe('preserve_run_at');
  });

  /**
   * NEVER THROWS — the same contract as enqueue-notification.ts and
   * alarm-webhooks/enqueue.ts. This is called from the INGEST path, and the
   * evaluator's own header states the rule: an evaluation must never be able to
   * reject a telemetry write. Device data is the record; alarms are derived from it.
   */
  it('never throws when the producer is unavailable', async () => {
    getProducer.mockRejectedValue(new Error('queue down'));
    const log = vi.fn();
    await expect(enqueueAlarmEvaluation(log)).resolves.toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it('never throws when addJob fails', async () => {
    addJob.mockRejectedValue(new Error('nope'));
    await expect(enqueueAlarmEvaluation(vi.fn())).resolves.toBe(false);
  });

  it('reports success so a caller can tell the two apart', async () => {
    await expect(enqueueAlarmEvaluation()).resolves.toBe(true);
  });
});
