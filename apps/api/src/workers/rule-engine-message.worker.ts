import type { Task } from 'graphile-worker';
import { ruleEngineMessageJobSchema } from '@digilog/queue';
import { toRuleOriginatorType } from '@digilog/shared';
import { ruleEngine, type RuleEngine } from '../modules/rule-engine/engine.js';
import { RULE_ENGINE_MESSAGE_TASK, ruleEngineQueueName } from '../modules/rule-engine/services.js';
import type { RuleMessage } from '../modules/rule-engine/message.js';
import { logger } from '../lib/logger.js';

/**
 * graphile-worker task `rule_engine_message` (rule chains, 2026-11-03; spec
 * §6, ruling S-4) — the rule engine's DURABLE path. The Checkpoint node, and
 * the Delay node with `runAt`, hand a message here through
 * `services.durable.enqueue`; it survives a restart, which ThingsBoard's
 * in-memory Delay does not. Jobs run on `rule-engine:<originatorId>`, one
 * originator at a time, in order.
 *
 * The message is re-injected at the connections AFTER `resumeAfterNodeId`
 * under `relation` (Success), through the Main queue, with its call stack, hop
 * count (a cycle through Delay / Checkpoint still reaches the hop limit) and
 * re-entry depth (`message._reentryDepth`, ruling RE-1) restored. The job
 * COMPLETES as soon as the Main queue ADMITS the message (ruled 2026-11-04,
 * review I5) — awaiting the whole flow held the originator's graphile queue
 * behind a slow chain. Once admitted the engine keeps it (ruling RE-2): a full
 * queue never evicts it, and a graceful stop hands it back here as a new job.
 * Only a CRASH between admission and processing loses it.
 *
 *  - Engine not started (boot, or a failed start), or the Main queue refuses
 *    it (stopping, or FULL) → the job is RESCHEDULED (ruling RE-2): the same
 *    payload is added again as a NEW job on the same queue, `requeues` + 1, at
 *    now + 5 s × 2^requeues (at most 5 min), and this one completes. graphile
 *    0.16 counts an attempt when it LOCKS a job (getJob) and has no way to
 *    put a running job back without one, so throwing spent one of the job's
 *    five attempts each time — about 4 minutes of refusals failed a Delay
 *    message for good. The cost of rescheduling: a crash between the add and
 *    this job's completion runs the message TWICE (the original's lock expires
 *    and it is retried). Without a `reschedule` (a direct caller) it throws, and
 *    graphile retries as before.
 *  - Engine switched OFF → the message is dropped and the job completes, as
 *    the Main queue drops its messages when switched off.
 *  - A malformed payload → logged and completed: retrying cannot fix it.
 *  - The chain or node since deleted → the message simply ends.
 */
export type RuleEngineMessageOutcome = 'admitted' | 'rescheduled' | 'dropped_disabled' | 'dropped_invalid';

export interface RuleEngineMessageOptions {
  /** Add `payload` as a new job on the originator's queue at `runAt` (the task passes graphile's `addJob`). */
  reschedule?: (payload: Record<string, unknown>, runAt: Date, originatorId: string) => Promise<void>;
}

/** 5 s, 10 s, 20 s … — the n-th reschedule's wait, at most 5 minutes. */
export const RESCHEDULE_BASE_MS = 5_000;
export const RESCHEDULE_MAX_MS = 300_000;
export const rescheduleDelayMs = (requeues: number) => Math.min(RESCHEDULE_MAX_MS, RESCHEDULE_BASE_MS * 2 ** Math.min(requeues, 20));

export async function runRuleEngineMessage(
  payload: unknown, engine: RuleEngine = ruleEngine, opts: RuleEngineMessageOptions = {},
): Promise<RuleEngineMessageOutcome> {
  const parsed = ruleEngineMessageJobSchema.safeParse(payload);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues.slice(0, 3) }, '[rule-engine] a durable message job is malformed — dropped');
    return 'dropped_invalid';
  }
  const { message, chainId, resumeAfterNodeId, relation, requeues = 0 } = parsed.data;
  const originatorType = toRuleOriginatorType(message.originator.type);
  if (!originatorType) {
    logger.error({ type: message.originator.type }, '[rule-engine] a durable message names an unknown originator type — dropped');
    return 'dropped_invalid';
  }
  const later = async (why: string): Promise<RuleEngineMessageOutcome> => {
    if (!opts.reschedule) throw new Error(`${why}; graphile will retry this job`);
    await opts.reschedule({ ...(payload as Record<string, unknown>), requeues: requeues + 1 },
      new Date(Date.now() + rescheduleDelayMs(requeues)), message.originator.id);
    return 'rescheduled';
  };
  if (!engine.started) return later('ENGINE_NOT_STARTED: the rule engine is not running yet');
  const msg: RuleMessage = {
    id: message.id,
    type: message.type,
    originator: { type: originatorType, id: message.originator.id, ...(message.originator.code ? { code: message.originator.code } : {}) },
    metadata: { ...message.metadata },
    data: message.data,
    ...(message._stack && message._stack.length > 0 ? { _stack: message._stack.map((f) => ({ ...f })) } : {}),
    ...(message._hops !== undefined ? { _hops: message._hops } : {}),
  };
  if (!engine.config().enabled) {
    logger.info({ msgId: msg.id, chainId }, '[rule-engine] switched off — a durable message was dropped');
    return 'dropped_disabled';
  }
  if (!engine.resumeAfter(msg, chainId, resumeAfterNodeId, [relation], { reentryDepth: message._reentryDepth ?? 0 })) {
    return later('QUEUE_REFUSED: the rule engine did not admit the message (stopping, or its queue is full)');
  }
  return 'admitted';
}

export const ruleEngineMessageTask: Task = async (payload, helpers) => {
  await runRuleEngineMessage(payload, ruleEngine, {
    reschedule: async (next, runAt, originatorId) => {
      await helpers.addJob(RULE_ENGINE_MESSAGE_TASK, next, {
        queueName: ruleEngineQueueName(originatorId), runAt, maxAttempts: helpers.job.max_attempts,
      });
    },
  });
};
