/**
 * PM Schedule Routes — CRUD + CSV upload + execution tracking.
 */
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { PmScheduleService } from './pm-schedule.service.js';
import { sweepOverdueDeviations, listDeviations, acknowledgeDeviation } from './pm-deviations.js';
import { canSeeQnn, listQnn } from './qnn.js';
import { getPmWorkflowConfig } from './pm-workflow.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth, enforceReauthAlways } from '../../lib/reauth-check.js';
import { prisma } from '../../lib/prisma.js';

// Normalise one exceljs cell value to the shapes importSchedules() handles
// (Date | number | string). Rich-text / hyperlink / formula cells collapse to
// their text/result; null → '' (matches the old SheetJS defval:'').
function normalizeCell(v: any): any {
  if (v == null) return '';
  if (v instanceof Date) return v;            // importSchedules reads getUTC* off it
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t: any) => t.text ?? '').join('');
    if ('result' in v) return v.result ?? '';
    if (typeof v.text === 'string') return v.text;
    return String(v);
  }
  return v;
}

// Quoted-field-aware split of a single CSV line (RFC-4180 doubled-quote escaping).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Parse an uploaded CSV or XLSX buffer into header-keyed row objects.
// Replaces SheetJS (xlsx) — abandoned + CVE-2023-30533 / CVE-2024-22363, no
// registry fix (audit 2026-05-30). CSV stays string-valued so "YYYY-MM-DD"
// reaches importSchedules' string branch directly instead of being coerced to
// an Excel serial number (a strict improvement — kills the old TZ-drift footgun).
async function parseUploadRows(buffer: Buffer, isCsv: boolean): Promise<Record<string, any>[]> {
  if (isCsv) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) return [];
    const headers = splitCsvLine(lines[0]).map(h => h.trim());
    const rows: Record<string, any>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      const obj: Record<string, any> = {};
      headers.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
      rows.push(obj);
    }
    return rows;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any); // Node Buffer<ArrayBufferLike> vs exceljs's Buffer type
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headerCols: { col: number; name: string }[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const name = String(normalizeCell(cell.value)).trim();
    if (name) headerCols.push({ col, name });
  });
  const rows: Record<string, any>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, any> = {};
    for (const { col, name } of headerCols) obj[name] = normalizeCell(row.getCell(col).value);
    rows.push(obj);
  });
  return rows;
}

export default async function pmScheduleRoutes(app: FastifyInstance) {
  const service = new PmScheduleService();

  // ─── Quality Notifications (QNN) report ───
  // Visible to roles in config qnn-notifications.visibleRoles (+ SUPER_ADMIN),
  // same as QNN notifications. Powers the QNN report page (list + PDF/Excel).
  app.get('/qnn/visible', {
    schema: { tags: ['PM Schedules'], summary: 'May the current role view the QNN report?' },
  }, async (req) => ({ visible: await canSeeQnn(req.user?.role) }));

  app.get('/qnn', {
    schema: {
      tags: ['PM Schedules'],
      summary: 'List Quality Notifications (QNN)',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          from: { type: 'string' },
          to: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    if (!(await canSeeQnn(req.user?.role))) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Not allowed to view Quality Notifications.' });
    }
    return listQnn(req.query as any);
  });

  // ─── Runtime settings (public-read mirror) ───
  // The /api/config/dynamic/pm-schedule-settings endpoint is SUPER_ADMIN-gated
  // (requiredRole: 'SUPER_ADMIN'), so operators/admins get 401 and can never
  // read the "PM enabled" flag their page depends on. This endpoint exposes
  // only the runtime-relevant subset (just `enabled` for now) behind PM_READ.
  // Mirrors the cleaning-reasons / field-options dual-endpoint pattern.
  // Audit finding F-2 (High) — 2026-05-29.
  app.get('/settings', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Get PM module runtime settings',
      description:
        'Returns the runtime-relevant subset of pm-schedule-settings (just the enabled flag for now). Lower-priv mirror of the SUPER_ADMIN-only /api/config/dynamic/pm-schedule-settings.',
      response: {
        200: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
          },
          required: ['enabled'],
          additionalProperties: false,
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({
      where: { configKey: 'pm-schedule-settings' },
    });
    // configValue stored shape can be either `{ value: { enabled } }` (dynamic-routes
    // PUT spreads request body which has `{ value }`) or directly `{ enabled }`
    // (older seed format). Handle both.
    const stored = (row?.configValue ?? {}) as any;
    const inner = stored && typeof stored === 'object' && 'value' in stored ? stored.value : stored;
    return { enabled: (inner?.enabled ?? true) === true };
  });

  // Workflow config for the PM Schedules page — lets the FE gate the
  // review/approve buttons by the 3-step workflow state + the configured roles
  // (so it matches the backend assertPmRole gating exactly, instead of showing
  // an approve button that then 403s). PM_READ — role names are not sensitive.
  app.get('/workflow-config', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Get PM approval-workflow config (enabled flag + role names)',
      response: {
        200: {
          type: 'object',
          properties: {
            workflowEnabled: { type: 'boolean' },
            uploadRole: { type: 'string' },
            reviewRole: { type: 'string' },
            approvalRole: { type: 'string' },
          },
          required: ['workflowEnabled', 'uploadRole', 'reviewRole', 'approvalRole'],
          additionalProperties: false,
        },
      },
    },
  }, async () => {
    return getPmWorkflowConfig();
  });

  // ─── Template download ───
  app.get('/template.csv', {
    preHandler: [app.requireAnyPermission('PM_READ', 'PM_DOWNLOAD_TEMPLATE')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Download the PM schedule bulk-upload template (CSV)',
      response: { 200: { type: 'string' }, ...errorResponses },
    },
  }, async (_req, reply) => {
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="pm-schedule-template.csv"');
    return service.getTemplateCsv();
  });

  // ─── Bulk upload CSV/XLSX ───
  app.post('/upload', {
    preHandler: [app.requireAnyPermission('PM_CREATE', 'PM_UPLOAD')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Bulk upload PM schedule entries from a CSV or XLSX file',
      description:
        'Accepts multipart/form-data with a single `.csv` or `.xlsx` file. Expected columns: ahu_name, scheduled_date, tolerance_days (optional). Returns per-row imported/skipped counts.',
      consumes: ['multipart/form-data'],
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    // Audit 2026-05-09 fix: bulk PM upload was a high-trust mutation with
    // no password challenge. SUPER_ADMIN uploads auto-approve every row
    // (pm-import.ts:133), so a left-unlocked tablet could blast hundreds
    // of approved entries. Reauth gate runs BEFORE multipart consumption
    // for the same reason as the C2 audit fix on bulk-upload-filters.
    const { ok } = await enforceReauth('UPLOAD_PM_SCHEDULES', req, reply);
    if (!ok) return;
    try {
      const data = await req.file();
      if (!data) {
        return reply.code(400).send({ error: 'NO_FILE', message: 'No file uploaded' });
      }

      const filename = data.filename ?? 'upload';
      const lower = filename.toLowerCase();
      const isXlsx = lower.endsWith('.xlsx') || lower.endsWith('.xls');
      const isCsv = lower.endsWith('.csv');
      if (!isXlsx && !isCsv) {
        return reply.code(400).send({ error: 'INVALID_FILE_TYPE', message: 'Only .csv, .xls, and .xlsx files are accepted' });
      }

      // Buffer the file — xlsx lib needs the full content in memory
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      // Check truncation flag — @fastify/multipart silently TRUNCATES the stream
      // at the configured fileSize limit instead of throwing. The post-buffer
      // length check (buffer.length > 5 MB) is therefore always false because
      // the buffer is capped at exactly the limit. Checking data.file.truncated
      // is the only reliable way to detect oversized uploads.
      if ((data.file as any).truncated) {
        return reply.code(413).send({ error: 'FILE_TOO_LARGE', message: 'File exceeds 5 MB limit' });
      }

      // Parse CSV / XLSX into header-keyed rows. CSV cells stay strings so a
      // "YYYY-MM-DD" date reaches importSchedules' string branch as UTC midnight
      // (no locale re-parse / day-shift); XLSX date cells arrive as Date objects,
      // which importSchedules reads via getUTC*. See parseUploadRows above.
      let rawRows: Record<string, any>[];
      try {
        rawRows = await parseUploadRows(buffer, isCsv);
      } catch (e: any) {
        return reply.code(400).send({ error: 'PARSE_ERROR', message: `Failed to parse file: ${e.message ?? String(e)}` });
      }
      if (rawRows.length === 0) {
        return reply.code(400).send({ error: 'EMPTY_FILE', message: 'File contains no data rows' });
      }

      // Skip any row that looks like a comment line (starts with '#' in any column)
      const rows = rawRows.filter(r => {
        const first = Object.values(r)[0];
        return !(typeof first === 'string' && first.trim().startsWith('#'));
      });

      if (rows.length === 0) {
        return reply.code(400).send({ error: 'NO_ROWS', message: 'File has no data rows' });
      }

      const ctx = buildContext(req);
      const result = await service.importSchedules(ctx, rows);
      return result;
    } catch (err: any) {
      app.log.error({ err }, 'PM schedule upload failed');
      if (err.statusCode === 415 || err.message?.includes('multipart')) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'Request must be multipart/form-data with a file' });
      }
      return reply.code(500).send({ error: 'UPLOAD_FAILED', message: err.message ?? 'Failed to process upload' });
    }
  });

  // ─── AHU filter-set mode config ───
  // Per-AHU setting controlling which filters count toward PM completion.
  // Stored in AssetInstance.customAttributes.pmFilterSetMode.
  // Listed before the parametric /:entityId route.
  app.get('/ahu-configs', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'List AHUs with their current PM filter-set mode and filter counts',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.listAhuFilterSetConfigs(ctx);
  });

  app.put('/ahu-configs/:ahuId', {
    preHandler: [app.requirePermission('PM_UPDATE')],
    schema: {
      tags: ['PM Schedules'],
      summary: "Update an AHU's PM filter-set mode",
      params: { type: 'object', required: ['ahuId'], properties: { ahuId: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['BOTH', 'SET_A', 'SET_B', 'DISABLED'] },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
    // surfaces). Routed through the umbrella UPDATE_CONFIG_PAGE action.
    const { ok } = await enforceReauth('UPDATE_CONFIG_PAGE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { ahuId } = req.params as { ahuId: string };
    const { mode } = req.body as { mode: 'BOTH' | 'SET_A' | 'SET_B' | 'DISABLED' };
    return service.updateAhuFilterSetMode(ctx, ahuId, mode);
  });

  // ─── Entry-level approval workflow ───

  app.get('/entries', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'List schedule entries with approval status',
      querystring: {
        type: 'object',
        properties: {
          // Must list every real PmScheduleEntry.approvalStatus. PENDING_REVIEW
          // and PENDING_APPROVAL were missing, so the "To Review" / "To Approve"
          // tabs 400'd at the schema before the handler ran and rendered an empty
          // table with no error — while the header badge, counted from the ALL
          // tab, showed a non-zero count. A reviewer saw "nothing to review" with
          // real entries waiting.
          approvalStatus: { type: 'string', enum: ['ALL', 'PENDING', 'PENDING_REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] },
          year: { type: 'integer' },
          page: { type: 'integer', minimum: 1 },
          // Cap matches the service (pm-approval.listEntries: Math.min(limit, 2000)).
          // The list page sends limit=2000 to load a whole year with no pagination;
          // a stale 200 cap here rejected that request with 400 (page error).
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const query = req.query as any;
    return service.listEntries(ctx, query);
  });

  app.get('/entries/pending-counts', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Get counts of pending and rejected entries',
      response: { 200: { type: 'object', properties: { pending: { type: 'integer' }, rejected: { type: 'integer' } } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.pendingCounts(ctx);
  });

  // Export the year's PM schedule entries as .xlsx (full workflow trail).
  app.get('/entries/export.xlsx', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Export PM schedule entries as Excel',
      querystring: { type: 'object', properties: { year: { type: 'integer' } } },
    },
  }, async (req, reply) => {
    const ctx = buildContext(req);
    const year = Number((req.query as any).year) || new Date().getFullYear();
    const buf = await service.exportEntriesXlsx(ctx, year);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="pm-schedule-${year}.xlsx"`)
      .send(buf);
  });

  // Review step (3-step workflow). action='approve' sends an entry to approval;
  // action='reject' rejects it at the review stage. Gated by PM_REVIEW + the
  // configured reviewRole (enforced in the service).
  app.post('/entries/review', {
    preHandler: [app.requirePermission('PM_REVIEW')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Review selected schedule entries (approve to approval, or reject)',
      body: {
        type: 'object',
        required: ['entryIds', 'action'],
        properties: {
          entryIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
          action: { type: 'string', enum: ['approve', 'reject'] },
          remarks: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REVIEW_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { entryIds, action, remarks } = req.body as { entryIds: string[]; action: 'approve' | 'reject'; remarks?: string };
    return service.reviewEntries(ctx, entryIds, action, remarks);
  });

  app.post('/entries/approve', {
    preHandler: [app.requirePermission('PM_APPROVE')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Approve selected schedule entries',
      body: {
        type: 'object',
        required: ['entryIds'],
        properties: {
          entryIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
          comment: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('APPROVE_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { entryIds, comment } = req.body as { entryIds: string[]; comment?: string };
    return service.approveEntries(ctx, entryIds, comment);
  });

  app.post('/entries/reject', {
    preHandler: [app.requirePermission('PM_APPROVE')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Reject selected schedule entries with remarks',
      body: {
        type: 'object',
        required: ['entryIds', 'remarks'],
        properties: {
          entryIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
          remarks: { type: 'string', minLength: 3 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REJECT_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { entryIds, remarks } = req.body as { entryIds: string[]; remarks: string };
    return service.rejectEntries(ctx, entryIds, remarks);
  });

  app.post('/entries/:id/resubmit', {
    preHandler: [app.requireAnyPermission('PM_CREATE', 'PM_RESUBMIT')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Re-submit a rejected entry with corrected data',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['plannedDate'],
        properties: {
          plannedDate: { type: 'string' },
          toleranceDays: { type: 'integer', minimum: 0, maximum: 365 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    // Audit 2026-05-09 fix: resubmit flips REJECTED → PENDING. Approve and
    // reject already reauth — gate this for parity so all three lifecycle
    // transitions on a PM entry are challengeable.
    const { ok } = await enforceReauth('RESUBMIT_PM_ENTRY', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const body = req.body as { plannedDate: string; toleranceDays?: number };
    return service.resubmitEntry(ctx, id, body);
  });

  app.put('/entries/:id/edit', {
    preHandler: [app.requireAnyPermission('PM_UPDATE', 'PM_EDIT_ENTRY')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Edit an approved entry (creates pending change for QA review)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['plannedDate'],
        properties: {
          plannedDate: { type: 'string' },
          toleranceDays: { type: 'integer', minimum: 0, maximum: 365 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('EDIT_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const body = req.body as { plannedDate: string; toleranceDays?: number };
    return service.editApprovedEntry(ctx, id, body);
  });

  // Reviewer modifies a PENDING_REVIEW entry in place (stays in review). Gated by
  // PM_REVIEW + the configured reviewRole; REVIEW_PM_SCHEDULE reauth.
  app.put('/entries/:id/review-edit', {
    preHandler: [app.requirePermission('PM_REVIEW')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Reviewer modifies a schedule entry awaiting review',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['plannedDate'],
        properties: {
          plannedDate: { type: 'string' },
          toleranceDays: { type: 'integer', minimum: 0, maximum: 365 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REVIEW_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const body = req.body as { plannedDate: string; toleranceDays?: number };
    return service.modifyReviewEntry(ctx, id, body);
  });

  // ─── Overdue deviations ───
  // Literal /deviations* paths — registered before the parametric /:entityId.
  app.post('/deviations/sweep', {
    preHandler: [app.requirePermission('PM_UPDATE')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Run the overdue-deviation sweep now (open new + close resolved)',
      description: 'Manual trigger for the same idempotent sweep the daily cron runs. Opens deviations for newly-overdue AHU cleaning tasks and closes those whose filters have since been PM-cleaned. `blocked` counts re-overdue tasks whose deviation could not be recorded because a CLOSED deviation already occupies the task — each one is audited and notified, and needs manual review.',
      response: { 200: { type: 'object', properties: { opened: { type: 'integer' }, closed: { type: 'integer' }, blocked: { type: 'integer' } }, additionalProperties: false }, ...errorResponses },
    },
  }, async (req) => {
    return sweepOverdueDeviations(buildContext(req));
  });

  app.get('/deviations', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'List overdue deviations (full audit record)',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ALL', 'OPEN', 'ACKNOWLEDGED', 'CLOSED'] },
          ahuId: { type: 'string', format: 'uuid' },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    return listDeviations(req.query as any);
  });

  app.post('/deviations/:id/acknowledge', {
    // Audit #7 (2026-07-04): acknowledging is the precursor to COMPLETING an overdue
    // task, and completion requires PM_EXECUTE (execution-routes.ts). Gate the
    // (state-changing) acknowledge on PM_EXECUTE too, not the read perm PM_READ — a
    // read-only role can't complete the task, so it has no reason to acknowledge it.
    preHandler: [app.requirePermission('PM_EXECUTE')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Acknowledge an overdue task before completing it (password re-auth)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    // ALWAYS require the password — confirming an overdue task before completion
    // is a compliance gate, not an admin-toggleable reauth policy.
    const { ok } = await enforceReauthAlways('ACKNOWLEDGE_PM_OVERDUE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    return acknowledgeDeviation(buildContext(req), id);
  });

  // ─── My Tasks: list due entries ───
  // Registered BEFORE the parametric /:entityId route so /due is matched as a
  // literal path rather than interpreted as an entityId.
  app.get('/due', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'List PM schedule entries currently in their tolerance window',
      description:
        'Returns all active PM entries whose window contains `now`, plus entries whose window closed in the last 30 days and whose filters are not fully cleaned (overdue). Grouped by AHU, with each AHU\'s child filters and per-filter status. When `from`/`to` are supplied, returns entries whose planned date falls in that period instead (My Tasks time-period view).',
      querystring: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { from, to } = req.query as { from?: string; to?: string };
    return service.getDueTasks(ctx, { from, to });
  });

  app.get('/:entityId', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Get active PM schedule for an entity',
      params: { type: 'object', required: ['entityId'], properties: { entityId: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', properties: { year: { type: 'integer' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { entityId } = req.params as { entityId: string };
    const { year } = req.query as { year?: number };
    return service.getByEntity(ctx, entityId, year);
  });

  app.post('/', {
    preHandler: [app.requirePermission('PM_CREATE')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Create PM schedule',
      body: {
        type: 'object',
        required: ['entityId', 'year', 'entries'],
        properties: {
          entityId: { type: 'string', format: 'uuid' },
          year: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              required: ['month', 'plannedDate'],
              properties: {
                month: { type: 'integer', minimum: 1, maximum: 12 },
                plannedDate: { type: 'string', format: 'date' },
                toleranceDays: { type: 'integer', minimum: 0 },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
      response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const result = await service.create(ctx, req.body);
    return reply.code(201).send(result);
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('PM_UPDATE')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Update PM schedule (new version)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['entries'],
        properties: {
          entries: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['month', 'plannedDate'],
              properties: {
                month: { type: 'integer', minimum: 1, maximum: 12 },
                plannedDate: { type: 'string', format: 'date' },
                toleranceDays: { type: 'integer', minimum: 0 },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.update(ctx, id, req.body);
  });

  app.delete('/:id', {
    preHandler: [app.requireSuperAdmin()], // M4 (2026-06-30): delete is SUPER_ADMIN-only (matches UI); was PM_DELETE
    schema: {
      tags: ['PM Schedules'],
      summary: 'Delete PM schedule',
      description: 'Deletes a PM schedule and its entries. Fails if executions are in progress.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_PM_SCHEDULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.delete(ctx, id);
  });

  app.get('/:entityId/history', {
    preHandler: [app.requirePermission('PM_READ')],
    schema: {
      tags: ['PM Schedules'],
      summary: 'Get PM schedule version history',
      params: { type: 'object', required: ['entityId'], properties: { entityId: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { entityId } = req.params as { entityId: string };
    return service.getHistory(ctx, entityId);
  });
}
