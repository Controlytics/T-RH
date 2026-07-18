/**
 * PM Schedules — shared helpers used across the split service modules.
 */
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

/**
 * Throws PM_DISABLED (404) if the `pm-schedule-settings` config key is not
 * marked enabled. Every public service entry point calls this first so the
 * module can be cleanly toggled off without leaking partial behaviour.
 */
export async function checkPmEnabled() {
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'pm-schedule-settings' } });
  const val = cfg?.configValue as any;
  if (!val?.enabled) throw new AppError(404, 'PM_DISABLED', 'PM scheduling module is not enabled');
}

/**
 * Resolve the configured PM cleaning-reason key(s) from
 * `system_config['filter-cleaning-reasons']`: any ACTIVE reason whose key or name
 * is "PM" (case-insensitive).
 *
 * Returns `null` when no PM reason is configured — there is then nothing that
 * distinguishes a scheduled PM from any other cleaning, so callers fall back to
 * the legacy "any completed cleaning counts" predicate rather than leaving every
 * PM task and deviation stuck forever. A non-null Set means "only a cleaning
 * performed with one of THESE reasons satisfies a scheduled PM".
 *
 * Single source of truth for both consumers — My Tasks (`pm-due-tasks.ts`) and
 * the overdue-deviation sweep (`pm-deviations.ts`). The two MUST agree: they
 * describe the same fact (did the scheduled PM happen?) on two surfaces, and
 * when they disagree the deviation record and the operator's task list tell an
 * inspector different stories. The sweep previously omitted this filter, so any
 * unrelated cleaning silently suppressed/closed an overdue-PM deviation.
 */
export async function resolvePmReasonKeys(): Promise<Set<string> | null> {
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'filter-cleaning-reasons' } });
  const raw = cfg?.configValue as any;
  const list: any[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
  const keys = new Set<string>(
    list
      .filter((r: any) => r && r.isActive !== false && (
        (typeof r.key === 'string' && r.key.toUpperCase() === 'PM') ||
        (typeof r.name === 'string' && r.name.toUpperCase() === 'PM')
      ))
      .map((r: any) => r.key),
  );
  return keys.size > 0 ? keys : null;
}
