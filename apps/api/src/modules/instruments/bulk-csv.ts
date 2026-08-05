export const TRANSPORTS = ['http', 'https', 'mqtt', 'mqtts', 'websocket', 'wss', 'tcp'] as const;

const REQUIRED = ['name', 'code', 'transport'] as const;
const OPTIONAL = ['instrumentType', 'manufacturer', 'model', 'serialNumber', 'description'] as const;

export interface InstrumentDraft {
  name: string; code: string; transport: string;
  instrumentType?: string; manufacturer?: string; model?: string;
  serialNumber?: string; description?: string;
}
export interface RowError { row: number; message: string }

/**
 * Deliberately partial-success: valid rows are returned even when others fail,
 * so one typo does not reject a 200-device import. Row numbers are 1-based and
 * count the header, matching what the operator sees in a spreadsheet.
 */
export function parseInstrumentCsv(text: string): { rows: InstrumentDraft[]; errors: RowError[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], errors: [{ row: 1, message: 'Missing header row' }] };

  const header = lines[0].split(',').map((h) => h.trim());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: [{ row: 1, message: `Missing header column(s): ${missing.join(', ')}` }] };
  }

  const rows: InstrumentDraft[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const rowNo = i + 1;
    const cells = lines[i].split(',').map((c) => c.trim());
    const get = (col: string) => { const idx = header.indexOf(col); return idx === -1 ? '' : (cells[idx] ?? ''); };

    const name = get('name'), code = get('code'), transport = get('transport').toLowerCase();

    if (!name) { errors.push({ row: rowNo, message: 'name is required' }); continue; }
    if (!code) { errors.push({ row: rowNo, message: 'code is required' }); continue; }
    if (!TRANSPORTS.includes(transport as (typeof TRANSPORTS)[number])) {
      errors.push({ row: rowNo, message: `transport must be one of: ${TRANSPORTS.join(', ')}` });
      continue;
    }
    if (seen.has(code)) { errors.push({ row: rowNo, message: `duplicate code "${code}" in this file` }); continue; }
    seen.add(code);

    const draft: InstrumentDraft = { name, code, transport };
    for (const col of OPTIONAL) { const v = get(col); if (v) (draft as unknown as Record<string, string>)[col] = v; }
    rows.push(draft);
  }

  return { rows, errors };
}
