/**
 * The single graphile-worker task registry.
 *
 * Extracted from app.ts so `__tests__/task-list.test.ts` can assert that every
 * identifier in packages/queue/crontab.txt has a handler here. graphile-worker
 * silently enqueues jobs for unknown identifiers and never completes them; three
 * such entries once left 51,798 orphan rows in graphile_worker.jobs.
 *
 * Adding a cron line and adding its handler here are ONE change, never two.
 */
import type { TaskList } from 'graphile-worker';
import { notificationTask } from './notification.worker.js';
import { passwordExpiryCheckTask } from './password-expiry.worker.js';
import { sessionSweepTask } from './session-sweep.worker.js';
import { telemetryPartitionTask } from './telemetry-partition.worker.js';

export const taskList: TaskList = {
  // `notification` closes the producer/consumer gap flagged in the 2026-05-12
  // review — before it existed, enqueueNotificationJob posted to a task name
  // with no handler and jobs leaked forever.
  notification: notificationTask,
  password_expiry_check: passwordExpiryCheckTask,
  session_sweep: sessionSweepTask,
  telemetry_partition_maintenance: telemetryPartitionTask,
};
