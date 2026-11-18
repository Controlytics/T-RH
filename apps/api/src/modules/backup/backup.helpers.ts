import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupData {
  metadata: {
    version: string;
    timestamp: string;
    generatedBy: string;
    tableCount: number;
    checksum: string;
    format?: string;
  };
  data: Record<string, any[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Table list is now discovered dynamically at backup time
// (see getAllTables in backup.repository.ts)

// ---------------------------------------------------------------------------
// Pure helper functions (no DB access)
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 checksum over the backup data payload.
 * Top-level keys are sorted for deterministic ordering.
 */
export function computeBackupChecksum(data: Record<string, any[]>): string {
  const sorted: Record<string, any[]> = {};
  for (const key of Object.keys(data).sort()) {
    sorted[key] = data[key];
  }
  const payload = JSON.stringify(sorted);
  return createHash('sha256').update(payload).digest('hex');
}

/** Escape a value for a PostgreSQL INSERT statement. */
export function escapeSqlValue(value: any): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  // String — escape single quotes
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** How a CSV cell prints a timestamp. */
export type CsvDateFormatter = (date: Date) => string;

const utcIso: CsvDateFormatter = (date) => date.toISOString();

/**
 * A formatter writing an instant as ISO 8601 in `timeZone` WITH that zone's
 * offset — `2026-11-16T19:58:00.020+05:30` (2026-11-17, operator: "in csv file
 * date and time was coming wrong": the CSV export wrote UTC, 5:30 behind every
 * screen). The wall time is the one the screens show; the offset keeps it the
 * SAME instant to Postgres (restore inserts it into a timestamptz) and to
 * `new Date()` (the restore's audit-chain check). Never drop the offset: a bare
 * wall time is read in the database session's zone — UTC on RDS — and would
 * restore 5:30 wrong. The `T` is the shape ECMAScript guarantees to parse.
 *
 * Build ONE per export: the Intl formatter is the expensive part, and a backup
 * carries hundreds of thousands of timestamps.
 */
export function zonedIsoFormatter(timeZone: string): CsvDateFormatter {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  return (date) => {
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    // 'longOffset' names UTC as "GMT" and every other offset as "GMT±HH:MM".
    // Anything else (a historical offset in seconds) has no ISO spelling: UTC.
    const zone = p.timeZoneName === 'GMT' ? '+00:00' : /^GMT([+-]\d{2}:\d{2})$/.exec(p.timeZoneName ?? '')?.[1];
    if (!zone) return date.toISOString();
    const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}${zone}`;
  };
}

/** Escape a value for CSV output. A Date prints through `formatDate` (UTC ISO by default). */
export function escapeCsvValue(value: any, formatDate: CsvDateFormatter = utcIso): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'object') return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate SQL INSERT statements for a single table.
 * NOTE: Does NOT include TRUNCATE — the caller handles truncation separately
 * because export needs a specific FK-safe ordering.
 */
export function generateSqlInserts(tableName: string, rows: Record<string, any>[]): string {
  if (rows.length === 0) return `-- Table: ${tableName} (0 rows)\n`;

  const columns = Object.keys(rows[0]);
  const lines: string[] = [];
  lines.push(`-- Table: ${tableName} (${rows.length} rows)`);

  for (const row of rows) {
    const values = columns.map(col => escapeSqlValue(row[col]));
    lines.push(`INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Generate CSV content (header + rows) for a single table. Timestamps print through `formatDate`. */
export function generateCsv(rows: Record<string, any>[], formatDate: CsvDateFormatter = utcIso): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]);
  const lines: string[] = [];
  lines.push(columns.join(','));
  for (const row of rows) {
    lines.push(columns.map(col => escapeCsvValue(row[col], formatDate)).join(','));
  }
  return lines.join('\n');
}
