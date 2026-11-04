import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { RULE_ENGINE_MESSAGE_TASK } from '../../services.js';
import { processPattern, type JsonObject } from './support.js';

/**
 * DELAY (deprecated) — ThingsBoard's `TbMsgDelayNode` (rule chains, Task 5),
 * DURABLE here (spec §6, ruling S-4): the message is handed to graphile-worker
 * (`services.durable.enqueue`, task `rule_engine_message`, queue
 * `rule-engine:<originator>`) with `runAt` = now + the period, and resumes AFTER
 * this node on `Success` when it runs — a restart in between loses nothing
 * (ThingsBoard's delay is in memory and does). Nothing goes out now.
 *
 * The period: `periodInSeconds`, or with `useMetadataPeriodInSecondsPatterns`
 * the pattern, which must come out as a whole number of seconds.
 *
 * `maxPendingMsgs`: the messages already waiting at THIS node are counted in
 * the job table (so the count survives a restart too); at the limit the next
 * one fails with ThingsBoard's wording.
 */
export const DELAY_TYPE = 'tb:action:delay';

interface DelayConfig extends JsonObject {
  periodInSeconds?: number;
  maxPendingMsgs?: number;
  useMetadataPeriodInSecondsPatterns?: boolean;
  periodInSecondsPattern?: string | null;
}

function periodSeconds(cfg: DelayConfig, msg: RuleMessage): number {
  if (cfg.useMetadataPeriodInSecondsPatterns === true) {
    const text = processPattern(cfg.periodInSecondsPattern ?? '', msg).trim();
    if (!/^\d+$/.test(text)) throw new Error(`DELAY_PERIOD_INVALID: the period pattern came out as "${text}", not a whole number of seconds`);
    return Number(text);
  }
  const n = cfg.periodInSeconds;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`DELAY_PERIOD_INVALID: periodInSeconds is ${String(n)}`);
  return Math.floor(n);
}

/** Jobs of this node still waiting to run (or running): resume-after-this-node jobs with attempts left. */
async function pendingAt(ctx: RuleContext<DelayConfig>): Promise<number> {
  const rows = await ctx.services.prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    WHERE t.identifier = ${RULE_ENGINE_MESSAGE_TASK}
      AND j.payload ->> 'chainId' = ${ctx.chain.id}
      AND j.payload ->> 'resumeAfterNodeId' = ${ctx.node.id}
      AND j.attempts < j.max_attempts`;
  return rows[0]?.n ?? 0;
}

export async function delay(ctx: RuleContext<DelayConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  const seconds = periodSeconds(cfg, msg);
  const max = typeof cfg.maxPendingMsgs === 'number' && cfg.maxPendingMsgs >= 1 ? Math.floor(cfg.maxPendingMsgs) : 1000;
  if ((await pendingAt(ctx)) >= max) throw new Error('Max limit of pending messages reached!');
  await ctx.services.durable.enqueue(msg, ctx.chain.id, ctx.node.id, new Date(Date.now() + seconds * 1000));
}
