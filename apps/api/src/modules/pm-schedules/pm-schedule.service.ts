/**
 * PM Schedule Service — orchestrator façade.
 *
 * Public surface (consumed by routes.ts and execution-routes.ts):
 *   • `PmScheduleService` class with the same method names as before
 *
 * Behaviour for each method lives in a focused sibling file:
 *   • pm-shared.ts          — `checkPmEnabled` guard
 *   • pm-types.ts           — DTOs for the My Tasks page
 *   • pm-schedule-crud.ts   — getByEntity / create / update / delete / getHistory
 *   • pm-executions.ts      — createExecution (H3 cleanup 2026-05-04 removed
 *                             the unused updateExecution helper)
 *   • pm-due-tasks.ts       — getDueTasks (My Tasks page)
 *   • pm-import.ts          — importSchedules + getTemplateCsv (CSV/XLSX upload)
 *   • pm-ahu-config.ts      — listAhuFilterSetConfigs / updateAhuFilterSetMode
 *   • pm-approval.ts        — listEntries / approve / reject / resubmit / editApproved / pendingCounts
 *
 * The service class is intentionally a thin delegator — every method here is
 * a single-line passthrough to the corresponding helper. No behaviour lives
 * in this file. This keeps the existing import path (`./pm-schedule.service.js`)
 * stable for callers while letting each concern grow independently.
 */
import type { RequestContext } from '../../types/context.js';

import * as crud from './pm-schedule-crud.js';
import * as executions from './pm-executions.js';
import * as dueTasks from './pm-due-tasks.js';
import * as importer from './pm-import.js';
import * as ahuConfig from './pm-ahu-config.js';
import * as approval from './pm-approval.js';
import * as exporter from './pm-export.js';

export class PmScheduleService {
  // ─── PM Schedule CRUD ─────────────────────────────────────
  getByEntity(ctx: RequestContext, entityId: string, year?: number) {
    return crud.getByEntity(ctx, entityId, year);
  }

  create(ctx: RequestContext, data: any) {
    return crud.create(ctx, data);
  }

  update(ctx: RequestContext, id: string, data: any) {
    return crud.update(ctx, id, data);
  }

  delete(ctx: RequestContext, id: string) {
    return crud.remove(ctx, id);
  }

  getHistory(ctx: RequestContext, entityId: string) {
    return crud.getHistory(ctx, entityId);
  }

  // ─── Executions ───────────────────────────────────────────
  createExecution(ctx: RequestContext, data: any) {
    return executions.createExecution(ctx, data);
  }

  // ─── My Tasks (due now / overdue) ─────────────────────────
  getDueTasks(ctx: RequestContext, opts?: { from?: string; to?: string }) {
    return dueTasks.getDueTasks(ctx, opts);
  }

  // ─── CSV / XLSX bulk import ───────────────────────────────
  importSchedules(ctx: RequestContext, rows: Array<Record<string, any>>) {
    return importer.importSchedules(ctx, rows);
  }

  getTemplateCsv(): string {
    return importer.getTemplateCsv();
  }

  // ─── AHU filter-set mode config ──────────────────────────
  listAhuFilterSetConfigs(ctx: RequestContext) {
    return ahuConfig.listAhuFilterSetConfigs(ctx);
  }

  updateAhuFilterSetMode(ctx: RequestContext, ahuId: string, mode: 'BOTH' | 'SET_A' | 'SET_B' | 'DISABLED') {
    return ahuConfig.updateAhuFilterSetMode(ctx, ahuId, mode);
  }

  // ─── QA Approval Workflow ────────────────────────────────
  listEntries(ctx: RequestContext, query: { approvalStatus?: string; year?: number; page?: number; limit?: number }) {
    return approval.listEntries(ctx, query);
  }

  reviewEntries(ctx: RequestContext, entryIds: string[], action: 'approve' | 'reject', remarks?: string) {
    return approval.reviewEntries(ctx, entryIds, action, remarks);
  }

  modifyReviewEntry(ctx: RequestContext, entryId: string, data: { plannedDate: string; toleranceDays?: number }) {
    return approval.modifyReviewEntry(ctx, entryId, data);
  }

  approveEntries(ctx: RequestContext, entryIds: string[], comment?: string) {
    return approval.approveEntries(ctx, entryIds, comment);
  }

  rejectEntries(ctx: RequestContext, entryIds: string[], remarks: string) {
    return approval.rejectEntries(ctx, entryIds, remarks);
  }

  resubmitEntry(ctx: RequestContext, entryId: string, data: { plannedDate: string; toleranceDays?: number }) {
    return approval.resubmitEntry(ctx, entryId, data);
  }

  editApprovedEntry(ctx: RequestContext, entryId: string, data: { plannedDate: string; toleranceDays?: number }) {
    return approval.editApprovedEntry(ctx, entryId, data);
  }

  pendingCounts(ctx: RequestContext) {
    return approval.pendingCounts(ctx);
  }

  exportEntriesXlsx(ctx: RequestContext, year: number) {
    return exporter.exportEntriesXlsx(ctx, year);
  }
}
