/**
 * Session sweep — graphile-worker cron entry point (every 5 min, see
 * packages/queue/crontab.txt). Terminates idle/expired sessions and records a
 * LOGOUT audit so app-close / window-close / crash logouts land in the trail.
 */
import type { Task } from 'graphile-worker';
import { sweepExpiredSessions } from '../modules/auth/session-sweep.js';

export const sessionSweepTask: Task = async (_payload, helpers) => {
  try {
    const r = await sweepExpiredSessions();
    if (r.swept > 0) helpers.logger.info(`[SessionSweep] terminated ${r.swept} idle/expired session(s)`);
  } catch (e: any) {
    helpers.logger.warn(`[SessionSweep] failed: ${e?.message ?? String(e)}`);
  }
};
