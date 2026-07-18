import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { buildFilterUploadTemplate } from '../filter-upload-template.service.js';
import { prisma } from '../../../../lib/prisma.js';

vi.mock('../../../../lib/prisma.js', () => ({ prisma: { systemConfig: { findUnique: vi.fn() } } }));

const OPTS = { ahuType: ['Process', 'Non Process'], filterType: ['HEPA', 'PRE'], micronSize: ['5', '10'], filterSize: ['610×610×292mm', '24×24×12in'] };
beforeEach(() => { (prisma.systemConfig.findUnique as any).mockResolvedValue({ configValue: { value: OPTS } }); });

async function loadBack() {
  const buf = await buildFilterUploadTemplate();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

describe('buildFilterUploadTemplate', () => {
  it('produces a Filters sheet with the expected concrete header columns (no templateId/attributes)', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('Filters');
    expect(ws).toBeDefined();
    const headers = (ws!.getRow(1).values as any[]).slice(1);
    expect(headers).toEqual(['name', 'filterSet', 'ahuType', 'filterType', 'micronSize', 'Filter Dimensions', 'lastCleaningDate']);
  });

  it('leaves the filterSize column as free text (no data-validation dropdown)', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('Filters')!;
    // Columns: 1 name, 2 filterSet, 3 ahuType, 4 filterType, 5 micronSize, 6 filterSize
    expect(ws.getCell(2, 6).dataValidation).toBeUndefined();
  });

  it('applies a list data-validation dropdown on filterSet referencing the hidden _lists sheet', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('Filters')!;
    const cell = ws.getCell(2, 2); // row 2, filterSet column
    expect(cell.dataValidation?.type).toBe('list');
    expect(cell.dataValidation?.formulae?.[0]).toContain('_lists');
    const lists = wb.getWorksheet('_lists')!;
    expect([lists.getCell(1, 1).value, lists.getCell(2, 1).value]).toEqual(['A', 'B']);
  });

  it('reflects LIVE master data — ahuType dropdown uses the config values, not hardcoded', async () => {
    const wb = await loadBack();
    const lists = wb.getWorksheet('_lists')!;
    expect([lists.getCell(1, 2).value, lists.getCell(2, 2).value]).toEqual(['Process', 'Non Process']);
    const ws = wb.getWorksheet('Filters')!;
    expect(ws.getCell(2, 3).dataValidation?.type).toBe('list'); // ahuType is column 3
  });
});
