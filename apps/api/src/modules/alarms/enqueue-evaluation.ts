import { getProducer } from '@digilog/queue';

/**
 * Asks for an alarm evaluation because a reading just arrived.
 *
 * WHY THIS EXISTS. The evaluator was scheduled ONLY by `* * * * * alarm_evaluation`
 * in `packages/queue/crontab.txt`, while telemetry arrives every 15-35s. Alarm state
 * therefore changed only on whole-minute boundaries — every `raised_at` and
 * `cleared_at` in the database sat on `:00` — so an excursion waited up to 60s to
 * raise and another 60s to clear, no matter how fast the device reported. The hooter
 * annunciator inherits that latency: a buzzer cannot sound before the alarm exists.
 *
 * NEVER THROWS. The same contract as `enqueue-notification.ts` and
 * `alarm-webhooks/enqueue.ts`, and here it is load-bearing rather than tidy: this is
 * called from the INGEST path, and the evaluator's own header states the rule —
 * "an evaluation that throws must never be able to reject a telemetry write. Device
 * data is the record; alarms are derived from it." Enqueuing rather than evaluating
 * inline is what keeps that true even if the evaluation itself is broken.
 *
 * THE CRON STAYS. It is not redundant: OFFLINE alarms fire on the ABSENCE of
 * telemetry, and no amount of ingest-triggered evaluation can observe an instrument
 * that has gone quiet. The tick is also the safety net for a failed enqueue.
 */

/**
 * Coalesces a burst of readings onto one pending job.
 *
 * Telemetry arrives per instrument every 15-35s; across a fleet that is many writes
 * a minute, and one job each would queue dozens of passes that all read the same
 * overview. graphile-worker replaces an existing pending job with the same key, so
 * everything arriving before the next run collapses into a single evaluation.
 */
export const ALARM_EVALUATION_JOB_KEY = 'alarm_evaluation:on-ingest';

export async function enqueueAlarmEvaluation(
  log: (msg: string) => void = (m) => console.error(m),
): Promise<boolean> {
  try {
    const producer = await getProducer();
    await producer.addJob(
      'alarm_evaluation',
      {},
      {
        jobKey: ALARM_EVALUATION_JOB_KEY,
        // PRESERVE the original run_at when replacing a pending job. The default
        // (`replace`) resets it, so a device reporting every 15s would push its own
        // evaluation further out on every reading and could starve it indefinitely —
        // the queue would look busy while the alarm never fired.
        jobKeyMode: 'preserve_run_at',
        // One attempt. A retry would evaluate against a state that has already moved
        // on, and the one-minute cron re-evaluates everything anyway.
        maxAttempts: 1,
      },
    );
    return true;
  } catch (e) {
    log(`[alarms] could not enqueue evaluation after ingest: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
