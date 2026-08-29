import { getProducer } from '@digilog/queue';
import { alarmNotificationJob, type AlarmNotificationInput, type AlarmNotificationKind } from './notify.js';
import { logger } from '../../lib/logger.js';

/**
 * Enqueues an alarm notification onto the existing `notification` queue.
 *
 * NEVER throws. The alarm itself is the regulated record and is already committed by the
 * time this runs — failing to tell someone about it must not roll back, retry, or abort
 * the rest of the evaluation pass. A queue outage should cost a notification, not the
 * detection of every other excursion in the same minute.
 *
 * The retry that DOES matter happens on the consumer side: the handler lets a dispatch
 * failure throw so graphile-worker retries the delivery.
 */
export async function enqueueAlarmNotification(
  kind: AlarmNotificationKind,
  input: AlarmNotificationInput,
  log: (msg: string) => void = (m) => logger.error(m),
): Promise<boolean> {
  try {
    const producer = await getProducer();
    await producer.addJob('notification', alarmNotificationJob(kind, input), { maxAttempts: 3 });
    return true;
  } catch (e) {
    log(`[alarms] could not enqueue ${kind} notification for alarm ${input.alarmId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
