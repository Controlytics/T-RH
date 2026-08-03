/**
 * Ordering contract between the telemetry write and alarm evaluation.
 *
 * These live in their OWN file rather than appended to ingestion.service.test.ts:
 * that file is a real-database integration suite with no module mocks, and
 * mocking telemetry.repository there would break all eight of its tests. Here
 * the repository and the evaluator are mocked so the failure paths — a rejected
 * write, a throwing evaluator — can be provoked deterministically. topic-router,
 * payload-parser and fan-out stay REAL so the batch that reaches writeBatch is
 * the one production would build.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage } from '../adapters/protocol-adapter.js';

const BASE = 'ordtest/ord-gw';
const INST = 'inst-ord-1';

vi.mock('../telemetry.repository.js', () => ({
  writeBatch: vi.fn().mockResolvedValue(undefined),
  writeDeadLetters: vi.fn().mockResolvedValue(undefined),
  buildResolverCache: vi.fn().mockResolvedValue({
    bySlug: new Map([[`${BASE}|ord-a`, INST]]),
    byDeviceKey: new Map(),
    collisions: [],
  }),
}));
vi.mock('../subscriptions.js', () => ({
  unsSettings: vi.fn().mockResolvedValue({ prefix: '', separator: '/', includeGateway: true }),
}));
vi.mock('../../alarms/alarm.service.js', () => ({
  evaluateFlush: vi.fn().mockResolvedValue({ raised: 0, rebreached: 0, resolved: 0 }),
}));

const { enqueue, flushNow, resetQueueForTest } = await import('../ingestion.service.js');
const { writeBatch, writeDeadLetters } = await import('../telemetry.repository.js');
const { evaluateFlush } = await import('../../alarms/alarm.service.js');

/** One well-formed topic-addressed telemetry message, so allBatches is non-empty. */
const goodMessage = (): InboundMessage => ({
  protocolKey: 'mqtt', profileId: 'p', topic: `${BASE}/ord-a/telemetry`,
  payload: Buffer.from(JSON.stringify({ temp: 21.5 })),
  receivedAt: new Date(), gatewaySlug: 'ord-gw', gatewayId: 'gw-ord', baseTopic: BASE,
});

beforeEach(() => {
  resetQueueForTest();
  vi.mocked(writeBatch).mockReset().mockResolvedValue(undefined);
  vi.mocked(writeDeadLetters).mockReset().mockResolvedValue(undefined);
  vi.mocked(evaluateFlush).mockReset().mockResolvedValue({ raised: 0, rebreached: 0, resolved: 0 });
});

describe('flushNow — alarm evaluation ordering', () => {
  it('evaluates alarms only after the telemetry write has landed', async () => {
    await enqueue(goodMessage());
    await flushNow();
    expect(vi.mocked(writeBatch)).toHaveBeenCalledOnce();
    expect(vi.mocked(evaluateFlush)).toHaveBeenCalledOnce();
    expect(vi.mocked(writeBatch).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(evaluateFlush).mock.invocationCallOrder[0]);
  });

  it('does not evaluate alarms when the telemetry write fails', async () => {
    // Evaluate-before-write would leave a latched excursion — one demanding a
    // signed acknowledgement — pointing at a reading that is not in the history
    // table. A missed alarm is recoverable; an alarm citing a non-existent
    // record is not.
    vi.mocked(writeBatch).mockRejectedValueOnce(new Error('db down'));

    await enqueue(goodMessage());
    await expect(flushNow()).rejects.toThrow('db down');
    expect(vi.mocked(evaluateFlush)).not.toHaveBeenCalled();
  });

  it('a failing evaluator writes a dead letter instead of failing silently', async () => {
    vi.mocked(evaluateFlush).mockRejectedValueOnce(new Error('evaluator exploded'));

    await enqueue(goodMessage());
    await flushNow();
    expect(vi.mocked(writeDeadLetters)).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ reason: 'ALARM_EVALUATION_FAILED' })]),
    );
  });

  it('carries the evaluator failure detail onto the dead letter', async () => {
    // A bare reason with no message would tell an operator that evaluation
    // broke but nothing about why.
    vi.mocked(evaluateFlush).mockRejectedValueOnce(new Error('evaluator exploded'));

    await enqueue(goodMessage());
    await flushNow();
    expect(vi.mocked(writeDeadLetters)).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ detail: 'evaluator exploded' })]),
    );
  });
});
