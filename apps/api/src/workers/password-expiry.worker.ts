/**
 * Password-expiry notification sweep — graphile-worker daily cron entry point.
 *
 * Schedule lives in packages/queue/crontab.txt (`0 0 * * * password_expiry_check`)
 * and is loaded by the single Runner in app.ts. Warns users whose passwords are
 * nearing expiry (one per user per day) and sends a one-time expiry notice —
 * idempotent, so the daily cadence never produces duplicates.
 *
 * The single Runner in app.ts starts alongside the API (no USE_PG_QUEUE gate),
 * so this cron fires in any running instance. The manual
 * `POST /api/users/password-expiry-sweep` endpoint runs the same sweep on demand.
 */
import type { Task } from 'graphile-worker';
import { sweepPasswordExpiryNotifications } from '../modules/auth/password-expiry-sweep.js';

export const passwordExpiryCheckTask: Task = async (_payload, helpers) => {
  try {
    const r = await sweepPasswordExpiryNotifications();
    helpers.logger.info(`[Password Expiry] warned=${r.warned} expired=${r.expired}`);
  } catch (e: any) {
    helpers.logger.warn(`[Password Expiry] sweep skipped: ${e?.message ?? String(e)}`);
  }
};
