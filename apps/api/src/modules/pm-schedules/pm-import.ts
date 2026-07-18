/**
 * PM Schedules — bulk CSV/XLSX import + downloadable template.
 *
 * Behaviour preserved verbatim from the original `PmScheduleService` split:
 * row-level resilience (bad rows go to `skipped` instead of aborting the
 * batch), AHU resolution by stable templateKind, multi-format date parsing
 * (ISO, DMY, Excel serial, Date object), and SUPER_ADMIN bypass for the
 * approval workflow.
 *
 * Rows are parsed first, then bucketed by (AHU, year) and applied one
 * schedule per `$transaction`. Per-schedule atomicity is the point: the
 * hard-replace wipe and ALL of that schedule's new entries commit together,
 * so a failure part-way through a file can never leave a schedule wiped but
 * unpopulated. Two guards refuse the wipe outright — see `evaluateGuards`.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { checkPmEnabled } from './pm-shared.js';
import { getPmWorkflowConfig, assertPmRole, generateQnn } from './pm-workflow.js';

interface ParsedRow {
  rowNum: number;
  raw: Record<string, any>;
  ahu: { id: string; name: string };
  year: number;
  month: number;
  plannedDate: Date;
  toleranceDays: number;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Decide whether the hard-replace wipe may touch an existing schedule.
 * Returns an operator-facing reason when it must NOT, else null.
 *
 * Both refusals exist because the wipe is unrecoverable and happens at upload
 * time — before any approver has consented to the replacement:
 *   1. PmExecution rows are execution evidence (21 CFR §11); an upload must
 *      never destroy them. They are also FK children of the entries being
 *      deleted, so the wipe could not succeed anyway.
 *   2. With the review workflow on, replacements land in PENDING_REVIEW and
 *      may never be approved — so an upload must not wipe already-APPROVED
 *      entries and leave the schedule with nothing approved in their place.
 */
export async function evaluateGuards(
  scheduleId: string,
  ahuName: string,
  year: number,
  workflowEnabled: boolean,
): Promise<string | null> {
  const executionCount = await prisma.pmExecution.count({
    where: { scheduleEntry: { scheduleId } },
  });
  if (executionCount > 0) {
    return `Refusing to replace the ${year} schedule for AHU "${ahuName}": it has ${executionCount} recorded execution(s), which are retained evidence and cannot be deleted by an upload. Edit the affected months individually instead.`;
  }

  if (workflowEnabled) {
    const approvedCount = await prisma.pmScheduleEntry.count({
      where: { scheduleId, approvalStatus: 'APPROVED' },
    });
    if (approvedCount > 0) {
      return `Refusing to replace the ${year} schedule for AHU "${ahuName}": it has ${approvedCount} APPROVED entr${approvedCount === 1 ? 'y' : 'ies'} and the review workflow is enabled, so an upload would discard approved months in favour of entries that are not yet approved. Edit the affected months individually instead.`;
    }
  }

  return null;
}

export async function importSchedules(ctx: RequestContext, rows: Array<Record<string, any>>) {
  await checkPmEnabled();

  // Load default tolerance from config
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'pm-schedule-settings' } });
  const settings = (cfg?.configValue as any) ?? {};
  const defaultToleranceDays = Number(settings.defaultToleranceDays ?? 3);

  // 3-step workflow: when enabled, uploads land in PENDING_REVIEW (no auto-approve,
  // even for SUPER_ADMIN) and must be reviewed + approved before generating tasks.
  const wf = await getPmWorkflowConfig();

  // Enforce the configured uploadRole — step 1 of the SoD chain. Steps 2 and 3
  // assert their roles (pm-approval.ts: reviewRole, approvalRole), but
  // `wf.uploadRole` was read by NO code, so Step 1 was decorative even though the
  // config def promises "Role allowed to upload PM schedules" and the UI presents
  // it as workflow Step 1. Not currently exploitable on this path (only SUPERVISOR
  // and SUPER_ADMIN hold PM_UPLOAD/PM_CREATE, which happens to match the configured
  // role) — unlike the replacement path, where it WAS live. assertPmRole no-ops when
  // uploadRole is unset, so an unconfigured workflow stays permissive.
  assertPmRole(ctx.userRole, wf.uploadRole, 'upload');

  const imported: Array<{ row: number; ahuName: string; plannedDate: string; scheduleId: string; entryId: string }> = [];
  const skipped: Array<{ row: number; reason: string; data?: any }> = [];

  // Parsed rows awaiting the write phase, bucketed by (AHU, year).
  const parsed: ParsedRow[] = [];

  // Pre-fetch candidate AHUs (one scoped query) — cuts N queries to 1.
  // Filter by stable templateKind code, not by editable template.name (Step 1).
  const ahus = await prisma.assetInstance.findMany({
    where: {
      template: { templateKind: 'AHU' },
      isActive: true,
    },
    select: { id: true, name: true },
  });
  const ahuByName = new Map(ahus.map(a => [a.name.trim().toLowerCase(), a]));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +1 for header row, +1 for 1-indexed display

    // Accept several column name variants for friendliness
    const rawName = (row.ahu_name ?? row.ahuName ?? row.AHU ?? row['AHU Name'] ?? '').toString().trim();
    // rawDate may come through as: string ("2026-04-12"), Date object (XLSX),
    // or number (Excel serial from CSV auto-detection). Normalise below.
    const rawDateRaw = row.scheduled_date ?? row.scheduledDate ?? row.date ?? row['Scheduled Date'] ?? '';
    const rawTol = (row.tolerance_days ?? row.toleranceDays ?? row['Tolerance Days'] ?? '').toString().trim();

    if (!rawName) { skipped.push({ row: rowNum, reason: 'Missing ahu_name', data: row }); continue; }
    if (rawDateRaw === '' || rawDateRaw == null) {
      skipped.push({ row: rowNum, reason: 'Missing scheduled_date', data: row });
      continue;
    }

    // Resolve AHU by name
    const ahu = ahuByName.get(rawName.toLowerCase());
    if (!ahu) { skipped.push({ row: rowNum, reason: `AHU "${rawName}" not found in your organization`, data: row }); continue; }

    // Parse date. Three shapes can arrive:
    //   1. JS Date  — XLSX with cellDates or server-supplied
    //   2. number   — Excel serial (days since 1900-01-00, float-fractional hours)
    //   3. string   — "YYYY-MM-DD" / "YYYY/MM/DD" (preferred CSV form)
    // All three are normalised to UTC midnight so the value doesn't drift
    // in a non-UTC server timezone (Asia/Kolkata locally).
    let plannedDate: Date;
    if (rawDateRaw instanceof Date) {
      plannedDate = new Date(Date.UTC(
        rawDateRaw.getUTCFullYear(),
        rawDateRaw.getUTCMonth(),
        rawDateRaw.getUTCDate(),
      ));
    } else if (typeof rawDateRaw === 'number' && Number.isFinite(rawDateRaw)) {
      // Excel serial date (1900 epoch, accounting for the 1900 leap bug: offset 25569 = days from 1970-01-01)
      const ms = Math.round((rawDateRaw - 25569) * 86400 * 1000);
      const d = new Date(ms);
      plannedDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    } else {
      const rawDateStr = String(rawDateRaw).trim();
      // YYYY-MM-DD or YYYY/MM/DD (ISO-like)
      const isoMatch = rawDateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      // DD-MM-YYYY or DD/MM/YYYY (day-first, common in India/Europe)
      const dmyMatch = !isoMatch ? rawDateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/) : null;
      if (isoMatch) {
        const [, y, m, d] = isoMatch;
        plannedDate = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      } else if (dmyMatch) {
        const [, d, m, y] = dmyMatch;
        plannedDate = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      } else {
        plannedDate = new Date(rawDateStr); // fallback — may drift in local TZ
      }
      if (isNaN(plannedDate.getTime())) {
        skipped.push({ row: rowNum, reason: `Invalid scheduled_date "${rawDateStr}" — expected YYYY-MM-DD or DD-MM-YYYY`, data: row });
        continue;
      }
    }

    // Parse tolerance with fallback
    let toleranceDays: number;
    if (rawTol === '') {
      toleranceDays = defaultToleranceDays;
    } else {
      toleranceDays = Number(rawTol);
      if (!Number.isFinite(toleranceDays) || toleranceDays < 0 || toleranceDays > 365) {
        skipped.push({ row: rowNum, reason: `Invalid tolerance_days "${rawTol}" — expected 0-365`, data: row });
        continue;
      }
    }

    const year = plannedDate.getFullYear();
    const month = plannedDate.getMonth() + 1;
    const windowStart = new Date(plannedDate.getTime() - toleranceDays * 86400000);
    const windowEnd = new Date(plannedDate.getTime() + toleranceDays * 86400000);

    parsed.push({ rowNum, raw: row, ahu, year, month, plannedDate, toleranceDays, windowStart, windowEnd });
  }

  // Workflow ON: entries land in PENDING_REVIEW (review + approval required, no bypass).
  // Workflow OFF (legacy): SUPER_ADMIN auto-approves; others go to PENDING.
  const isSuperAdmin = ctx.userRole === 'SUPER_ADMIN';
  const approvalFields = wf.workflowEnabled
    ? {
        approvalStatus: 'PENDING_REVIEW' as const,
        submittedBy: ctx.userSub,
        submittedByName: ctx.userId,
      }
    : {
        approvalStatus: isSuperAdmin ? 'APPROVED' as const : 'PENDING' as const,
        submittedBy: ctx.userSub,
        submittedByName: ctx.userId,
        ...(isSuperAdmin ? { approvedBy: ctx.userSub, approvedByName: ctx.userId, approvedAt: new Date() } : {}),
      };

  // Bucket by (AHU, year) — one schedule per bucket, one transaction per schedule.
  const buckets = new Map<string, ParsedRow[]>();
  for (const p of parsed) {
    const key = `${p.ahu.id}::${p.year}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }

  for (const bucket of buckets.values()) {
    const { ahu, year } = bucket[0];
    try {
      const schedule = await prisma.pmSchedule.findFirst({
        where: { entityId: ahu.id, year, status: 'ACTIVE' },
        orderBy: { version: 'desc' },
      });

      // Guards run BEFORE any write: a blocked schedule must be left untouched.
      if (schedule) {
        const block = await evaluateGuards(schedule.id, ahu.name, year, wf.workflowEnabled);
        if (block) {
          for (const p of bucket) skipped.push({ row: p.rowNum, reason: block, data: p.raw });
          continue;
        }
      }

      // Last-wins per month, mirroring the previous per-row upsert where a later
      // row for the same month overwrote the earlier one.
      const byMonth = new Map<number, ParsedRow>();
      for (const p of bucket) byMonth.set(p.month, p);

      // Hard-replace + repopulate atomically: the new file fully REPLACES the
      // schedule, so old months absent from it stop generating /due tasks.
      const scheduleId = await prisma.$transaction(async (tx) => {
        const sid = schedule
          ? schedule.id
          : (await tx.pmSchedule.create({
              data: { entityId: ahu.id, year, status: 'ACTIVE', createdBy: ctx.userSub },
            })).id;

        if (schedule) await tx.pmScheduleEntry.deleteMany({ where: { scheduleId: sid } });

        await tx.pmScheduleEntry.createMany({
          data: [...byMonth.values()].map((p) => ({
            scheduleId: sid,
            month: p.month,
            plannedDate: p.plannedDate,
            toleranceDays: p.toleranceDays,
            windowStart: p.windowStart,
            windowEnd: p.windowEnd,
            ...approvalFields,
          })),
        });
        return sid;
      });

      // createMany returns no rows — read the ids back for the per-row report.
      const created = await prisma.pmScheduleEntry.findMany({
        where: { scheduleId },
        select: { id: true, month: true },
      });
      const entryIdByMonth = new Map(created.map((e) => [e.month, e.id]));

      for (const p of bucket) {
        imported.push({
          row: p.rowNum,
          ahuName: p.ahu.name,
          plannedDate: p.plannedDate.toISOString().slice(0, 10),
          scheduleId,
          entryId: entryIdByMonth.get(p.month) ?? '',
        });
      }
    } catch (e: any) {
      // The transaction rolled back — this schedule is unchanged on disk.
      for (const p of bucket) {
        skipped.push({ row: p.rowNum, reason: `DB error: ${e.message ?? String(e)}`, data: p.raw });
      }
    }
  }

  // Report rows in file order — the write phase groups by schedule, not by row.
  imported.sort((a, b) => a.row - b.row);
  skipped.sort((a, b) => a.row - b.row);

  await auditLog({
    userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_IMPORTED',
    targetType: 'pm_schedule', targetId: 'bulk',
    afterValue: { imported: imported.length, skipped: skipped.length, ahuNames: [...new Set(imported.map((i) => i.ahuName))] },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
  });

  // One QNN for the upload action (the bulk upload is a single user action).
  let qnn: string | null = null;
  if (imported.length > 0) {
    qnn = await generateQnn('UPLOAD', {
      message: `Uploaded ${imported.length} PM schedule entr${imported.length === 1 ? 'y' : 'ies'}${wf.workflowEnabled ? ' (pending review)' : ''}`,
    }, ctx);
  }

  return {
    imported: imported.length,
    skipped: skipped.length,
    details: { imported, skipped },
    qnn,
  };
}

/** Generate the CSV template string shown to users. */
export function getTemplateCsv(): string {
  return 'ahu_name,scheduled_date,tolerance_days\n';
}
