import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { superviseJobRunner, type JobRunnerStatus } from '../job-runner-supervisor.js';

/**
 * Audit 2026-11-07, S2-H1: the job runner was started ONCE at boot. A start that
 * failed (the database not up yet) was never retried, and a runner that died
 * later was never noticed — every alarm pass, notification, partition and session
 * sweep stopped while /api/health went on answering. The supervisor retries a
 * failed start and restarts a runner that exits.
 */
describe('superviseJobRunner', () => {
  let statuses: JobRunnerStatus[];
  const onStatus = (s: JobRunnerStatus) => { statuses.push(s); };

  beforeEach(() => {
    vi.useFakeTimers();
    statuses = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a failed start after 5 s, then 15 s, and reports running once it starts', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db still down'))
      .mockResolvedValueOnce(undefined);
    const sup = superviseJobRunner(start, onStatus);
    await sup.ready;
    expect(start).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['starting', 'failed']);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['starting', 'failed', 'failed']);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual(['starting', 'failed', 'failed', 'running']);
    sup.stop();
  });

  it('keeps retrying at the LAST delay once the list is used up', async () => {
    const start = vi.fn().mockRejectedValue(new Error('db down'));
    const sup = superviseJobRunner(start, onStatus, [10, 20]);
    await sup.ready;
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    expect(start).toHaveBeenCalledTimes(5);
    sup.stop();
  });

  it('a runner that EXITS after running is reported failed and restarted after 5 s', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const sup = superviseJobRunner(start, onStatus);
    await sup.ready;
    expect(statuses).toEqual(['starting', 'running']);

    sup.notifyExit(new Error('connection terminated'));
    expect(statuses).toEqual(['starting', 'running', 'failed']);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['starting', 'running', 'failed', 'running']);
    sup.stop();
  });

  it('ignores an exit report while nothing is running (no second retry chain)', async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const sup = superviseJobRunner(start, onStatus);
    await sup.ready;
    sup.notifyExit(new Error('stale report'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(start).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['starting', 'failed', 'running']);
    sup.stop();
  });

  it('stop() cancels a pending retry, and nothing restarts after it', async () => {
    const start = vi.fn().mockRejectedValue(new Error('db down'));
    const sup = superviseJobRunner(start, onStatus);
    await sup.ready;
    sup.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(start).toHaveBeenCalledTimes(1);
    sup.notifyExit(new Error('after stop'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
