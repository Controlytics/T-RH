// Bulk filter upload — A-01 Slice 2.
//
// Parses an .xlsx workbook (the template produced by
// filter-upload-template.service.ts) and creates one filter per data row using
// the SAME typed path single-create uses: the FILTER template is resolved
// internally, field-option values (ahuType/filterType/micronSize) are validated
// against the live filter-field-options config (NOT a template attributeSchema),
// and each row is created via instanceService.create (which writes the
// FilterDetails sidecar + fires the mirror trigger). No templateId / generic
// attributes are accepted from the file. Invalid cells are rejected with
// row + column + value + message.
import ExcelJS from 'exceljs';
import type { RequestContext } from '../../../types/context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';
import { filterService } from './filter.service.js';
import { validateAndBuildFilterAttributes } from './filter-fields.service.js';

export interface BulkResult {
  row: number;
  name: string;
  status: 'success' | 'error';
  id?: string;
  column?: string;
  value?: string;
  error?: string;
}

export interface BulkUploadOutcome {
  results: BulkResult[];
  created: number;
  failed: number;
  // Parsed display rows (dry-run preview). Present for validateOnly calls.
  rows?: Array<Record<string, string>>;
}

interface ParsedRow {
  rowNumber: number; // 1-based spreadsheet row (header is row 1, first data row is 2)
  name: string;
  filterSet: string;
  ahuType: string;
  filterType: string;
  micronSize: string;
  filterSize: string;
  lastCleaningDate: string;
}

// Header text → canonical key. Accepts the template headers plus a couple of
// friendly aliases for `name`.
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_ALIASES: Record<string, keyof Omit<ParsedRow, 'rowNumber'>> = {
  name: 'name', filtername: 'name', filterid: 'name',
  filterset: 'filterSet',
  ahutype: 'ahuType',
  filtertype: 'filterType',
  micronsize: 'micronSize',
  filtersize: 'filterSize', filterdimensions: 'filterSize', dimensions: 'filterSize',
  lastcleaningdate: 'lastCleaningDate',
};

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text).join('').trim();
    if (typeof o.text === 'string') return o.text.trim();
    if (o.result !== undefined) return String(o.result).trim();
  }
  return String(v).trim();
}

function parseWorkbook(buffer: Buffer): Promise<{ rows: ParsedRow[]; error?: string }> {
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.load(buffer as any).then(() => {
    const ws = wb.worksheets.find((w) => w.name === 'Filters' && w.state !== 'veryHidden') ?? wb.worksheets[0];
    if (!ws) return { rows: [], error: 'Workbook has no readable sheet' };

    // Map each column number to a canonical key via the header row.
    const colKey: Record<number, keyof Omit<ParsedRow, 'rowNumber'>> = {};
    ws.getRow(1).eachCell((cell, col) => {
      const key = HEADER_ALIASES[normalize(cellToString(cell.value))];
      if (key) colKey[col] = key;
    });
    if (!Object.values(colKey).includes('name')) {
      return { rows: [], error: 'Template is missing a "name" column' };
    }

    const rows: ParsedRow[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const r: ParsedRow = { rowNumber, name: '', filterSet: '', ahuType: '', filterType: '', micronSize: '', filterSize: '', lastCleaningDate: '' };
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

export async function bulkUploadFilters(
  buffer: Buffer,
  ahuId: string,
  blockId: string | undefined,
  // Dialog-level fallback used when a row's filterSet cell is empty.
  defaultFilterSet: 'SET_A' | 'SET_B' | undefined,
  ctx: RequestContext,
  opts: { validateOnly?: boolean } = {},
): Promise<BulkUploadOutcome> {
  const defaultWire: 'A' | 'B' | undefined = defaultFilterSet === 'SET_A' ? 'A' : defaultFilterSet === 'SET_B' ? 'B' : undefined;

  // 1. Parse
  const parsed = await parseWorkbook(buffer);
  if (parsed.error) return { results: [{ row: 1, name: '', status: 'error', error: parsed.error }], created: 0, failed: 1 };
  const rows = parsed.rows;
  if (rows.length === 0) return { results: [{ row: 1, name: '', status: 'error', error: 'No data rows found' }], created: 0, failed: 1 };
  if (rows.length > 200) return { results: [{ row: 1, name: '', status: 'error', error: 'Maximum 200 filters per upload' }], created: 0, failed: 1 };

  // 2. AHU + template + (optional) block + profile pre-checks
  const ahu = await prisma.assetInstance.findUnique({ where: { id: ahuId }, select: { id: true, name: true } });
  if (!ahu) return { results: [{ row: 1, name: '', status: 'error', error: 'AHU not found' }], created: 0, failed: 1 };

  // 3. Existing names (batch, case-insensitive)
  const existing = await prisma.assetInstance.findMany({
    where: { name: { in: rows.map((r) => r.name).filter(Boolean), mode: 'insensitive' }, isActive: true },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));

  // 4. Validate every row → collect per-cell errors; build the create payload for clean rows.
  const results: BulkResult[] = [];
  const namesInBatch = new Set<string>();
  const toCreate: Array<{ rowNumber: number; name: string; filterSet?: 'A' | 'B'; ahuType: string; filterType: string; micronSize: string; filterSize: string; lastCleaningDate: string }> = [];

  for (const r of rows) {
    const rowErrs: BulkResult[] = [];
    const name = r.name.trim();

    if (!name) rowErrs.push({ row: r.rowNumber, name: '', status: 'error', column: 'name', value: '', error: 'Filter Name is required' });

    // filterSet: the per-row Excel cell wins. The legacy `defaultWire` (dialog
    // default Set) is retained for API back-compat but the upload dialog no
    // longer sends it (2026-06-11) — filterSet is set per row in the template.
    let filterSetWire: 'A' | 'B' | undefined;
    const setRaw = r.filterSet.toUpperCase().trim();
    if (setRaw === 'A' || setRaw === 'SET_A') filterSetWire = 'A';
    else if (setRaw === 'B' || setRaw === 'SET_B') filterSetWire = 'B';
    else if (!setRaw && defaultWire) filterSetWire = defaultWire;
    else if (setRaw) rowErrs.push({ row: r.rowNumber, name, status: 'error', column: 'filterSet', value: r.filterSet, error: 'filterSet must be A or B' });
    else rowErrs.push({ row: r.rowNumber, name, status: 'error', column: 'filterSet', value: '', error: 'filterSet is required — set A or B in the filterSet column' });

    // Field-option validation against live config (filterService re-derives the
    // attributes from the raw values at create time; here we only collect errors
    // for the per-cell dry-run feedback).
    const { errors: fieldErrors } = await validateAndBuildFilterAttributes({
      ahuType: r.ahuType, filterType: r.filterType, micronSize: r.micronSize, filterSize: r.filterSize, lastCleaningDate: r.lastCleaningDate,
    });
    for (const fe of fieldErrors) rowErrs.push({ row: r.rowNumber, name, status: 'error', column: fe.field, value: fe.value, error: fe.message });

    // Duplicate within the batch / already in DB
    const key = name.toLowerCase();
    if (name && namesInBatch.has(key)) rowErrs.push({ row: r.rowNumber, name, status: 'error', column: 'name', value: name, error: 'Duplicate name in file' });
    else if (name && existingNames.has(key)) rowErrs.push({ row: r.rowNumber, name, status: 'error', column: 'name', value: name, error: `"${name}" already exists` });
    if (name) namesInBatch.add(key);

    if (rowErrs.length > 0) {
      results.push(...rowErrs);
      continue;
    }
    toCreate.push({ rowNumber: r.rowNumber, name, filterSet: filterSetWire, ahuType: r.ahuType, filterType: r.filterType, micronSize: r.micronSize, filterSize: r.filterSize, lastCleaningDate: r.lastCleaningDate });
  }

  // 5. Dry-run: report would-create rows as success, return parsed rows for the preview.
  if (opts.validateOnly) {
    for (const c of toCreate) results.push({ row: c.rowNumber, name: c.name, status: 'success' });
    results.sort((a, b) => a.row - b.row);
    return {
      results,
      created: 0,
      failed: results.filter((r) => r.status === 'error').length,
      rows: rows.map((r) => ({ name: r.name, filterSet: r.filterSet, ahuType: r.ahuType, filterType: r.filterType, micronSize: r.micronSize, filterSize: r.filterSize, lastCleaningDate: r.lastCleaningDate })),
    };
  }

  // 6. Create the clean rows via the standalone typed filter service (A-01 T2.1).
  // filterService.create writes the typed `filters` table directly (no
  // validateParent, no asset_relationships, no asset_template) and re-derives the
  // attributes from the raw field values. RFID tags are NOT assigned at bulk upload
  // (2026-06-12) — operators assign them per-filter via the RFID tag panel.
  const createdNames: string[] = [];
  for (const c of toCreate) {
    try {
      const f = await filterService.create({
        name: c.name,
        ahuId,
        ...(c.filterSet ? { filterSet: c.filterSet } : {}),
        ahuType: c.ahuType, filterType: c.filterType, micronSize: c.micronSize, filterSize: c.filterSize, lastCleaningDate: c.lastCleaningDate,
      }, ctx);
      results.push({ row: c.rowNumber, name: c.name, status: 'success', id: f.id });
      createdNames.push(c.name);
    } catch (err: any) {
      results.push({ row: c.rowNumber, name: c.name, status: 'error', error: err?.message ?? 'Create failed' });
    }
  }

  // 7. Audit (one summary entry for the batch)
  if (createdNames.length > 0) {
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'BULK_FILTER_UPLOAD', targetType: 'asset_instance', targetId: ahuId,
      afterValue: { ahuName: ahu.name, count: createdNames.length, filters: createdNames },
      reason: `Bulk uploaded ${createdNames.length} filters into AHU "${ahu.name}"`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
  }

  results.sort((a, b) => a.row - b.row);
  return { results, created: createdNames.length, failed: results.filter((r) => r.status === 'error').length };
}
