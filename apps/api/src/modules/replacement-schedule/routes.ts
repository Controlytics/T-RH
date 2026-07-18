import type { FastifyInstance } from 'fastify';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildReplacementScheduleTemplate } from './template.service.js';
import { processUpload, listSchedules, listDueEntries, listTaskEntries, executeReplacement, blockedFilterIdsForCleaning } from './service.js';
import * as wf from './workflow.js';
import { exportEntriesXlsx } from './export.js';

// Registered at prefix /api/replacement-schedules (see app.ts).
// Upload is gated by REPLACEMENT_SCHEDULE_UPLOAD — the permission SUPER_ADMIN
// grants to whichever role may upload. Reads gated by REPLACEMENT_SCHEDULE_VIEW.
// NOTE: reauth on upload is intentionally deferred to the polish phase (the
// create is permission-gated + audited for now).
export default async function replacementScheduleRoutes(app: FastifyInstance) {
  // Helper: read a single multipart file buffer + optional fields.
  async function readUpload(req: any): Promise<{ buffer: Buffer | null; fileName?: string }> {
    let buffer: Buffer | null = null;
    let fileName: string | undefined;
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        fileName = part.filename;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk);
        buffer = Buffer.concat(chunks);
      }
    }
    return { buffer, fileName };
  }

  // Download the upload template (.xlsx) with a live AHU-name dropdown.
  app.get('/template.xlsx', {
    preHandler: [app.requireAnyPermission('REPLACEMENT_SCHEDULE_VIEW', 'REPLACEMENT_SCHEDULE_UPLOAD')],
    schema: {
      tags: ['Replacement Schedule'],
      summary: 'Download the replacement-schedule upload template',
      description: 'Columns: S.No, AHU Name (live dropdown), Filter Micron, Filter Size, Qty, Schedule Date, Tolerance Days.',
    },
  }, async (_req, reply) => {
    const buf = await buildReplacementScheduleTemplate();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="replacement-schedule-template.xlsx"')
      .send(buf);
  });

  const uploadResultSchema = {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' },
      created: { type: 'integer' },
      failed: { type: 'integer' },
      scheduleId: { type: 'string' },
      results: { type: 'array', items: { type: 'object', additionalProperties: true } },
      rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  };

  // Dry-run: parse + validate, return per-row errors + parsed rows (no DB write).
  app.post('/validate', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_UPLOAD')],
    schema: { tags: ['Replacement Schedule'], summary: 'Validate an upload (dry-run)', consumes: ['multipart/form-data'], response: { 200: uploadResultSchema, ...errorResponses } },
  }, async (req, reply) => {
    const { buffer, fileName } = await readUpload(req);
    if (!buffer || buffer.length === 0) return reply.code(400).send({ error: 'VALIDATION', message: 'A file is required' });
    const result = await processUpload(buffer, fileName, buildContext(req), { validateOnly: true });
    return { success: true, ...result };
  });

  // Create a schedule from the uploaded file (all-or-nothing — rejects if any row invalid).
  app.post('/', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_UPLOAD')],
    schema: { tags: ['Replacement Schedule'], summary: 'Upload a replacement schedule', consumes: ['multipart/form-data'], response: { 200: uploadResultSchema, ...errorResponses } },
  }, async (req, reply) => {
    const { buffer, fileName } = await readUpload(req);
    if (!buffer || buffer.length === 0) return reply.code(400).send({ error: 'VALIDATION', message: 'A file is required' });
    const result = await processUpload(buffer, fileName, buildContext(req), { validateOnly: false });
    return { success: result.failed === 0, ...result };
  });

  // List uploaded schedules + entries (with computed status).
  app.get('/', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_VIEW')],
    schema: { tags: ['Replacement Schedule'], summary: 'List replacement schedules', response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } }, ...errorResponses } },
  }, async () => {
    const data = await listSchedules();
    return { data };
  });

  // Export the schedule as .xlsx (full upload/review/approve trail).
  app.get('/export.xlsx', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_VIEW')],
    schema: { tags: ['Replacement Schedule'], summary: 'Export replacement schedule as Excel' },
  }, async (_req, reply) => {
    const buf = await exportEntriesXlsx();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="replacement-schedule.xlsx"')
      .send(buf);
  });

  // ─── 3-step workflow (reuses the PM workflow config) ───
  app.post('/entries/review', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_REVIEW')],
    schema: { tags: ['Replacement Schedule'], summary: 'Review entries (approve→approval or reject)', body: { type: 'object', required: ['entryIds', 'action'], properties: { entryIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 }, action: { type: 'string', enum: ['approve', 'reject'] }, remarks: { type: 'string' } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REVIEW_REPLACEMENT_SCHEDULE', req, reply); if (!ok) return;
    const { entryIds, action, remarks } = req.body as { entryIds: string[]; action: 'approve' | 'reject'; remarks?: string };
    return wf.reviewEntries(buildContext(req), entryIds, action, remarks);
  });

  app.post('/entries/approve', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_APPROVE')],
    schema: { tags: ['Replacement Schedule'], summary: 'Approve entries', body: { type: 'object', required: ['entryIds'], properties: { entryIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 }, comment: { type: 'string' } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('APPROVE_REPLACEMENT_SCHEDULE', req, reply); if (!ok) return;
    const { entryIds, comment } = req.body as { entryIds: string[]; comment?: string };
    return wf.approveEntries(buildContext(req), entryIds, comment);
  });

  app.post('/entries/reject', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_APPROVE')],
    schema: { tags: ['Replacement Schedule'], summary: 'Reject entries at approval', body: { type: 'object', required: ['entryIds', 'remarks'], properties: { entryIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 }, remarks: { type: 'string', minLength: 3 } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REJECT_REPLACEMENT_SCHEDULE', req, reply); if (!ok) return;
    const { entryIds, remarks } = req.body as { entryIds: string[]; remarks: string };
    return wf.rejectEntries(buildContext(req), entryIds, remarks);
  });

  app.post('/entries/:id/resubmit', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_UPLOAD')],
    schema: { tags: ['Replacement Schedule'], summary: 'Re-submit a rejected entry', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', required: ['scheduleDate'], properties: { scheduleDate: { type: 'string' }, toleranceDays: { type: 'integer', minimum: 0, maximum: 365 }, qty: { type: 'integer', minimum: 1 } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REVIEW_REPLACEMENT_SCHEDULE', req, reply); if (!ok) return;
    const { id } = req.params as { id: string };
    return wf.resubmitEntry(buildContext(req), id, req.body as any);
  });

  app.put('/entries/:id/review-edit', {
    preHandler: [app.requirePermission('REPLACEMENT_SCHEDULE_REVIEW')],
    schema: { tags: ['Replacement Schedule'], summary: 'Reviewer modifies an entry awaiting review', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', required: ['scheduleDate'], properties: { scheduleDate: { type: 'string' }, toleranceDays: { type: 'integer', minimum: 0, maximum: 365 }, qty: { type: 'integer', minimum: 1 } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REVIEW_REPLACEMENT_SCHEDULE', req, reply); if (!ok) return;
    const { id } = req.params as { id: string };
    return wf.modifyReviewEntry(buildContext(req), id, req.body as any);
  });

  // Entries whose window is active right now (drives tablet tasks + dashboard).
  // 2026-06-04 (per user): replacement TASKS are open to any authenticated role
  // on the tablet — no permission rule. (Web VIEW/UPLOAD of the schedule above
  // stays role-gated; only these two task endpoints are opened.) Auth is still
  // enforced by the global onRequest hook.
  app.get('/due', {
    schema: { tags: ['Replacement Schedule'], summary: 'List currently-due replacement entries (any role)', response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } }, ...errorResponses } },
  }, async () => {
    const data = await listDueEntries();
    return { data };
  });

  // ALL approved entries (every status) with live AHU-filter progress — drives
  // the tablet Replacement Tasks page (Pending / Completed tabs + full details).
  // Same open-to-any-role auth as /due (2026-06-15): operators run scheduled
  // replacements from the tablet; the execute still requires REPLACE_FILTER reauth.
  app.get('/tasks', {
    schema: { tags: ['Replacement Schedule'], summary: 'List all replacement task entries with AHU progress (any role)', response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } }, ...errorResponses } },
  }, async () => {
    const data = await listTaskEntries();
    return { data };
  });

  // Blocked-filter set for the cleaning gate (2026-07-16). Any authenticated role,
  // same posture as /due and /tasks — operators need it to know which filters they
  // may start cleaning. Returns only filter ids.
  app.get('/blocked-filters', {
    schema: {
      tags: ['Replacement Schedule'],
      summary: 'Filter ids blocked from starting a cleaning cycle (overdue AHU replacement)',
      response: { 200: { type: 'object', properties: { filterIds: { type: 'array', items: { type: 'string' } } } }, ...errorResponses },
    },
  }, async () => {
    const set = await blockedFilterIdsForCleaning();
    return { filterIds: [...set] };
  });

  // Replace one filter against a due entry (from the tablet task). Requires
  // FILTER_REPLACE — the same gate as the direct replace endpoint
  // (filter-operations/routes.ts, M2 2026-06-30). The prior "open to any
  // authenticated role" relied solely on REPLACE_FILTER reauth, which is
  // authorization-inert when the action isn't enabled in the action-reauth
  // config (the default) — a broken-access-control gap (audit 2026-07-04 #6).
  // Reauth stays on top for the 21 CFR electronic signature; grant FILTER_REPLACE
  // via the "Replace Filters" role toggle to authorize a role to run replacements.
  app.post('/entries/:id/execute', {
    preHandler: [app.requirePermission('FILTER_REPLACE')],
    schema: {
      tags: ['Replacement Schedule'],
      summary: 'Replace one filter against a schedule entry',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['oldFilterId'],
        properties: { oldFilterId: { type: 'string', format: 'uuid' }, remarks: { type: 'string' } },
        additionalProperties: false,
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REPLACE_FILTER', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const { oldFilterId, remarks } = req.body as { oldFilterId: string; remarks?: string };
    return executeReplacement(id, oldFilterId, remarks ?? '', buildContext(req));
  });
}
