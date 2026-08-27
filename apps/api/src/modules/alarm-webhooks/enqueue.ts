import { getProducer } from '@digilog/queue';
import type { AlarmWebhookEvent } from '@digilog/shared';
import { buildWebhookVariables, type WebhookAlarmInput } from './build-variables.js';

/**
 * Enqueues an alarm webhook job.
 *
 * NEVER THROWS — the same contract as alarms/enqueue-notification.ts, for the same
 * reason. The alarm is the regulated record and is already committed by the time this
 * runs. A queue outage, or a hooter that is unplugged, must cost an annunciation and
 * never the detection of every other excursion in the same evaluation pass.
 *
 * maxAttempts: 1 on purpose. Retry is bounded INSIDE the task (3 attempts, ~2s apart);
 * graphile-worker's exponential backoff would otherwise sound a buzzer long after the
 * excursion cleared.
 */
export async function enqueueAlarmWebhook(
  event: Exclude<AlarmWebhookEvent, 'TEST'>,
  input: WebhookAlarmInput,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<boolean> {
  try {
    const producer = await getProducer();
    await producer.addJob(
      'alarm_webhook',
      {
        event,
        alarmId: input.alarmId,
        instrumentId: input.instrumentId,
        severity: input.severity,
        variables: buildWebhookVariables(event, input),
      },
      { maxAttempts: 1 },
    );
    return true;
  } catch (e) {
    log(`[alarm-webhook] could not enqueue ${event} for alarm ${input.alarmId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
