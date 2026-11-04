import type { RuleNodeHandler } from '../../context.js';

/**
 * Checkpoint — ThingsBoard's `TbCheckpointNode` (spec §6, §7 Flow):
 * ThingsBoard re-queues the message on another queue and continues it from
 * there on `Success`. Here the message is handed to the DURABLE queue
 * (`services.durable.enqueue` → graphile-worker task `rule_engine_message`,
 * ordered per originator), and THAT job resumes it after this node on
 * `Success` — it survives a restart. The Main flow therefore ends here: the
 * handler must not also send it on, or every message would continue twice.
 *
 * The enqueue failing → `Failure` with its error (ThingsBoard: tellFailure).
 * ThingsBoard's `queueName` is kept for export and not used (one durable
 * queue per originator here).
 */
export const CHECKPOINT = 'tb:flow:checkpoint';

export const checkpoint: RuleNodeHandler = async (ctx, msg) => {
  try {
    await ctx.services.durable.enqueue(msg, ctx.chain.id, ctx.node.id);
  } catch (err) {
    ctx.tellFailure(msg, err);
  }
};
