import type { Task } from 'graphile-worker';
import { ruleEngineMessageJobSchema } from '@digilog/queue';
import { toRuleOriginatorType } from '@digilog/shared';
import { ruleEngine, type RuleEngine } from '../modules/rule-engine/engine.js';
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
 * under `relation` (Success), through the Main queue, with its call stack and
 * hop count restored (a cycle through Delay / Checkpoint still reaches the hop
 * limit). The job COMPLETES as soon as the Main queue ADMITS the message
 * (ruled 2026-11-04, review I5) — awaiting the whole flow held the
 * originator's graphile queue behind a slow chain. A restart between
 * admission and processing loses it, as it loses any Main-queue message.
 *  - Engine not started yet (boot) → the job THROWS, so graphile retries it.
 *  - The Main queue refuses it (the engine stopping) → THROWS, retried.
 *  - Engine switched OFF → the message is dropped and the job completes, as
 *    the Main queue drops its messages when switched off.
 *  - A malformed payload → logged and completed: retrying cannot fix it.
 *  - The chain or node since deleted → the message simply ends.
 */
export type RuleEngineMessageOutcome = 'admitted' | 'dropped_disabled' | 'dropped_invalid';

export async function runRuleEngineMessage(payload: unknown, engine: RuleEngine = ruleEngine): Promise<RuleEngineMessageOutcome> {
  const parsed = ruleEngineMessageJobSchema.safeParse(payload);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues.slice(0, 3) }, '[rule-engine] a durable message job is malformed — dropped');
    return 'dropped_invalid';
  }
  const { message, chainId, resumeAfterNodeId, relation } = parsed.data;
  const originatorType = toRuleOriginatorType(message.originator.type);
  if (!originatorType) {
    logger.error({ type: message.originator.type }, '[rule-engine] a durable message names an unknown originator type — dropped');
    return 'dropped_invalid';
  }
  if (!engine.started) throw new Error('ENGINE_NOT_STARTED: the rule engine is not running yet; graphile will retry this job');
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
    throw new Error('QUEUE_REFUSED: the rule engine did not admit the message; graphile will retry this job');
  }
  return 'admitted';
}

export const ruleEngineMessageTask: Task = async (payload) => {
  await runRuleEngineMessage(payload);
};
