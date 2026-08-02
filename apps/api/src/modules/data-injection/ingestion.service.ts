/**
 * Ingestion orchestration: queue → route → parse → fan-out → batched write.
 *
 * Writing one row per message will not survive a real fleet, so messages
 * accumulate in a BOUNDED queue and flush on an interval or a size threshold.
 *
 * The queue is in-process and does NOT survive a restart. That is an accepted
 * limitation of the single-instance design, stated so nobody assumes durability
 * the system does not have.
 */
import type { InboundMessage } from './adapters/protocol-adapter.js';
import { tailOf, routeTail } from './topic-router.js';
import { parsePayload, type Reading } from './payload-parser.js';
import { fanOut, type InstrumentResolver } from './fan-out.js';
import { writeBatch, writeDeadLetters, buildResolverCache } from './telemetry.repository.js';
import { unsSettings } from './subscriptions.js';

const FLUSH_MS = 250;
const FLUSH_SIZE = 500;
const DEFAULT_MAX_QUEUE = 10_000;

interface DeadLetterRow {
  protocolKey: string; topic: string; payload: string; reason: string; detail: string;
}

let queue: InboundMessage[] = [];
let maxQueue = DEFAULT_MAX_QUEUE;
let dropped = 0;
let flushed = 0;
let timer: NodeJS.Timeout | null = null;
const overflowDeadLetters: DeadLetterRow[] = [];

export async function enqueue(m: InboundMessage): Promise<void> {
  if (queue.length >= maxQueue) {
    // Drop the OLDEST and record it. Silent loss is indistinguishable from data
    // that never arrived; an operator needs to see that ingest fell behind.
    const victim = queue.shift();
    dropped++;
    if (victim) {
      overflowDeadLetters.push({
        protocolKey: victim.protocolKey, topic: victim.topic,
        payload: victim.payload.toString('utf8').slice(0, 4000),
        reason: 'QUEUE_OVERFLOW',
        detail: `Ingest queue full (${maxQueue}); oldest message discarded`,
      });
    }
  }
  queue.push(m);
  if (queue.length >= FLUSH_SIZE) await flushNow();
}

export async function flushNow(): Promise<void> {
  const batchMsgs = queue;
  queue = [];
  const overflow = overflowDeadLetters.splice(0, overflowDeadLetters.length);
  if (batchMsgs.length === 0 && overflow.length === 0) return;

  const deadLetters: DeadLetterRow[] = [...overflow];
  const allBatches: { instrumentId: string; readings: Reading[] }[] = [];

  // One resolver load and one settings read per flush, not per message.
  const [cache, settings] = await Promise.all([buildResolverCache(), unsSettings()]);
  // The separator is configurable and must match what derived the topics. A
  // hardcoded '/' would make every topic unroutable on a site using '.'.
  const separator = settings.separator;
  const resolver: InstrumentResolver = {
    bySlug: (baseTopic, i) => cache.bySlug.get(`${baseTopic}|${i}`) ?? null,
    byDeviceKey: (gatewayId, k) => cache.byDeviceKey.get(`${gatewayId}|${k}`) ?? null,
  };

  const deadLetter = (m: InboundMessage, reason: string, detail: string) => {
    deadLetters.push({
      protocolKey: m.protocolKey, topic: m.topic,
      payload: m.payload.toString('utf8').slice(0, 4000),
      reason, detail,
    });
  };

  for (const m of batchMsgs) {
    // The gateway comes from the SUBSCRIPTION the message arrived on, never from
    // parsing the topic — see topic-router.ts.
    const tail = m.baseTopic ? tailOf(m.topic, m.baseTopic, separator) : null;
    const routed = tail === null ? null : routeTail(tail, separator);
    if (!routed) {
      deadLetter(m, 'UNROUTABLE_TOPIC',
        'Topic is not under the subscribed base, does not end in a known '
        + 'category, or has an ambiguous tail depth');
      continue;
    }
    const route = {
      gatewayId: m.gatewayId,
      gatewaySlug: m.gatewaySlug,
      baseTopic: m.baseTopic,
      ...routed,
    };
    const result = fanOut(route, parsePayload(m.payload), resolver, m.receivedAt);
    allBatches.push(...result.batches);
    for (const dl of result.deadLetters) deadLetter(m, dl.reason, dl.detail);
  }

  if (allBatches.length > 0) {
    await writeBatch(allBatches, new Date());
    flushed += allBatches.length;
  }
  if (deadLetters.length > 0) await writeDeadLetters(deadLetters);
}

export function startFlushLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushNow().catch(() => { /* a failed flush must not kill the loop */ });
  }, FLUSH_MS);
}

export function stopFlushLoop(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function getQueueStats(): { depth: number; dropped: number; flushed: number } {
  return { depth: queue.length, dropped, flushed };
}

/** Test-only. `max` lets a test force overflow without enqueuing 10 000 messages. */
export function resetQueueForTest(max = DEFAULT_MAX_QUEUE): void {
  queue = []; dropped = 0; flushed = 0; maxQueue = max;
  overflowDeadLetters.length = 0;
  stopFlushLoop();
}
