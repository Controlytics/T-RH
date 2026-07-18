// Builds the Replacement Schedule upload .xlsx template with a live AHU-name
// data-validation dropdown. Mirrors filter-upload-template.service.ts (exceljs,
// hidden _lists sheet for dropdown ranges). Columns match the agreed template:
// S.No, AHU Name, Filter Micron, Filter Size, Qty, Schedule Date, Tolerance Days.
import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';

const VALIDATION_ROWS = 1000;

interface TemplateColumn {
  key: string;
  header: string;
  options?: string[];
  note?: string;
}

export async function buildReplacementScheduleTemplate(): Promise<Buffer> {
  // Live AHU names so the operator picks an existing AHU (resolution is by name).
  const ahus = await prisma.ahu.findMany({
    where: { isActive: true },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  const ahuNames = ahus.map((a) => a.name);

  const columns: TemplateColumn[] = [
    { key: 'slNo', header: 'S.No', note: 'Optional row number.' },
    { key: 'ahuName', header: 'AHU Name', options: ahuNames, note: 'Must match an existing AHU.' },
    { key: 'filterMicron', header: 'Filter Micron', note: 'Micron spec, e.g. 0.3' },
    { key: 'filterSize', header: 'Filter Dimensions', note: 'Physical size, e.g. 610x610x292mm' },
    { key: 'qty', header: 'Qty', note: 'Number of filters to replace (integer >= 1).' },
    { key: 'scheduleDate', header: 'Schedule Date', note: 'YYYY-MM-DD. Must not be in the past.' },
    { key: 'toleranceDays', header: 'Tolerance Days', note: 'Optional. +/- days window. Blank = configured default.' },
  ];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DigiLog';
  const ws = wb.addWorksheet('Replacements');

  const lists = wb.addWorksheet('_lists');
  lists.state = 'veryHidden';

  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 4) }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E7490' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  let listColIdx = 1;
  columns.forEach((col, i) => {
    const colNumber = i + 1;
    if (col.note) ws.getCell(1, colNumber).note = col.note;

    if (col.options && col.options.length > 0) {
      col.options.forEach((opt, r) => { lists.getCell(r + 1, listColIdx).value = opt; });
      const letter = lists.getColumn(listColIdx).letter;
      const ref = `_lists!$${letter}$1:$${letter}$${col.options.length}`;
      listColIdx++;

      for (let row = 2; row <= VALIDATION_ROWS + 1; row++) {
        ws.getCell(row, colNumber).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [ref],
          showErrorMessage: true,
          errorStyle: 'error',
          errorTitle: 'Invalid value',
          error: `Choose a value from the ${col.header} dropdown (reflects the current master data).`,
        };
      }
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
