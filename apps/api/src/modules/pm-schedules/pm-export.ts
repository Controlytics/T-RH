/**
 * PM Schedule export → .xlsx. One row per schedule entry with the full workflow
 * trail (uploaded / reviewed / approved + ids + timestamps) so an inspector can
 * see who did what. PDF export is built client-side via pdf-report.ts.
 */
import ExcelJS from 'exceljs';
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { checkPmEnabled } from './pm-shared.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending', PENDING_REVIEW: 'To Review', PENDING_APPROVAL: 'To Approve',
  APPROVED: 'Approved', REJECTED: 'Rejected',
};
const fmt = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const fmtDT = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');

export async function exportEntriesXlsx(_ctx: RequestContext, year: number): Promise<Buffer> {
  await checkPmEnabled();

  const entries = await prisma.pmScheduleEntry.findMany({
    where: { schedule: { status: 'ACTIVE', year } },
    include: { schedule: true },
    orderBy: [{ plannedDate: 'asc' }],
    take: 5000,
  });
  const entityIds = [...new Set(entries.map((e: any) => e.schedule?.entityId).filter(Boolean))] as string[];
  const ahus = entityIds.length > 0
    ? await prisma.assetInstance.findMany({ where: { id: { in: entityIds } }, select: { id: true, name: true } })
    : [];
  const ahuMap = new Map(ahus.map(a => [a.id, a.name]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DigiLog';
  const ws = wb.addWorksheet(`PM Schedule ${year}`);
  ws.columns = [
    { header: 'S.No', key: 'sno', width: 6 },
    { header: 'AHU', key: 'ahu', width: 26 },
    { header: 'Month', key: 'month', width: 8 },
    { header: 'Planned Date', key: 'planned', width: 14 },
    { header: 'Tolerance (days)', key: 'tol', width: 14 },
    { header: 'Window Start', key: 'ws', width: 14 },
    { header: 'Window End', key: 'we', width: 14 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Uploaded By', key: 'uploadedBy', width: 20 },
    { header: 'Reviewed By', key: 'reviewedBy', width: 20 },
    { header: 'Reviewed At', key: 'reviewedAt', width: 18 },
    { header: 'Approved By', key: 'approvedBy', width: 20 },
    { header: 'Approved At', key: 'approvedAt', width: 18 },
    { header: 'Rejected By', key: 'rejectedBy', width: 20 },
    { header: 'Rejected At', key: 'rejectedAt', width: 18 },
    { header: 'Reject Stage', key: 'rejStage', width: 12 },
    { header: 'Remarks', key: 'remarks', width: 40 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  entries.forEach((e: any, i: number) => {
    ws.addRow({
      sno: i + 1,
      ahu: ahuMap.get(e.schedule?.entityId) ?? '?',
      month: MONTHS[(e.month ?? 1) - 1] ?? e.month,
      planned: fmt(e.plannedDate),
      tol: e.toleranceDays,
      ws: fmt(e.windowStart),
      we: fmt(e.windowEnd),
      status: STATUS_LABEL[e.approvalStatus] ?? e.approvalStatus,
      uploadedBy: e.submittedByName ?? '',
      reviewedBy: e.reviewedByName ?? '',
      reviewedAt: fmtDT(e.reviewedAt),
      approvedBy: e.approvedByName ?? '',
      approvedAt: fmtDT(e.approvedAt),
      rejectedBy: e.rejectedByName ?? '',
      rejectedAt: fmtDT(e.rejectedAt),
      rejStage: e.rejectionStage ?? '',
      remarks: e.approvalRemarks ?? e.reviewRemarks ?? '',
    });
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
