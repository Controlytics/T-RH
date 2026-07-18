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

/** Escape a value for CSV output. */
export function escapeCsvValue(value: any): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
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

/** Generate CSV content (header + rows) for a single table. */
export function generateCsv(rows: Record<string, any>[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]);
  const lines: string[] = [];
  lines.push(columns.join(','));
  for (const row of rows) {
    lines.push(columns.map(col => escapeCsvValue(row[col])).join(','));
  }
  return lines.join('\n');
}
