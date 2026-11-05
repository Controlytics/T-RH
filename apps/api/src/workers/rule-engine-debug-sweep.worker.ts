import type { Task, WithPgClient } from 'graphile-worker';
import { ruleEngineDebugSweepJobSchema, RULE_ENGINE_QUEUE_PREFIX } from '@digilog/queue';
import { getRuleEngineConfig } from '../modules/rule-engine/config.js';
import { sweepDebugEvents } from '../modules/rule-engine/debug.js';

/**
 * graphile-worker task `rule_engine_debug_sweep` (rule chains, 2026-11-03;
 * spec §6) — hourly (`packages/queue/crontab.txt`). Debug events are not a
 * §11 record: rows older than Configuration → Rule Engine →
 * `debugRetentionHours` go, then each node keeps its newest
 * `debugMaxEventsPerNode`. Then the empty rule-engine job queues go
 * (`gcRuleEngineJobQueues`, review A M3). Throws on a database error so the
 * cron's `max=3` retries it (both halves are safe to run again).
 */
export async function runRuleEngineDebugSweep(): Promise<{ aged: number; capped: number }> {
  const cfg = await getRuleEngineConfig();
  return sweepDebugEvents({ retentionHours: cfg.debugRetentionHours, maxPerNode: cfg.debugMaxEventsPerNode });
}

/**
 * Delete the `rule-engine:<originatorId>` job queues that hold no job and are not
 * locked (review A M3, 2026-11-05). graphile-worker 0.16 never deletes a named queue
 * — `completeJob` only UNLOCKS it (dist/sql/completeJob.js) — so every originator
 * that ever passed a Delay / Checkpoint left a `_private_job_queues` row forever (an
 * ALARM originator: one per alarm). Returns how many went.
 *
 * This is graphile's own `GC_JOB_QUEUES` statement (dist/cleanup.js) restricted to
 * the rule-engine prefix — NOT `WorkerUtils.cleanup({ tasks: ['GC_JOB_QUEUES'] })`,
 * which deletes EVERY empty queue, the serial `alarm_evaluation` queue included.
 * `add_jobs` makes sure a queue exists in one statement and inserts the job in the
 * next, and the job row has no foreign key to its queue: a delete committing between
 * the two leaves the new job with NO queue, so it runs beside its queue-mates instead
 * of after them. For `alarm_evaluation` (enqueued on every reading) that would undo
 * the audit 2026-10-12 #2 guarantee that two alarm passes never overlap. For a
 * rule-engine queue the same window costs one durable message its place in its
 * originator's order (the class review A M4 documents) — accepted.
 */
export async function gcRuleEngineJobQueues(withPgClient: WithPgClient): Promise<number> {
  const { rowCount } = await withPgClient((client) => client.query(
    `delete from graphile_worker._private_job_queues job_queues
      where job_queues.locked_at is null
        and starts_with(job_queues.queue_name, $1::text)
        and job_queues.id not in (
          select jobs.job_queue_id
            from graphile_worker._private_jobs jobs
           where jobs.job_queue_id is not null
        )`,
    [RULE_ENGINE_QUEUE_PREFIX],
  ));
  return rowCount ?? 0;
}

export const ruleEngineDebugSweepTask: Task = async (payload, helpers) => {
  ruleEngineDebugSweepJobSchema.parse(payload ?? {});
  const { aged, capped } = await runRuleEngineDebugSweep();
  if (aged || capped) helpers.logger.info(`[rule-engine] debug sweep: ${aged} expired, ${capped} over the per-node cap`);
  const queues = await gcRuleEngineJobQueues(helpers.withPgClient);
  if (queues) helpers.logger.info(`[rule-engine] ${queues} empty rule-engine job queue(s) deleted`);
};
