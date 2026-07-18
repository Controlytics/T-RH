/**
 * last-cleaned.ts — the SINGLE source of truth for a filter's "Last Cleaned".
 *
 * Extracted from hierarchy.service.ts (2026-06-11) so that the assets/instances
 * list can attach the SAME `lastCleanedAt` the web Filters page already shows.
 * Previously the tablet re-derived this client-side from a truncated
 * (limit=200) cycles list and missed: (a) filters whose last cleaning is in an
 * older cycle, and (b) stage-change events with no cycle attached (manual
 * "Edit Filter Status"). The web read this server value; the tablet didn't —
 * so they disagreed. Both now read `lastCleanedAt`.
 *
 * Effective value = the LATEST of:
 *   (a) the most recent cleaning-stage FilterEvent's `performedAt` — moves on
 *       EVERY stage change (real cleaning AND manual status edits), not just on
 *       cycle completion,
 *   (b) the most recent COMPLETED CleaningCycle's `completedAt` (safety net for
 *       any legacy completed cycle that lacks events), and
 *   (c) the manually-entered `attributes.lastCleaningDate` seed
 *       ('YYYY-MM-DD'; 'NA' / blank / malformed are ignored).
 *
 * Returns null when no source has a real date (caller may show 'NA'). Two
 * indexed groupBys per call.
 */
import { prisma } from './prisma.js';

export const CLEANING_STAGE_EVENT_TYPES = ['STATE_TRANSITION', 'BYPASS_DEVIATION', 'CYCLE_COMPLETED'] as const;

export async function zipLastCleaned<T extends { id: string; attributes?: any }>(
  rows: T[],
): Promise<Array<T & { lastCleanedAt: string | null }>> {
  if (rows.length === 0) return [] as any;
  const ids = rows.map((r) => r.id);
  const [eventAgg, cycleAgg] = await Promise.all([
    prisma.filterEvent.groupBy({
      by: ['filterId'],
      where: {
        filterId: { in: ids },
        eventType: { in: CLEANING_STAGE_EVENT_TYPES as unknown as any[] },
        // Both real cycle stage events AND manual "Edit Filter Status" stage
        // changes count — so a filter shown in a stage always has a date.
      },
      _max: { performedAt: true },
    }),
    prisma.cleaningCycle.groupBy({
      by: ['filterId'],
      where: { filterId: { in: ids }, status: 'COMPLETED' },
      _max: { completedAt: true },
    }),
  ]);
  const eventById = new Map<string, Date | null>(eventAgg.map((g) => [g.filterId, g._max.performedAt ?? null]));
  const cycleById = new Map<string, Date | null>(cycleAgg.map((g) => [g.filterId, g._max.completedAt ?? null]));
  return rows.map((r) => {
    // GREATEST over the candidate sources. Each contributes a comparable epoch
    // `t` and the `iso` to echo if it wins (date seed echoes as-is to avoid a
    // tz shift; timestamps echo full ISO so the column can show date + time).
    const candidates: Array<{ t: number; iso: string }> = [];
    const eventAt = eventById.get(r.id) ?? null;
    if (eventAt) candidates.push({ t: eventAt.getTime(), iso: eventAt.toISOString() });
    const cycleAt = cycleById.get(r.id) ?? null;
    if (cycleAt) candidates.push({ t: cycleAt.getTime(), iso: cycleAt.toISOString() });
    // User-editable date seed (strict YYYY-MM-DD; 'NA' / '' / malformed ignored).
    const dateRaw = r.attributes?.lastCleaningDate;
    if (typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      const d = new Date(`${dateRaw}T00:00:00.000Z`);
      if (!Number.isNaN(d.getTime())) candidates.push({ t: d.getTime(), iso: dateRaw });
    }
    const best = candidates.length
      ? candidates.reduce((a, b) => (b.t > a.t ? b : a))
      : null;
    return { ...r, lastCleanedAt: best ? best.iso : null };
  });
}
