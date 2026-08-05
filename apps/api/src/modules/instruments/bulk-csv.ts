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
 * Parse a CSV line with RFC4180-style quoted field handling:
 * - Fields can be wrapped in double quotes
 * - Commas inside quoted fields are literal
 * - Escaped quotes inside quoted fields use ""
 * - Unquoted fields are used as-is
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote: "" inside a quoted field becomes a single quote
        current += '"';
        i++; // Skip the next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator (only if not inside quotes)
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  // Add the last field
  fields.push(current);

  return fields;
}

/**
 * Deliberately partial-success: valid rows are returned even when others fail,
 * so one typo does not reject a 200-device import. Row numbers are 1-based and
 * count the header, matching what the operator sees in a spreadsheet.
 */
export function parseInstrumentCsv(text: string): { rows: InstrumentDraft[]; errors: RowError[] } {
  // Split into lines WITHOUT filtering to preserve source row numbers
  const allLines = text.split(/\r?\n/);

  // Find the header: first non-blank line
  let headerRowIndex = -1;
  let header: string[] = [];

  for (let i = 0; i < allLines.length; i++) {
    const trimmed = allLines[i].trim();
    if (trimmed.length > 0) {
      headerRowIndex = i;
      header = parseCSVLine(trimmed);
      break;
    }
  }

  // Check header validity
  if (headerRowIndex === -1) {
    return { rows: [], errors: [{ row: 1, message: 'Missing header row' }] };
  }

  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: [{ row: headerRowIndex + 1, message: `Missing header column(s): ${missing.join(', ')}` }] };
  }

  const rows: InstrumentDraft[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();

  // Process data rows
  for (let i = headerRowIndex + 1; i < allLines.length; i++) {
    const trimmed = allLines[i].trim();

    // Skip blank lines
    if (trimmed.length === 0) {
      continue;
    }

    const rowNo = i + 1; // 1-based row number matching source file

    // Check for unterminated quotes
    let quoteCount = 0;
    for (const char of trimmed) {
      if (char === '"') quoteCount++;
    }

    // Odd number of unescaped quotes means unterminated
    // Count escaped quotes ("") as two quotes, unescaped as one
    let unescapedQuotes = 0;
    for (let j = 0; j < trimmed.length; j++) {
      if (trimmed[j] === '"' && trimmed[j + 1] !== '"') {
        unescapedQuotes++;
      } else if (trimmed[j] === '"' && trimmed[j + 1] === '"') {
        j++; // Skip the escaped quote pair
      }
    }

    if (unescapedQuotes % 2 !== 0) {
      errors.push({ row: rowNo, message: 'Unterminated quoted field' });
      continue;
    }

    const cells = parseCSVLine(trimmed);
    const get = (col: string) => {
      const idx = header.indexOf(col);
      return idx === -1 ? '' : (cells[idx] ?? '').trim();
    };

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
