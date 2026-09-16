// `name` stopped being REQUIRED on 2026-09-16: the create form has set name = code since
// the 2026-08-07 trim, and the template no longer carries a name column. A
// `name` column is still honoured when present.
const REQUIRED = ['code'] as const;
const OPTIONAL = ['name', 'instrumentType', 'manufacturer', 'model', 'serialNumber', 'description'] as const;

/**
 * An attribute column the file may carry (2026-09-16, operator: "in bulk
 * upload template only attributes display names should come"). `label` is the
 * administered display name the template prints as the heading; `key` is what
 * gets stored. A header matches by EITHER, trimmed and case-folded — the same
 * rule every attribute surface applies — so a file headed by keys (an older
 * template, a device vendor's sheet) still imports.
 */
export interface AttributeColumn { key: string; label: string }

/**
 * The template's own heading for the code column (2026-09-16, operator: "in
 * bulk option in template Instrument ID field") — the words the create form
 * uses. Normalised to `code` before anything else reads the header, so the rest
 * of the parser and every file operators already have keep working unchanged.
 */
export const INSTRUMENT_ID_HEADING = 'Instrument ID';
const CODE_HEADINGS = new Set(['code', INSTRUMENT_ID_HEADING.toLowerCase()]);

/**
 * Columns that were once meaningful and are now accepted-and-discarded.
 *
 * `transport` was REQUIRED until 2026-08-06, so every spreadsheet an operator
 * has saved still carries it; making it an error row would break all of them
 * at once. But a column that silently does nothing is its own trap — a typo
 * like `htpp` used to fail the row loudly and would now "import fine", with
 * nothing telling the operator the value is no longer read. So the column is
 * tolerated and reported ONCE per import via `warnings`, which is deliberately
 * separate from `errors`: that array drives the failed-row UI and the
 * partial-success count, and a whole-file advisory is not a failed row.
 */
const IGNORED_COLUMNS: Record<string, string> = {
  transport:
    'The `transport` column is no longer used and was ignored — an instrument\'s token works on any listener. Remove it from your template.',
};

export interface InstrumentDraft {
  name: string; code: string;
  instrumentType?: string; manufacturer?: string; model?: string;
  serialNumber?: string; description?: string;
  /** Attribute KEY → typed value, only for cells that were filled. Absent when none were. */
  attributes?: Record<string, string>;
}
/**
 * One rejected row. `column` is the heading AS THE FILE SPELLS IT (2026-09-16,
 * operator: "show a popup where it failed and reason, in which line which
 * cell") — absent when the fault is the whole row, such as a broken quote.
 * `row` counts the header, matching the spreadsheet.
 */
export interface RowError { row: number; column?: string; message: string }

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
 *
 * `rowNumbers` runs parallel to `rows` (same length, same order) so a failure
 * discovered LATER — a code that collides with an instrument already in the
 * database — can still be reported against the operator's source row. It is a
 * sidecar array rather than a field on the draft so the drafts stay
 * assignable straight to Prisma.
 */
export function parseInstrumentCsv(text: string, attributeColumns: AttributeColumn[] = []): { rows: InstrumentDraft[]; rowNumbers: number[]; errors: RowError[]; warnings: string[]; codeHeading: string } {
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
    return { rows: [], rowNumbers: [], errors: [{ row: 1, message: 'Missing header row' }], warnings: [], codeHeading: INSTRUMENT_ID_HEADING };
  }
  // Remember how the file spells the code heading, so an error about that
  // cell names the column the operator can see.
  const codeHeadingInFile = header.find((h) => CODE_HEADINGS.has(h.trim().toLowerCase()))?.trim() ?? INSTRUMENT_ID_HEADING;
  header = header.map((h) => (CODE_HEADINGS.has(h.trim().toLowerCase()) ? 'code' : h));

  // One advisory per retired column present, raised before the rows are walked
  // so it is reported even for a file whose every row then fails.
  const warnings = Object.entries(IGNORED_COLUMNS)
    .filter(([col]) => header.includes(col))
    .map(([, message]) => message);

  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    // Named as the template prints it, so the message matches what the operator
    // sees in their spreadsheet.
    const named = missing.map((c) => (c === 'code' ? INSTRUMENT_ID_HEADING : c));
    return { rows: [], rowNumbers: [], errors: [{ row: headerRowIndex + 1, column: INSTRUMENT_ID_HEADING, message: `Missing header column(s): ${named.join(', ')}` }], warnings, codeHeading: INSTRUMENT_ID_HEADING };
  }

  // Resolve every non-standard header to an attribute KEY, by display name or
  // by key, case-insensitively. A header that is neither is reported ONCE for
  // the whole file and read by nothing: a typo in a heading must not quietly
  // become an attribute nobody administered.
  const fold = (s: string) => s.trim().toLowerCase();
  const standard = new Set<string>([...REQUIRED, ...OPTIONAL, ...Object.keys(IGNORED_COLUMNS)]);
  const attributeAt = new Map<number, string>();
  const unknown: string[] = [];
  header.forEach((h, idx) => {
    if (standard.has(h)) return;
    const hit = attributeColumns.find((c) => fold(c.label) === fold(h) || fold(c.key) === fold(h));
    if (hit) attributeAt.set(idx, hit.key);
    else if (h.trim()) unknown.push(h.trim());
  });
  if (unknown.length > 0) {
    warnings.push(
      `Column(s) ${unknown.map((u) => `"${u}"`).join(', ')} are not attributes of this profile and were ignored. Download the template again for the current headings.`,
    );
  }

  const rows: InstrumentDraft[] = [];
  const rowNumbers: number[] = [];
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

    const code = get('code');
    // Blank or absent name = the code, exactly as the create form fills it.
    const name = get('name') || code;

    if (!code) { errors.push({ row: rowNo, column: codeHeadingInFile, message: 'Instrument ID is required' }); continue; }
    // Case ignored (2026-09-16): the database refuses case variants too
    // (unique index on lower(code)), and a file that is refused row by row on
    // the way in is kinder than one that fails at the database.
    if (seen.has(code.toLowerCase())) { errors.push({ row: rowNo, column: codeHeadingInFile, message: `Instrument ID "${code}" is repeated in this file` }); continue; }
    seen.add(code.toLowerCase());

    // A `transport` cell, valid or not, is read by nothing — the whole-file
    // warning above is the only signal it gets.
    const draft: InstrumentDraft = { name, code };
    for (const col of OPTIONAL) { if (col === 'name') continue; const v = get(col); if (v) (draft as unknown as Record<string, string>)[col] = v; }
    // Only filled cells become attributes: an empty cell is "not answered", and
    // writing '' would record an answer the operator did not give.
    for (const [idx, key] of attributeAt) {
      const v = (cells[idx] ?? '').trim();
      if (!v) continue;
      (draft.attributes ??= {})[key] = v;
    }
    rows.push(draft);
    rowNumbers.push(rowNo);
  }

  return { rows, rowNumbers, errors, warnings, codeHeading: codeHeadingInFile };
}
