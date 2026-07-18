/** Replacement Schedule export → .xlsx with the upload/review/approve trail. */
import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending', PENDING_REVIEW: 'To Review', PENDING_APPROVAL: 'To Approve',
  APPROVED: 'Approved', REJECTED: 'Rejected',
};
const fmt = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const fmtDT = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');

export async function exportEntriesXlsx(): Promise<Buffer> {
  const entries = await prisma.replacementScheduleEntry.findMany({
    include: { schedule: true },
    orderBy: [{ scheduleDate: 'asc' }, { slNo: 'asc' }],
    take: 5000,
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DigiLog';
  const ws = wb.addWorksheet('Replacement Schedule');
  ws.columns = [
    { header: 'S.No', key: 'sno', width: 6 },
    { header: 'AHU', key: 'ahu', width: 24 },
    { header: 'Micron', key: 'micron', width: 12 },
    { header: 'Filter Dimensions', key: 'size', width: 18 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Replaced', key: 'replaced', width: 9 },
    { header: 'Schedule Date', key: 'date', width: 14 },
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
    { header: 'Reject Stage', key: 'rejStage', width: 12 },
    { header: 'Remarks', key: 'remarks', width: 40 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  entries.forEach((e: any, i: number) => {
    ws.addRow({
      sno: e.slNo ?? i + 1,
      ahu: e.ahuName ?? '',
      micron: e.filterMicron ?? '',
      size: e.filterSize ?? '',
      qty: e.qty,
      replaced: e.qtyReplaced,
      date: fmt(e.scheduleDate),
      tol: e.toleranceDays,
      ws: fmt(e.windowStart),
      we: fmt(e.windowEnd),
      status: STATUS_LABEL[e.approvalStatus] ?? e.approvalStatus,
      uploadedBy: e.submittedByName ?? e.schedule?.uploadedByName ?? '',
      reviewedBy: e.reviewedByName ?? '',
      reviewedAt: fmtDT(e.reviewedAt),
      approvedBy: e.approvedByName ?? '',
      approvedAt: fmtDT(e.approvedAt),
      rejectedBy: e.rejectedByName ?? '',
      rejStage: e.rejectionStage ?? '',
      remarks: e.approvalRemarks ?? e.reviewRemarks ?? '',
    });
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
