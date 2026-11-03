import type { Task } from 'graphile-worker';
import { ruleEngineDebugSweepJobSchema } from '@digilog/queue';
import { getRuleEngineConfig } from '../modules/rule-engine/config.js';
import { sweepDebugEvents } from '../modules/rule-engine/debug.js';

/**
 * graphile-worker task `rule_engine_debug_sweep` (rule chains, 2026-11-03;
 * spec §6) — hourly (`packages/queue/crontab.txt`). Debug events are not a
 * §11 record: rows older than Configuration → Rule Engine →
 * `debugRetentionHours` go, then each node keeps its newest
 * `debugMaxEventsPerNode`. Throws on a database error so the cron's
 * `max=3` retries it.
 */
export async function runRuleEngineDebugSweep(): Promise<{ aged: number; capped: number }> {
  const cfg = await getRuleEngineConfig();
  return sweepDebugEvents({ retentionHours: cfg.debugRetentionHours, maxPerNode: cfg.debugMaxEventsPerNode });
}

export const ruleEngineDebugSweepTask: Task = async (payload, helpers) => {
  ruleEngineDebugSweepJobSchema.parse(payload ?? {});
  const { aged, capped } = await runRuleEngineDebugSweep();
  if (aged || capped) helpers.logger.info(`[rule-engine] debug sweep: ${aged} expired, ${capped} over the per-node cap`);
};
