/**
 * PM Schedules — Overdue-task deviation workflow (2026-06-03).
 *
 * The `deviations` row is the single state machine: OPEN → ACKNOWLEDGED → CLOSED.
 * `sweepOverdueDeviations()` does BOTH halves and is idempotent by construction:
 *   - OPEN:  every APPROVED PM entry past its tolerance window whose counted
 *            filters aren't all cleaned → insert ONE deviation (UNIQUE
 *            pm_schedule_entry_id → no daily duplicates). Overdue notification
 *            fires only on first insert, guarded by `notified_at`.
 *   - CLOSE: any OPEN/ACKNOWLEDGED deviation whose filters have SINCE been
 *            cleaned (cycle completed on/after windowStart) → record completion
 *            + fire the completion notification once, guarded by
 *            `completion_notified_at`.
 *
 * "Cleaned" predicate = a COMPLETED CleaningCycle, performed with the configured
 * PM reason, with completedAt >= windowStart (covers in-window AND late cleaning
 * — a late cleaning is exactly what resolves an overdue task). The PM-reason half
 * matters: a deviation records that a SCHEDULED PM was missed, so only the
 * scheduled PM can resolve it. An unrelated clean (breakdown, test) must not
 * suppress or close it — that would assert the PM happened when it did not. This
 * MUST match My Tasks (`pm-due-tasks.ts`), which applies the same predicate; both
 * read it from `resolvePmReasonKeys()` in pm-shared.ts. Notifications are driven
 * off deviation transitions; the cleaning cycle-write paths are never touched.
 *
 * Trigger: daily cron (`pm_overdue_check`) + manual admin endpoint. NOT from the
 * read path `GET /due` (no side effects in a GET).
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { createNotification } from '../notifications/notification.service.js';
import { formatConfiguredDate } from '../../lib/format-datetime.js';
import { checkPmEnabled, resolvePmReasonKeys } from './pm-shared.js';

const DAY = 86400000;
// Don't auto-open deviations for entries whose window closed more than this many
// days ago — avoids a flood of ancient deviations on the first ever sweep.
const OPEN_HORIZON_DAYS = 90;

/** Whole days from `from` to `to` (to − from), floored at 0. Exported for tests. */
export function dayDiff(to: Date, from: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));
}

/** Read the configurable overdue-notification role list (default ["ADMIN"]). */
async function readNotifyRoles(): Promise<string[]> {
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'pm-schedule-settings' } });
  const stored = (cfg?.configValue ?? {}) as any;
  const inner = stored && typeof stored === 'object' && 'value' in stored ? stored.value : stored;
  const roles = inner?.overdueNotificationRoles;
  return Array.isArray(roles) && roles.length ? roles.map(String) : ['ADMIN'];
}

interface CountedAhu {
  ahuId: string;
  ahuName: string;
  mode: 'BOTH' | 'SET_A' | 'SET_B' | 'DISABLED';
  filters: { id: string; name: string }[];
}

/**
 * For the given AHU ids, resolve the per-AHU filter-set mode
 * (customAttributes.pmFilterSetMode) and the list of CHILD filters that count
 * toward PM completion. Mirrors pm-due-tasks.ts.
 */
async function loadCountedFilters(ahuIds: string[]): Promise<Map<string, CountedAhu>> {
  if (!ahuIds.length) return new Map();
  const [ahus, childRaw] = await Promise.all([
    prisma.assetInstance.findMany({
      where: { id: { in: ahuIds } },
      select: { id: true, name: true, customAttributes: true },
    }),
    prisma.assetInstance.findMany({
      where: { parentId: { in: ahuIds }, isActive: true, status: { not: 'Retired' } },
      select: { id: true, name: true, parentId: true, filterDetails: { select: { filterSet: true } } },
    }),
  ]);
  const byAhu = new Map<string, { id: string; name: string; filterSet: string | null }[]>();
  for (const f of childRaw) {
    if (!f.parentId) continue;
    if (!byAhu.has(f.parentId)) byAhu.set(f.parentId, []);
    byAhu.get(f.parentId)!.push({ id: f.id, name: f.name, filterSet: f.filterDetails?.filterSet ?? null });
  }
  const out = new Map<string, CountedAhu>();
  for (const a of ahus) {
    const attrs = (a.customAttributes as any) ?? {};
    const mode: CountedAhu['mode'] =
      attrs.pmFilterSetMode === 'SET_A' || attrs.pmFilterSetMode === 'SET_B' || attrs.pmFilterSetMode === 'DISABLED'
        ? attrs.pmFilterSetMode
        : 'BOTH';
    let filters = byAhu.get(a.id) ?? [];
    if (mode === 'SET_A') filters = filters.filter((f) => f.filterSet === 'SET_A');
    else if (mode === 'SET_B') filters = filters.filter((f) => f.filterSet === 'SET_B');
    out.set(a.id, { ahuId: a.id, ahuName: a.name, mode, filters: filters.map((f) => ({ id: f.id, name: f.name })) });
  }
  return out;
}

/**
 * Latest COMPLETED cycle completedAt per filter, only on/after `since`, and only
 * for cleanings performed with a PM reason. `pmReasonKeys` null = no PM reason
 * configured → any reason counts (legacy fallback, see resolvePmReasonKeys).
 */
async function latestCleanMap(filterIds: string[], since: Date, pmReasonKeys: Set<string> | null): Promise<Map<string, Date>> {
  if (!filterIds.length) return new Map();
  const rows = await prisma.cleaningCycle.groupBy({
    by: ['filterId'],
    where: {
      filterId: { in: filterIds }, status: 'COMPLETED', completedAt: { gte: since },
      ...(pmReasonKeys ? { cleaningReasonKey: { in: [...pmReasonKeys] } } : {}),
    },
    _max: { completedAt: true },
  });
  const m = new Map<string, Date>();
  for (const r of rows) if (r._max.completedAt) m.set(r.filterId, r._max.completedAt);
  return m;
}

/**
 * Resolve who performed the most recent overdue PM cleaning (CYCLE_COMPLETED
 * event). Scoped to the same PM-reason set as `latestCleanMap` so the recorded
 * performer is the one who did the PM, not whoever last did an unrelated clean.
 * The reason lives on the cycle, so filter through the event's cycle relation.
 */
async function latestCompleter(filterIds: string[], since: Date, pmReasonKeys: Set<string> | null): Promise<{ id: string; name: string } | null> {
  if (!filterIds.length) return null;
  const ev = await prisma.filterEvent.findFirst({
    where: {
      filterId: { in: filterIds }, eventType: 'CYCLE_COMPLETED', performedAt: { gte: since },
      ...(pmReasonKeys ? { cycle: { cleaningReasonKey: { in: [...pmReasonKeys] } } } : {}),
    },
    orderBy: { performedAt: 'desc' },
    select: { performedBy: true },
  });
  if (!ev?.performedBy) return null;
  const u = await prisma.user.findUnique({ where: { id: ev.performedBy }, select: { id: true, username: true, fullName: true } });
  // Show the user ID (username), not the full name, as the deviation performer.
  return u ? { id: u.id, name: u.username } : { id: ev.performedBy, name: ev.performedBy };
}

async function notifyOverdue(dev: any, ahu: CountedAhu, roles: string[], now: Date) {
  const overdueDays = dayDiff(now, dev.scheduledDate);
  const title = `AHU ${ahu.ahuName} cleaning overdue`;
  const message =
    `${ahu.ahuName} filters are overdue by ${overdueDays} day(s) — ${ahu.filters.length} filter(s) pending. ` +
    `Please complete cleaning. Scheduled ${await formatConfiguredDate(dev.scheduledDate)}.`;
  const metadata = {
    deviationId: dev.id, deviationNumber: dev.deviationNumber, kind: 'PM_OVERDUE',
    ahuId: ahu.ahuId, ahuName: ahu.ahuName, pmScheduleEntryId: dev.pmScheduleEntryId,
    overdueDays, filterCount: ahu.filters.length,
  };
  for (const role of roles) {
    await createNotification({ type: 'PM_OVERDUE', title, message, forRole: role, metadata });
  }
}

async function notifyCompletion(dev: any, byName: string | null, delayDays: number, roles: string[]) {
  const who = byName ?? 'An operator';
  const title = `Overdue cleaning completed — ${dev.ahuName}`;
  const message =
    `${who} completed overdue cleaning for ${dev.ahuName} filters ` +
    `(was overdue by ${dev.overdueDaysAtOpen} day(s); resolved with ${delayDays}-day delay).`;
  const metadata = {
    deviationId: dev.id, deviationNumber: dev.deviationNumber, kind: 'PM_OVERDUE_COMPLETED',
    ahuId: dev.ahuId, ahuName: dev.ahuName, completedByName: byName, delayDays,
    previousOverdueDays: dev.overdueDaysAtOpen,
  };
  for (const role of roles) {
    await createNotification({ type: 'PM_OVERDUE_COMPLETED', title, message, forRole: role, metadata });
  }
}

/**
 * Handle a UNIQUE(pm_schedule_entry_id) collision on deviation create.
 *
 * While the existing row is OPEN/ACKNOWLEDGED the collision IS the intended
 * idempotency — the entry is already on record as overdue and the daily sweep
 * must not duplicate it. Returns false; nothing to do.
 *
 * A CLOSED row is a different situation: the entry went overdue, was resolved,
 * and has since gone overdue AGAIN (its window moved via editApprovedEntry /
 * resubmitEntry). One deviation row per entry means this SECOND occurrence
 * cannot be recorded, and the bare `continue` this replaces dropped it in total
 * silence — no deviation, no notification, no audit row. A §11 deviation that
 * goes missing without a trace is worse than a loud failure, so make it loud:
 * audit it, notify the same roles the open path notifies, and count it in the
 * sweep result.
 *
 * Deliberately NOT done here:
 *  - reopening the closed row — that would overwrite the first occurrence's
 *    completion record (completedAt / delayDays / closedAt) with the second's,
 *    destroying regulated data to make room for it;
 *  - throwing — that would abort the sweep for every OTHER entry and skip the
 *    CLOSE half entirely, turning one unrecordable deviation into many.
 * Recording both occurrences properly needs `@@unique([pmScheduleEntryId,
 * windowEnd])` plus a fix to getDeviationContextForEntries (which keys a Map by
 * pmScheduleEntryId and would silently last-write-win with two rows per entry).
 * Until then the operator gets a loud, audited signal to handle it manually.
 */
async function recordBlockedDeviation(
  entry: { id: string; plannedDate: Date },
  ahu: CountedAhu,
  roles: string[],
  now: Date,
  ctx?: RequestContext,
): Promise<boolean> {
  const existing = await prisma.deviation.findUnique({ where: { pmScheduleEntryId: entry.id } });
  if (!existing || existing.status !== 'CLOSED') return false; // still open → genuine idempotent skip
  const overdueDays = dayDiff(now, entry.plannedDate);
  const title = `PM deviation could NOT be opened — ${ahu.ahuName}`;
  const message =
    `${ahu.ahuName} is overdue again by ${overdueDays} day(s) — ${ahu.filters.length} filter(s) pending — but ` +
    `deviation ${existing.deviationNumber} for this PM task is already CLOSED and only one deviation per task ` +
    `can be recorded. This re-occurrence is NOT captured as a deviation record — review and handle it manually.`;
  const metadata = {
    kind: 'PM_DEVIATION_BLOCKED', ahuId: ahu.ahuId, ahuName: ahu.ahuName,
    pmScheduleEntryId: entry.id, existingDeviationId: existing.id,
    existingDeviationNumber: existing.deviationNumber, overdueDays, filterCount: ahu.filters.length,
  };
  for (const role of roles) {
    await createNotification({ type: 'PM_OVERDUE', title, message, forRole: role, metadata });
  }
  await auditLog({
    userId: ctx?.userSub, userRole: ctx?.userRole ?? 'SYSTEM',
    action: 'DEVIATION_OPEN_BLOCKED', targetType: 'deviation', targetId: existing.id,
    beforeValue: { existingDeviationNumber: existing.deviationNumber, existingStatus: existing.status },
    afterValue: { ahuName: ahu.ahuName, pmScheduleEntryId: entry.id, overdueDays, filterCount: ahu.filters.length },
    reason:
      `PM task for ${ahu.ahuName} is overdue again by ${overdueDays} day(s), but deviation ` +
      `${existing.deviationNumber} for this task is already CLOSED — a second deviation cannot be recorded`,
    signatureMeaning:
      `Overdue-PM deviation for AHU "${ahu.ahuName}" could NOT be opened: closed deviation ` +
      `${existing.deviationNumber} already occupies this PM task — re-occurrence requires manual review`,
    ipAddress: ctx?.ipAddress ?? '127.0.0.1', userAgent: ctx?.userAgent, sessionId: ctx?.sessionId,
  });
  return true;
}

/**
 * Idempotent open+close sweep. Safe to call from cron or on-demand any number of
 * times. `ctx` is optional — present for the manual admin trigger, absent for
 * the cron (open/close audit then attributes to the system actor).
 *
 * `blocked` counts re-overdue entries whose deviation could not be recorded
 * because a CLOSED deviation already occupies the task — see
 * recordBlockedDeviation. Non-zero means an operator must intervene.
 */
export async function sweepOverdueDeviations(ctx?: RequestContext): Promise<{ opened: number; closed: number; blocked: number }> {
  await checkPmEnabled();
  const now = new Date();
  const roles = await readNotifyRoles();
  // Only a clean done with the PM reason satisfies a scheduled PM — shared with
  // My Tasks so the deviation record and the operator's task list agree.
  const pmReasonKeys = await resolvePmReasonKeys();
  let opened = 0;
  let closed = 0;
  let blocked = 0;

  // ── OPEN ──────────────────────────────────────────────────────────────
  const horizon = new Date(now.getTime() - OPEN_HORIZON_DAYS * DAY);
  const candidates = await prisma.pmScheduleEntry.findMany({
    where: { schedule: { status: 'ACTIVE' }, approvalStatus: 'APPROVED', windowEnd: { lt: now, gte: horizon } },
    include: { schedule: true },
  });
  const counted = await loadCountedFilters([...new Set(candidates.map((e) => e.schedule.entityId))]);
  for (const entry of candidates) {
    const ahu = counted.get(entry.schedule.entityId);
    if (!ahu || ahu.mode === 'DISABLED' || ahu.filters.length === 0) continue;
    const filterIds = ahu.filters.map((f) => f.id);
    const cleaned = await latestCleanMap(filterIds, entry.windowStart, pmReasonKeys);
    if (filterIds.every((id) => cleaned.has(id))) continue; // PM-cleaned → not an open deviation
    try {
      const dev = await prisma.deviation.create({
        data: {
          pmScheduleEntryId: entry.id,
          ahuId: ahu.ahuId, ahuName: ahu.ahuName,
          filterIds, filterCount: filterIds.length,
          scheduledDate: entry.plannedDate, windowStart: entry.windowStart, windowEnd: entry.windowEnd,
          overdueDaysAtOpen: dayDiff(now, entry.plannedDate), status: 'OPEN',
        },
      });
      opened++;
      await notifyOverdue(dev, ahu, roles, now);
      await prisma.deviation.update({ where: { id: dev.id }, data: { notifiedAt: new Date() } });
      await auditLog({
        userId: ctx?.userSub, userRole: ctx?.userRole ?? 'SYSTEM',
        action: 'DEVIATION_OPENED', targetType: 'deviation', targetId: dev.id,
        afterValue: { deviationNumber: dev.deviationNumber, ahuName: ahu.ahuName, overdueDays: dev.overdueDaysAtOpen, filterCount: filterIds.length },
        reason: `PM task for ${ahu.ahuName} overdue by ${dev.overdueDaysAtOpen} day(s) — deviation ${dev.deviationNumber} opened`,
        signatureMeaning: `Deviation ${dev.deviationNumber} auto-opened for overdue AHU "${ahu.ahuName}" cleaning`,
        ipAddress: ctx?.ipAddress ?? '127.0.0.1', userAgent: ctx?.userAgent, sessionId: ctx?.sessionId,
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // A deviation row already exists for this entry. Idempotent when it's
        // still open; a silently-unrecordable §11 record when it's closed.
        if (await recordBlockedDeviation(entry, ahu, roles, now, ctx)) blocked++;
        continue;
      }
      throw e;
    }
  }

  // ── CLOSE ─────────────────────────────────────────────────────────────
  const open = await prisma.deviation.findMany({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
  for (const dev of open) {
    const filterIds = Array.isArray(dev.filterIds) ? (dev.filterIds as string[]) : [];
    if (!filterIds.length) continue;
    const since = dev.windowStart ?? dev.scheduledDate;
    const cleaned = await latestCleanMap(filterIds, since, pmReasonKeys);
    if (!filterIds.every((id) => cleaned.has(id))) continue; // not all PM-cleaned yet
    const latestAt = [...cleaned.values()].reduce((a, b) => (b > a ? b : a));
    let completedBy = dev.acknowledgedBy ?? null;
    let completedByName = dev.acknowledgedByName ?? null;
    if (!completedBy) {
      const perf = await latestCompleter(filterIds, since, pmReasonKeys);
      completedBy = perf?.id ?? null;
      completedByName = perf?.name ?? null;
    }
    const delayDays = dayDiff(latestAt, dev.scheduledDate);
    await prisma.deviation.update({
      where: { id: dev.id },
      data: { status: 'CLOSED', completedBy, completedByName, completedAt: latestAt, delayDays, closedAt: now },
    });
    closed++;
    if (!dev.completionNotifiedAt) {
      await notifyCompletion(dev, completedByName, delayDays, roles);
      await prisma.deviation.update({ where: { id: dev.id }, data: { completionNotifiedAt: new Date() } });
    }
    await auditLog({
      userId: ctx?.userSub, userRole: ctx?.userRole ?? 'SYSTEM',
      action: 'DEVIATION_CLOSED', targetType: 'deviation', targetId: dev.id,
      afterValue: { deviationNumber: dev.deviationNumber, completedByName, delayDays, completedAt: latestAt.toISOString() },
      reason: `Overdue cleaning for ${dev.ahuName} completed — deviation ${dev.deviationNumber} closed (${delayDays}-day delay)`,
      signatureMeaning: `Deviation ${dev.deviationNumber} auto-closed: overdue AHU "${dev.ahuName}" cleaning completed by ${completedByName ?? 'operator'}`,
      ipAddress: ctx?.ipAddress ?? '127.0.0.1', userAgent: ctx?.userAgent, sessionId: ctx?.sessionId,
    });
  }

  return { opened, closed, blocked };
}

/** Operator confirms (with password, enforced at the route) an overdue task before cleaning. */
export async function acknowledgeDeviation(ctx: RequestContext, id: string) {
  const dev = await prisma.deviation.findUnique({ where: { id } });
  if (!dev) throw new AppError(404, 'NOT_FOUND', 'Deviation not found');
  if (dev.status === 'CLOSED') throw new AppError(409, 'CONFLICT', 'Deviation is already closed');
  const updated = await prisma.deviation.update({
    where: { id },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedBy: ctx.userSub, acknowledgedByName: ctx.userId, acknowledgedAt: new Date(),
      passwordVerified: true, assignedUserId: dev.assignedUserId ?? ctx.userSub,
    },
  });
  await auditLog({
    userId: ctx.userSub, userRole: ctx.userRole,
    action: 'ACKNOWLEDGE_PM_OVERDUE', targetType: 'deviation', targetId: id,
    beforeValue: { status: dev.status },
    afterValue: { status: 'ACKNOWLEDGED', passwordVerified: true, overdueDays: dev.overdueDaysAtOpen },
    reason: `Acknowledged overdue cleaning for ${dev.ahuName} (overdue by ${dev.overdueDaysAtOpen} day(s)) — password re-verified before completion`,
    signatureMeaning: `${ctx.userId} confirmed and authorized overdue cleaning for AHU "${dev.ahuName}" (deviation ${dev.deviationNumber})`,
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
  });
  return updated;
}

/** Paginated deviation list for the Deviations page (rows are self-describing). */
export async function listDeviations(query: any) {
  const page = Math.max(1, Number(query.page ?? 1));
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50)));
  const where: any = {};
  if (query.status && query.status !== 'ALL') where.status = query.status;
  if (query.ahuId) where.ahuId = query.ahuId;
  const [data, total, openCount] = await Promise.all([
    prisma.deviation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.deviation.count({ where }),
    prisma.deviation.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }),
  ]);
  // Live overdue-days (now − scheduledDate) for still-open rows.
  const now = new Date();
  const enriched = data.map((d) => ({
    ...d,
    liveOverdueDays: d.status === 'CLOSED' ? (d.delayDays ?? d.overdueDaysAtOpen) : dayDiff(now, d.scheduledDate),
  }));
  return { data: enriched, total, openCount, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Read-only deviation context keyed by pmScheduleEntryId, for the My Tasks /due
 * join. Lets the FE render "overdue by N days" + acknowledged state + the
 * deviation id to acknowledge against. NO writes here.
 */
export async function getDeviationContextForEntries(entryIds: string[]) {
  if (!entryIds.length) return new Map<string, any>();
  const devs = await prisma.deviation.findMany({
    where: { pmScheduleEntryId: { in: entryIds } },
    select: {
      id: true, deviationNumber: true, pmScheduleEntryId: true, status: true,
      scheduledDate: true, overdueDaysAtOpen: true, acknowledgedAt: true, acknowledgedByName: true,
      passwordVerified: true, completedAt: true, delayDays: true,
    },
  });
  const now = new Date();
  const m = new Map<string, any>();
  for (const d of devs) {
    m.set(d.pmScheduleEntryId, {
      deviationId: d.id, deviationNumber: d.deviationNumber, status: d.status,
      overdueDays: d.status === 'CLOSED' ? (d.delayDays ?? d.overdueDaysAtOpen) : dayDiff(now, d.scheduledDate),
      acknowledged: d.status !== 'OPEN' && d.passwordVerified,
      acknowledgedByName: d.acknowledgedByName,
    });
  }
  return m;
}
