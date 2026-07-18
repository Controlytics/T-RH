export interface ExcelExportOptions {
  /** File name WITHOUT the .xlsx extension. */
  filename: string;
  sheetName?: string;
  head: string[];
  rows: (string | number | null | undefined)[][];
}

/**
 * Export a single-sheet .xlsx from a header row + body rows (the same
 * `head` / `body` shape pages already build for their PDF table). Column
 * widths auto-fit to content. Downloads immediately.
 *
 * Uses `exceljs` via a dynamic import so the (large) workbook writer only
 * loads as its own chunk when a user actually clicks Export — no cost to the
 * initial bundle. Replaces SheetJS `xlsx@0.18.5`, which carries an unpatchable
 * prototype-pollution + ReDoS advisory on the npm registry (SheetJS ships fixed
 * builds only via its own CDN, so `npm audit fix` cannot resolve it).
 */
export async function exportToExcel({ filename, sheetName = 'Report', head, rows }: ExcelExportOptions): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));

  // Column widths auto-fit from the longest cell in each column (clamped),
  // matching the previous SheetJS behavior. Set before adding rows.
  ws.columns = head.map((h, i) => {
    const longest = Math.max(
      String(h).length,
      ...rows.map((r) => String(r[i] ?? '').length),
    );
    return { width: Math.min(Math.max(longest + 2, 8), 60) };
  });

  ws.addRow(head);
  for (const r of rows) {
    ws.addRow(r.map((c) => (c == null ? '' : (typeof c === 'number' ? c : String(c)))));
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
