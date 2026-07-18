// Replacement Schedule upload + read service.
//
// Parses the uploaded .xlsx/CSV (template from template.service.ts), validates
// each row (AHU resolves by name, qty integer >= 1, date YYYY-MM-DD not in the
// past, tolerance integer), computes the +/- tolerance window, and creates one
// ReplacementSchedule batch + ReplacementScheduleEntry rows. Also exposes list
// + due-entry reads. Mirrors bulk-upload-filter.service.ts conventions.
import ExcelJS from 'exceljs';
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { stripHtml } from '../../lib/sanitize.js';
import { AppError } from '../../lib/errors.js';
import { FilterOperationsService } from '../filter-operations/filter-operations.service.js';
import { getReplacementWorkflowConfig, assertPmRole, generateQnn } from '../pm-schedules/pm-workflow.js';

export interface RowError { row: number; column?: string; value?: string; error: string; }
export interface UploadOutcome {
  results: Array<{ row: number; status: 'success' | 'error'; column?: string; value?: string; error?: string; ahuName?: string }>;
  created: number;
  failed: number;
  rows?: Array<Record<string, string>>;
  scheduleId?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Template header → canonical key (+ friendly aliases).
const HEADER_ALIASES: Record<string, string> = {
  sno: 'slNo', slno: 'slNo', serial: 'slNo',
  ahuname: 'ahuName', ahu: 'ahuName',
  filtermicron: 'filterMicron', micron: 'filterMicron', micronsize: 'filterMicron',
  filtersize: 'filterSize', size: 'filterSize', filterdimensions: 'filterSize', dimensions: 'filterSize',
  qty: 'qty', quantity: 'qty', count: 'qty',
  scheduledate: 'scheduleDate', date: 'scheduleDate',
  tolerancedays: 'toleranceDays', tolerance: 'toleranceDays',
};

interface ParsedRow {
  rowNumber: number;
  slNo: string; ahuName: string; filterMicron: string; filterSize: string;
  qty: string; scheduleDate: string; toleranceDays: string;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text).join('').trim();
    if (typeof o.text === 'string') return o.text.trim();
    if (o.result !== undefined) return String(o.result).trim();
    // Any other ExcelJS object shape (hyperlink-only, error, formula w/o result,
    // shared value, etc.) — treat as empty rather than letting String(v) stringify
    // it to the literal "[object Object]" and persist that as the filter size.
    return '';
  }
  return String(v).trim();
}

async function parseWorkbook(buffer: Buffer): Promise<{ rows: ParsedRow[]; error?: string }> {
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.load(buffer as any).then(() => {
    const ws = wb.worksheets.find((w) => w.name === 'Replacements' && w.state !== 'veryHidden') ?? wb.worksheets[0];
    if (!ws) return { rows: [], error: 'Workbook has no readable sheet' };
    const colKey: Record<number, string> = {};
    ws.getRow(1).eachCell((cell, col) => {
      const key = HEADER_ALIASES[normalize(cellToString(cell.value))];
      if (key) colKey[col] = key;
    });
    if (!Object.values(colKey).includes('ahuName')) return { rows: [], error: 'Template is missing an "AHU Name" column' };
    if (!Object.values(colKey).includes('scheduleDate')) return { rows: [], error: 'Template is missing a "Schedule Date" column' };

    const rows: ParsedRow[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const r: ParsedRow = { rowNumber, slNo: '', ahuName: '', filterMicron: '', filterSize: '', qty: '', scheduleDate: '', toleranceDays: '' };
      let any = false;
      row.eachCell((cell, col) => {
        const key = colKey[col];
        if (!key) return;
        const val = cellToString(cell.value);
        (r as any)[key] = val;
        if (val) any = true;
      });
      if (any) rows.push(r);
    });
    return { rows };
  }).catch(() => ({ rows: [] as ParsedRow[], error: 'Invalid .xlsx file' }));
}

async function loadDefaultToleranceDays(): Promise<number> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'replacement-schedule' } });
  const stored = row?.configValue as { value?: { defaultToleranceDays?: number } } | undefined;
  const v = stored && typeof stored === 'object' && 'value' in stored ? stored.value : undefined;
  const d = Number(v?.defaultToleranceDays);
  return Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0;
}

function todayUtcDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// AHU name -> id map (case-insensitive). Detects ambiguous (duplicate-name) AHUs.
async function buildAhuNameMap(): Promise<Map<string, string[]>> {
  const ahus = await prisma.ahu.findMany({ where: { isActive: true }, select: { id: true, name: true } });
  const map = new Map<string, string[]>();
  for (const a of ahus) {
    const k = a.name.trim().toLowerCase();
    map.set(k, [...(map.get(k) ?? []), a.id]);
  }
  return map;
}

// Normalize a micron value for comparison (trim + lowercase).
function normMicron(s: unknown): string {
  return stripHtml(String(s ?? '')).trim().toLowerCase();
}
// Normalize a free-text filter dimension so 610X510X25 / 200*400*600 / 200×400×600
// all compare equal: lowercase, drop whitespace, unify X/x/*/× separators to 'x'.
function normDim(s: unknown): string {
  return stripHtml(String(s ?? '')).trim().toLowerCase().replace(/\s+/g, '').replace(/[x×*]/g, 'x');
}

interface AhuFilterIndex { total: number; microns: Set<string>; combos: Map<string, number>; }

// Index every active (non-retired) filter per AHU: which micron sizes exist, and
// how many filters per (micron, dimension) combo. Drives the upload validation —
// a scheduled row is only accepted if a real filter under that AHU matches.
async function buildAhuFilterIndex(): Promise<Map<string, AhuFilterIndex>> {
  const filters = await prisma.filter.findMany({
    where: { isActive: true, status: { notIn: ['Retired', 'Replaced'] } },
    select: { ahuId: true, attributes: true },
  });
  const idx = new Map<string, AhuFilterIndex>();
  for (const f of filters as Array<{ ahuId: string | null; attributes: any }>) {
    if (!f.ahuId) continue;
    const attrs = (f.attributes ?? {}) as Record<string, any>;
    const m = normMicron(attrs.micronSize);
    const d = normDim(attrs.filterSize);
    let e = idx.get(f.ahuId);
    if (!e) { e = { total: 0, microns: new Set<string>(), combos: new Map<string, number>() }; idx.set(f.ahuId, e); }
    e.total++;
    if (m) e.microns.add(m);
    if (m && d) { const k = `${m}|${d}`; e.combos.set(k, (e.combos.get(k) ?? 0) + 1); }
  }
  return idx;
}

export async function processUpload(
  buffer: Buffer,
  fileName: string | undefined,
  ctx: RequestContext,
  opts: { validateOnly?: boolean } = {},
): Promise<UploadOutcome> {
  // Enforce the configured uploadRole — step 1 of the segregation-of-duties
  // chain. Steps 2 and 3 assert their roles (workflow.ts: reviewRole,
  // approvalRole), but `cfg.uploadRole` was read by NO code, so Step 1 was
  // decorative: the config def promises "Role allowed to upload replacement
  // schedules" and the UI shows it as workflow Step 1, while any holder of
  // REPLACEMENT_SCHEDULE_UPLOAD could upload regardless. LIVE at the time of
  // the fix — uploadRole was SUPERVISOR while MANAGER, QA and OPERATOR all held
  // the permission.
  //
  // Applies to the dry-run too: being able to validate an upload you may not
  // perform is pointless, and assertPmRole no-ops when uploadRole is unset, so
  // an unconfigured workflow stays permissive.
  const wf = await getReplacementWorkflowConfig();
  assertPmRole(ctx.userRole, wf.uploadRole, 'upload', 'replacement schedules');

  const parsed = await parseWorkbook(buffer);
  if (parsed.error) return { results: [{ row: 1, status: 'error', error: parsed.error }], created: 0, failed: 1 };
  const rows = parsed.rows;
  if (rows.length === 0) return { results: [{ row: 1, status: 'error', error: 'No data rows found' }], created: 0, failed: 1 };
  if (rows.length > 500) return { results: [{ row: 1, status: 'error', error: 'Maximum 500 rows per upload' }], created: 0, failed: 1 };

  const defaultTolerance = await loadDefaultToleranceDays();
  const ahuMap = await buildAhuNameMap();
  const ahuFilterIdx = await buildAhuFilterIndex();
  const today = todayUtcDateOnly();

  const results: UploadOutcome['results'] = [];
  const toCreate: Array<{
    rowNumber: number; slNo: number | null; ahuId: string; ahuName: string;
    filterMicron: string | null; filterSize: string | null; qty: number;
    scheduleDate: string; toleranceDays: number; windowStart: string; windowEnd: string;
  }> = [];

  for (const r of rows) {
    const rowErrs: RowError[] = [];
    const ahuNameRaw = stripHtml(r.ahuName).trim();
    const micron = stripHtml(r.filterMicron).trim();
    const size = stripHtml(r.filterSize).trim();

    // AHU resolution
    let ahuId = '';
    if (!ahuNameRaw) rowErrs.push({ row: r.rowNumber, column: 'AHU Name', value: '', error: 'AHU Name is required' });
    else {
      const ids = ahuMap.get(ahuNameRaw.toLowerCase());
      if (!ids || ids.length === 0) rowErrs.push({ row: r.rowNumber, column: 'AHU Name', value: ahuNameRaw, error: `No AHU named "${ahuNameRaw}"` });
      else if (ids.length > 1) rowErrs.push({ row: r.rowNumber, column: 'AHU Name', value: ahuNameRaw, error: `Multiple AHUs named "${ahuNameRaw}" — names must be unique` });
      else ahuId = ids[0];
    }

    // Qty
    const qtyN = Number(r.qty);
    if (!r.qty.trim()) rowErrs.push({ row: r.rowNumber, column: 'Qty', value: '', error: 'Qty is required' });
    else if (!Number.isInteger(qtyN) || qtyN < 1) rowErrs.push({ row: r.rowNumber, column: 'Qty', value: r.qty, error: 'Qty must be a whole number >= 1' });

    // Schedule date — YYYY-MM-DD, valid calendar day, not in the past
    const dateRaw = r.scheduleDate.trim();
    let scheduleDate = '';
    if (!dateRaw) rowErrs.push({ row: r.rowNumber, column: 'Schedule Date', value: '', error: 'Schedule Date is required' });
    else if (!ISO_DATE.test(dateRaw) || new Date(`${dateRaw}T00:00:00Z`).toISOString().slice(0, 10) !== dateRaw) {
      rowErrs.push({ row: r.rowNumber, column: 'Schedule Date', value: dateRaw, error: 'Schedule Date must be a valid date (YYYY-MM-DD)' });
    } else if (dateRaw < today) {
      rowErrs.push({ row: r.rowNumber, column: 'Schedule Date', value: dateRaw, error: 'Schedule Date cannot be in the past' });
    } else scheduleDate = dateRaw;

    // Tolerance — optional; column wins, else configured default
    let tolerance = defaultTolerance;
    const tolRaw = r.toleranceDays.trim();
    if (tolRaw) {
      const t = Number(tolRaw);
      if (!Number.isInteger(t) || t < 0) rowErrs.push({ row: r.rowNumber, column: 'Tolerance Days', value: tolRaw, error: 'Tolerance Days must be a whole number >= 0' });
      else tolerance = t;
    }

    // Filter Micron + Dimensions are required — they're validated against the
    // AHU's actual filters below.
    if (!micron) rowErrs.push({ row: r.rowNumber, column: 'Filter Micron', value: '', error: 'Filter Micron is required' });
    if (!size) rowErrs.push({ row: r.rowNumber, column: 'Filter Dimensions', value: '', error: 'Filter Dimensions is required' });

    // Cascade validation against the live filter list (2026-06-15 request):
    // AHU → has filters → micron exists → (micron, dimension) exists → qty available.
    // Only runs when the AHU resolved and micron/size/qty are present (otherwise the
    // field-level errors above already fire).
    if (ahuId && micron && size && Number.isInteger(qtyN) && qtyN >= 1) {
      const idx = ahuFilterIdx.get(ahuId);
      const m = normMicron(micron);
      const d = normDim(size);
      if (!idx || idx.total === 0) {
        rowErrs.push({ row: r.rowNumber, column: 'AHU Name', value: ahuNameRaw, error: `AHU "${ahuNameRaw}" has no filters to replace` });
      } else if (!idx.microns.has(m)) {
        rowErrs.push({ row: r.rowNumber, column: 'Filter Micron', value: micron, error: `Micron "${micron}" not found in AHU "${ahuNameRaw}"` });
      } else if (!idx.combos.has(`${m}|${d}`)) {
        rowErrs.push({ row: r.rowNumber, column: 'Filter Dimensions', value: size, error: `Dimensions "${size}" (micron ${micron}) not found in AHU "${ahuNameRaw}"` });
      } else {
        const avail = idx.combos.get(`${m}|${d}`) ?? 0;
        if (qtyN !== avail) rowErrs.push({ row: r.rowNumber, column: 'Qty', value: r.qty, error: `Qty ${qtyN} must equal the ${avail} filter(s) with micron ${micron} and dimensions ${size} in AHU "${ahuNameRaw}"` });
      }
    }

    if (rowErrs.length > 0) { for (const e of rowErrs) results.push({ status: 'error', ...e }); continue; }

    const slNoN = Number(r.slNo);
    toCreate.push({
      rowNumber: r.rowNumber,
      slNo: Number.isInteger(slNoN) ? slNoN : null,
      ahuId, ahuName: ahuNameRaw,
      filterMicron: micron || null, filterSize: size || null,
      qty: qtyN, scheduleDate, toleranceDays: tolerance,
      windowStart: addDays(scheduleDate, -tolerance), windowEnd: addDays(scheduleDate, tolerance),
    });
  }

  if (opts.validateOnly) {
    for (const c of toCreate) results.push({ row: c.rowNumber, status: 'success', ahuName: c.ahuName });
    results.sort((a, b) => a.row - b.row);
    return {
      results, created: 0, failed: results.filter((x) => x.status === 'error').length,
      rows: rows.map((r) => ({ slNo: r.slNo, ahuName: r.ahuName, filterMicron: r.filterMicron, filterSize: r.filterSize, qty: r.qty, scheduleDate: r.scheduleDate, toleranceDays: r.toleranceDays })),
    };
  }

  // All-or-nothing create: if any row failed validation, do not create a partial schedule.
  if (results.some((x) => x.status === 'error')) {
    results.sort((a, b) => a.row - b.row);
    return { results, created: 0, failed: results.filter((x) => x.status === 'error').length };
  }

  // Workflow ON → uploads land in PENDING_REVIEW (review + approval required
  // before they become due tasks). OFF → APPROVED immediately (current behaviour).
  // `wf` is fetched once at the top of this function (see the uploadRole guard).
  const approvalStatus = wf.workflowEnabled ? 'PENDING_REVIEW' as const : 'APPROVED' as const;

  const schedule = await prisma.$transaction(async (tx) => {
    // Append (2026-06-15, user request): a new upload ADDS to the existing
    // replacement schedule(s) rather than superseding them. Each upload creates
    // its own schedule row (preserving fileName / uploadedBy / date per batch);
    // prior schedules and their entries/executions are left untouched, so the
    // list, due, and tasks views show old + new together. Re-uploading the same
    // file will create duplicate rows — that's expected for plain append.
    const sch = await tx.replacementSchedule.create({
      data: { fileName: fileName ?? null, status: 'ACTIVE', uploadedBy: ctx.userSub, uploadedByName: ctx.userId },
    });
    // Audit 2026-06-08: single createMany instead of N per-row inserts.
    await tx.replacementScheduleEntry.createMany({
      data: toCreate.map((c) => ({
        scheduleId: sch.id, slNo: c.slNo, ahuId: c.ahuId, ahuName: c.ahuName,
        filterMicron: c.filterMicron, filterSize: c.filterSize, qty: c.qty,
        scheduleDate: new Date(`${c.scheduleDate}T00:00:00Z`),
        toleranceDays: c.toleranceDays,
        windowStart: new Date(`${c.windowStart}T00:00:00Z`),
        windowEnd: new Date(`${c.windowEnd}T00:00:00Z`),
        status: 'PENDING' as const,
        approvalStatus,
        submittedBy: ctx.userSub, submittedByName: ctx.userId,
      })),
    });
    return sch;
  });

  await auditLog({
    userId: ctx.userId, userRole: ctx.userRole,
    action: 'REPLACEMENT_SCHEDULE_UPLOADED', targetType: 'replacement_schedule', targetId: schedule.id,
    afterValue: {
      fileName: fileName ?? null,
      entries: toCreate.length,
      // Detail drill-down: which AHUs/filters were in this upload batch (titled
      // values so each token is self-explanatory, matching the workflow rows).
      ahus: toCreate.map((c) => `AHU: ${c.ahuName}${c.filterSize ? ` · Size: ${c.filterSize}` : ''}${c.filterMicron ? ` · Micron: ${c.filterMicron}µ` : ''} · Qty: ${c.qty}`),
    },
    reason: `Uploaded replacement schedule with ${toCreate.length} entr${toCreate.length === 1 ? 'y' : 'ies'}`,
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
  });

  // One QNN per upload action (surfaced in the Notifications center).
  await generateQnn('UPLOAD', {
    scheduleId: schedule.id,
    subject: 'Replacement Schedule',
    message: `Uploaded replacement schedule (${toCreate.length} entr${toCreate.length === 1 ? 'y' : 'ies'})${wf.workflowEnabled ? ' — pending review' : ''}`,
  }, ctx);

  for (const c of toCreate) results.push({ row: c.rowNumber, status: 'success', ahuName: c.ahuName });
  results.sort((a, b) => a.row - b.row);
  return { results, created: toCreate.length, failed: 0, scheduleId: schedule.id };
}

// Compute display status for an entry given today's date (does not mutate rows;
// MISSED/DUE are derived so the list/tasks reflect current time without a job).
function deriveStatus(e: { qty: number; qtyReplaced: number; windowStart: Date; windowEnd: Date; status: string }, today: string): string {
  if (e.qtyReplaced >= e.qty) return 'COMPLETED';
  const ws = e.windowStart.toISOString().slice(0, 10);
  const we = e.windowEnd.toISOString().slice(0, 10);
  if (today > we) return 'MISSED';
  if (today >= ws && today <= we) return e.qtyReplaced > 0 ? 'IN_PROGRESS' : 'DUE';
  return 'PENDING';
}

export async function listSchedules() {
  const today = todayUtcDateOnly();
  const schedules = await prisma.replacementSchedule.findMany({
    orderBy: { createdAt: 'desc' },
    include: { entries: { orderBy: [{ scheduleDate: 'asc' }, { slNo: 'asc' }] } },
  });
  return schedules.map((s) => ({
    ...s,
    entries: s.entries.map((e) => ({ ...e, computedStatus: deriveStatus(e, today) })),
  }));
}

// Replace one filter against a schedule entry: wraps the EXISTING replace action
// (filter-operations service.replace — unchanged), logs a ReplacementExecution,
// and increments qtyReplaced (COMPLETED when qty met). The route enforces the
// REPLACE_FILTER reauth before this runs, so the actual replacement stays gated.
const filterOps = new FilterOperationsService();

export async function executeReplacement(entryId: string, oldFilterId: string, remarks: string, ctx: RequestContext) {
  const entry = await prisma.replacementScheduleEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Replacement entry not found');

  // All-AHU-filters model (2026-06-15, per user): the task targets EVERY active
  // filter under the AHU and is complete only when none remain unreplaced. The
  // uploaded qty/qtyReplaced columns are kept for the web schedule trail but no
  // longer cap the task. `replace()` retires the old filter and creates a new
  // active one under the same AHU, so a filter counts as "replaced" once its id
  // appears as a ReplacementExecution.newFilterId for this entry.
  const before = await ahuReplacementProgress(entry.ahuId, entryId);
  if (before.total > 0 && before.remaining === 0) {
    throw new AppError(400, 'ALREADY_COMPLETE', 'Every filter in this AHU has already been replaced for this task');
  }

  // The actual retire-old + create-new (RFID carries over) — existing, unchanged action.
  const result = await filterOps.replace(ctx, oldFilterId, remarks);

  const today = todayUtcDateOnly();
  const ws = entry.windowStart.toISOString().slice(0, 10);
  const we = entry.windowEnd.toISOString().slice(0, 10);
  const isWithinWindow = today >= ws && today <= we;

  await prisma.replacementExecution.create({
    data: {
      entryId, oldFilterId, newFilterId: (result as any).newFilterId ?? null,
      performedBy: ctx.userSub, performedByName: ctx.userId, isWithinWindow,
      remarks: remarks ? stripHtml(remarks).trim() : null,
    },
  });

  // Recompute AHU progress now that the execution is recorded (old filter retired,
  // new one active + flagged). Completion is driven by remaining === 0, NOT qty.
  const after = await ahuReplacementProgress(entry.ahuId, entryId);
  const updated = await prisma.replacementScheduleEntry.update({
    where: { id: entryId },
    data: { qtyReplaced: { increment: 1 }, status: after.remaining === 0 ? 'COMPLETED' : 'IN_PROGRESS' },
  });

  return {
    success: true,
    newFilterId: (result as any).newFilterId,
    newFilterName: (result as any).newFilterName,
    total: after.total,
    replaced: after.total - after.remaining,
    qtyReplaced: updated.qtyReplaced,
    qtyRemaining: after.remaining,
    status: updated.status,
  };
}

export async function listDueEntries() {
  const today = todayUtcDateOnly();
  const todayDate = new Date(`${today}T00:00:00Z`);
  const entries = await prisma.replacementScheduleEntry.findMany({
    // Only APPROVED entries become due tasks (workflow ON gates this; when OFF,
    // entries default to APPROVED so behaviour is unchanged).
    where: { approvalStatus: 'APPROVED', windowStart: { lte: todayDate }, windowEnd: { gte: todayDate } },
    orderBy: [{ windowEnd: 'asc' }],
  });
  return entries
    .map((e) => ({ ...e, computedStatus: deriveStatus(e, today), qtyRemaining: Math.max(0, e.qty - e.qtyReplaced) }))
    .filter((e) => e.computedStatus === 'DUE' || e.computedStatus === 'IN_PROGRESS');
}

// ── All-AHU-filters task model (2026-06-15) ─────────────────────────────────
// A replacement task covers EVERY active filter under its AHU. A filter counts
// as replaced once its id is a ReplacementExecution.newFilterId for the entry
// (`replace()` retires the old filter and creates this new active one in place).

/** Active FILTER-kind instance ids under one or more AHUs (parentId === ahuId). */
async function activeFilterIdsByAhu(ahuIds: string[]): Promise<Map<string, string[]>> {
  const byAhu = new Map<string, string[]>();
  if (ahuIds.length === 0) return byAhu;
  const filterTemplates = await prisma.assetTemplate.findMany({
    where: { templateKind: 'FILTER' }, select: { id: true },
  });
  const templateIds = filterTemplates.map((t) => t.id);
  if (templateIds.length === 0) return byAhu;
  const filters = await prisma.assetInstance.findMany({
    where: { parentId: { in: ahuIds }, isActive: true, status: { not: 'Retired' }, templateId: { in: templateIds } },
    select: { id: true, parentId: true },
  });
  for (const f of filters) {
    if (!f.parentId) continue;
    const list = byAhu.get(f.parentId) ?? [];
    list.push(f.id);
    byAhu.set(f.parentId, list);
  }
  return byAhu;
}

/** Replacement progress for a single entry: total AHU filters vs. how many remain. */
async function ahuReplacementProgress(ahuId: string, entryId: string): Promise<{ total: number; remaining: number }> {
  const [byAhu, execs] = await Promise.all([
    activeFilterIdsByAhu([ahuId]),
    prisma.replacementExecution.findMany({ where: { entryId }, select: { newFilterId: true } }),
  ]);
  const ids = byAhu.get(ahuId) ?? [];
  const newIds = new Set(execs.map((x) => x.newFilterId).filter((x): x is string => !!x));
  const remaining = ids.filter((id) => !newIds.has(id)).length;
  return { total: ids.length, remaining };
}

/** Task status for the all-AHU-filters model (window + dynamic remaining count). */
function deriveTaskStatus(
  e: { windowStart: Date; windowEnd: Date },
  remaining: number,
  total: number,
  today: string,
): string {
  if (total > 0 && remaining === 0) return 'COMPLETED';
  const ws = e.windowStart.toISOString().slice(0, 10);
  const we = e.windowEnd.toISOString().slice(0, 10);
  if (today > we) return 'MISSED';
  if (today >= ws && today <= we) return remaining < total ? 'IN_PROGRESS' : 'DUE';
  return 'PENDING';
}

/**
 * Shared primitive: active AHU filter ids that have NOT yet been replaced
 * under a given entry. Used by both `blockedEntryFilterIds` (the gate) and
 * `listTaskEntries` (the "replaced X of Y" progress) so the two cannot drift.
 */
function unreplacedAhuFilterIds(ahuFilterIds: string[], replacedNewFilterIds: Set<string>): string[] {
  return ahuFilterIds.filter((id) => !replacedNewFilterIds.has(id));
}

/**
 * Blocked filter ids for ONE overdue entry: every active AHU filter that has not
 * yet been replaced under it. Returns [] when the entry is not overdue (MISSED),
 * so it composes cleanly with the sweep. Built on `unreplacedAhuFilterIds`, the
 * same primitive `listTaskEntries` uses, so the gate and the "replaced X of Y"
 * progress cannot drift.
 */
function blockedEntryFilterIds(
  entry: { windowStart: Date; windowEnd: Date },
  ahuFilterIds: string[],
  replacedNewFilterIds: Set<string>,
  today: string,
): string[] {
  const total = ahuFilterIds.length;
  const unreplaced = unreplacedAhuFilterIds(ahuFilterIds, replacedNewFilterIds);
  const remaining = unreplaced.length;
  if (deriveTaskStatus(entry, remaining, total, today) !== 'MISSED') return [];
  return unreplaced;
}

/**
 * The full set of filter ids blocked from STARTING a cleaning cycle because
 * their AHU has an overdue (MISSED) replacement entry and they are not yet
 * replaced. Union across all overdue entries.
 */
export async function blockedFilterIdsForCleaning(): Promise<Set<string>> {
  const today = todayUtcDateOnly();
  const entries = await prisma.replacementScheduleEntry.findMany({
    where: { approvalStatus: 'APPROVED' },
  });
  if (entries.length === 0) return new Set();
  const ahuIds = [...new Set(entries.map((e) => e.ahuId))];
  const entryIds = entries.map((e) => e.id);
  const [filtersByAhu, execs] = await Promise.all([
    activeFilterIdsByAhu(ahuIds),
    prisma.replacementExecution.findMany({ where: { entryId: { in: entryIds } }, select: { entryId: true, newFilterId: true } }),
  ]);
  const newIdsByEntry = new Map<string, Set<string>>();
  for (const x of execs) {
    if (!x.newFilterId) continue;
    const set = newIdsByEntry.get(x.entryId) ?? new Set<string>();
    set.add(x.newFilterId);
    newIdsByEntry.set(x.entryId, set);
  }
  const blocked = new Set<string>();
  for (const e of entries) {
    const ahuFilterIds = filtersByAhu.get(e.ahuId) ?? [];
    const replaced = newIdsByEntry.get(e.id) ?? new Set<string>();
    for (const id of blockedEntryFilterIds(e, ahuFilterIds, replaced, today)) blocked.add(id);
  }
  return blocked;
}

/**
 * Single-filter check for the start-cycle hot path — scoped to the filter's AHU
 * so it doesn't sweep every entry.
 */
export async function isFilterBlockedForCleaning(filterId: string): Promise<boolean> {
  const filter = await prisma.assetInstance.findUnique({ where: { id: filterId }, select: { parentId: true } });
  if (!filter?.parentId) return false;
  const today = todayUtcDateOnly();
  const entries = await prisma.replacementScheduleEntry.findMany({
    where: { approvalStatus: 'APPROVED', ahuId: filter.parentId },
  });
  if (entries.length === 0) return false;
  const [filtersByAhu, execs] = await Promise.all([
    activeFilterIdsByAhu([filter.parentId]),
    prisma.replacementExecution.findMany({ where: { entryId: { in: entries.map((e) => e.id) } }, select: { entryId: true, newFilterId: true } }),
  ]);
  const ahuFilterIds = filtersByAhu.get(filter.parentId) ?? [];
  const newIdsByEntry = new Map<string, Set<string>>();
  for (const x of execs) {
    if (!x.newFilterId) continue;
    const set = newIdsByEntry.get(x.entryId) ?? new Set<string>();
    set.add(x.newFilterId);
    newIdsByEntry.set(x.entryId, set);
  }
  for (const e of entries) {
    const replaced = newIdsByEntry.get(e.id) ?? new Set<string>();
    if (blockedEntryFilterIds(e, ahuFilterIds, replaced, today).includes(filterId)) return true;
  }
  return false;
}

/**
 * Tablet task list — ALL approved entries (every status), each carrying live
 * AHU-filter progress so the page can group into Pending / Completed and the
 * detail can show "remaining of total". Batched lookups (one filter query, one
 * execution query) keep it to O(1) round-trips regardless of entry count.
 * `qty`/`qtyRemaining` are aliased to total/remaining for the existing FE fields.
 */
export async function listTaskEntries() {
  const today = todayUtcDateOnly();
  const entries = await prisma.replacementScheduleEntry.findMany({
    where: { approvalStatus: 'APPROVED' },
    orderBy: [{ windowEnd: 'asc' }, { slNo: 'asc' }],
  });
  if (entries.length === 0) return [];

  const ahuIds = [...new Set(entries.map((e) => e.ahuId))];
  const entryIds = entries.map((e) => e.id);
  const [filtersByAhu, allExecs] = await Promise.all([
    activeFilterIdsByAhu(ahuIds),
    prisma.replacementExecution.findMany({
      where: { entryId: { in: entryIds } },
      select: { entryId: true, newFilterId: true },
    }),
  ]);
  const newIdsByEntry = new Map<string, Set<string>>();
  for (const x of allExecs) {
    if (!x.newFilterId) continue;
    const set = newIdsByEntry.get(x.entryId) ?? new Set<string>();
    set.add(x.newFilterId);
    newIdsByEntry.set(x.entryId, set);
  }

  return entries.map((e) => {
    const ahuFilterIds = filtersByAhu.get(e.ahuId) ?? [];
    const newIds = newIdsByEntry.get(e.id) ?? new Set<string>();
    const replacedNewFilterIds = [...newIds];
    const total = ahuFilterIds.length;
    const remaining = unreplacedAhuFilterIds(ahuFilterIds, newIds).length;
    const computedStatus = deriveTaskStatus(e, remaining, total, today);
    return {
      ...e,
      total,
      remaining,
      replaced: total - remaining,
      replacedNewFilterIds,
      computedStatus,
      // FE-compat aliases (mobile-wrapper reads qty / qtyRemaining).
      qty: total,
      qtyRemaining: remaining,
    };
  });
}
