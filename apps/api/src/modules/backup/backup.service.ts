import { gzipSync, gunzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';

/**
 * Decompression ceiling for uploaded backups (2 GB).
 *
 * The upload limit (100 MB, backup/routes.ts) bounds the COMPRESSED bytes only.
 * gzip hits ~1000:1 on repetitive input, so without a ceiling a max-size upload
 * can demand ~100 GB of heap and OOM a single-process API that the whole tablet
 * fleet depends on.
 *
 * 2 GB is chosen to sit above any plausible real backup — the live dev DB dumps
 * to ~29 MB — while staying under Node's ~2 GB max string length, which
 * `.toString('utf-8')` would hit anyway.
 */
const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;

import { auditLog } from '../../lib/audit.js';
import type { RequestContext } from '../../types/context.js';
import {
  fetchAllTablesRaw,
  restoreFromBackup,
} from './backup.repository.js';
import {
  computeBackupChecksum,
  escapeSqlValue,
  generateCsv,
  type BackupData,
} from './backup.helpers.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Generate a date string suitable for filenames (e.g. "2026-02-21_10-30-00"). */
function dateStamp(): string {
  return new Date()
    .toISOString()
    .replace(/T/, '_')
    .replace(/:/g, '-')
    .replace(/\..+/, '');
}

/**
 * Parse a raw backup file buffer into a BackupData object.
 * Handles gzip detection (.bak) and JSON parsing.
 * Throws with structured { code, message } on failure.
 */
/**
 * Parse a CSV string into an array of objects using the header row as keys.
 */
function parseCsvContent(csvString: string): Record<string, any>[] {
  const lines = csvString.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, any>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, any> = {};
    for (let j = 0; j < headers.length; j++) {
      let val: any = values[j] ?? '';
      // Try to parse JSON objects/arrays
      if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
        try {
          val = JSON.parse(val);
        } catch {
          // Cell looks JSON-shaped but isn't valid JSON — treat as a plain
          // string. This is intentional, not an error: CSV exports of JSON
          // columns sometimes contain manually-edited cells that lose strict
          // JSON validity.
        }
      }
      // Convert "true"/"false" to boolean
      else if (val === 'true') val = true;
      else if (val === 'false') val = false;
      // Convert numeric strings — ONLY when the string is the canonical form of the
      // number (#backup-csv fix). The old check coerced any numeric-looking cell,
      // corrupting text columns: "0055"→55, "+919876543210"→919876543210, "1.0"→1,
      // "1e5"→100000 (serials / phone numbers / zero-padded codes lost their form).
      // `String(Number(val)) === val` coerces genuine numbers (e.g. "55") and leaves
      // everything else as text; Postgres casts per column type on reinsert either way.
      else if (val !== '' && val.length < 15 && Number.isFinite(Number(val)) && String(Number(val)) === val) val = Number(val);
      // Convert empty to null
      else if (val === '') val = null;
      row[headers[j]] = val;
    }
    rows.push(row);
  }
  return rows;
}

/** Parse a single CSV line respecting quoted fields */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

/**
 * Parse SQL backup into BackupData by extracting INSERT statements.
 */
function parseSqlBackup(sqlContent: string): BackupData {
  const data: Record<string, any[]> = {};

  // Seed all tables referenced by TRUNCATE statements — this captures empty tables too
  const truncateRegex = /TRUNCATE TABLE "([^"]+)"/g;
  let tm;
  while ((tm = truncateRegex.exec(sqlContent)) !== null) {
    if (!data[tm[1]]) data[tm[1]] = [];
  }

  // Parse each INSERT with a STRING-AWARE scanner. The previous single regex
  // (/...VALUES\s*\((.+?)\);/g) had two silent data-loss bugs on real data:
  //   1. `.` doesn't match newlines → any row with a newline inside a text value
  //      (multi-line reason / description / address) was SILENTLY DROPPED — the
  //      INSERT simply failed to match, so the row vanished on restore.
  //   2. `\);` is lazy → a value containing `);` (e.g. "cleaned filter (A); redo")
  //      terminated the match at the FIRST `);` → the row was truncated to the
  //      wrong column count and reinserted corrupt (or rejected).
  // Fix: match only the fixed `INSERT INTO "t" (cols) VALUES (` header (identifiers
  // never contain newlines or `)`), then scan the values with full single-quote /
  // `''`-escape awareness to find the TRUE top-level `)`. A stray `INSERT INTO …`
  // substring living inside a string value can't be re-matched because the cursor
  // always advances past the statement we just consumed.
  const headerRegex = /INSERT INTO "([^"]+)"\s*\(([^)]+)\)\s*VALUES\s*\(/g;
  let cursor = 0;
  for (;;) {
    headerRegex.lastIndex = cursor;
    const m = headerRegex.exec(sqlContent);
    if (!m) break;
    const table = m[1];
    const columns = m[2].split(',').map(c => c.trim().replace(/"/g, ''));
    const valuesStart = headerRegex.lastIndex; // first char after VALUES '('
    const valuesEnd = findValuesClose(sqlContent, valuesStart);
    if (valuesEnd === -1) {
      // Truncated/malformed tail (no unquoted close paren). Stop rather than
      // silently mis-parse the remainder into bad rows.
      break;
    }
    const valuesStr = sqlContent.slice(valuesStart, valuesEnd);

    // Parse values (handle quoted strings, NULL, booleans, numbers, jsonb)
    const values = parseSqlValues(valuesStr);

    if (!data[table]) data[table] = [];
    const row: Record<string, any> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = values[i] ?? null;
    }
    data[table].push(row);

    cursor = valuesEnd + 1; // past this statement's close paren
  }

  // Extract metadata from SQL comments
  let generatedBy = 'unknown';
  let timestamp = new Date().toISOString();
  const byMatch = sqlContent.match(/-- Generated By: (.+)/);
  if (byMatch) generatedBy = byMatch[1].trim();
  const tsMatch = sqlContent.match(/-- Generated: (.+)/);
  if (tsMatch) timestamp = tsMatch[1].trim();

  return {
    metadata: {
      version: '1.0.0',
      timestamp,
      generatedBy,
      tableCount: Object.keys(data).length,
      checksum: computeBackupChecksum(data),
      format: 'sql',
    },
    data,
  };
}

/** Parse SQL VALUES string into JS values */
function parseSqlValues(valuesStr: string): any[] {
  const result: any[] = [];
  let current = '';
  let inString = false;
  let depth = 0;

  for (let i = 0; i < valuesStr.length; i++) {
    const ch = valuesStr[i];
    if (inString) {
      if (ch === "'" && valuesStr[i + 1] === "'") { current += "'"; i++; }
      else if (ch === "'") {
        inString = false;
        // Check for ::jsonb cast
        if (valuesStr.substring(i + 1, i + 8) === '::jsonb') {
          i += 7;
          try { result.push(JSON.parse(current)); } catch { result.push(current); }
        } else {
          result.push(current);
        }
        current = '';
      }
      else { current += ch; }
    } else {
      if (ch === "'") { inString = true; current = ''; }
      else if (ch === ',' && depth === 0) {
        const trimmed = current.trim();
        if (trimmed === 'NULL') result.push(null);
        else if (trimmed === 'TRUE') result.push(true);
        else if (trimmed === 'FALSE') result.push(false);
        else if (trimmed && !isNaN(Number(trimmed))) result.push(Number(trimmed));
        current = '';
      }
      else { current += ch; }
    }
  }
  // Handle last value
  if (!inString) {
    const trimmed = current.trim();
    if (trimmed === 'NULL') result.push(null);
    else if (trimmed === 'TRUE') result.push(true);
    else if (trimmed === 'FALSE') result.push(false);
    else if (trimmed && !isNaN(Number(trimmed))) result.push(Number(trimmed));
    else if (trimmed) result.push(trimmed);
  }

  return result;
}

/**
 * Given a serialized SQL VALUES list, scan from `start` (the first char AFTER
 * the opening `(`) and return the index of the matching TOP-LEVEL `)` — the one
 * that is NOT inside a quoted string. Single quotes escape as `''` (SQL
 * standard, matching escapeSqlValue). Newlines, `)`, `;` and `,` inside a quoted
 * string are all skipped. Returns -1 if no unquoted close paren exists
 * (truncated input). This is what makes multi-line values and values containing
 * `);` parse correctly.
 */
function findValuesClose(sql: string, start: number): number {
  let inString = false;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { i++; continue; } // '' escaped quote — skip both
        inString = false;
      }
      // any other char (incl. newline / ')' / ';') stays inside the string
    } else {
      if (ch === "'") inString = true;
      else if (ch === ')') return i; // top-level close paren
    }
  }
  return -1;
}



/**
 * Parse a CSV ZIP backup into BackupData.
 */
function parseCsvZipBackup(rawBuffer: Buffer): BackupData {
  const zip = new AdmZip(rawBuffer);
  const entries = zip.getEntries();

  // AdmZip decompresses entries fully into memory, so a zip bomb inside the
  // 100 MB upload cap can exhaust the heap before any of our parsing runs. The
  // central directory declares each entry's uncompressed size up front, so the
  // total can be rejected without decompressing anything.
  const declaredTotal = entries.reduce((sum, e) => sum + (e.header?.size ?? 0), 0);
  if (declaredTotal > MAX_DECOMPRESSED_BYTES) {
    throw Object.assign(
      new Error(`Backup expands to ${Math.round(declaredTotal / 1e6)} MB, beyond the ${Math.round(MAX_DECOMPRESSED_BYTES / 1e6)} MB decompression limit.`),
      { code: 'INVALID_ZIP' },
    );
  }

  // Read metadata
  const metaEntry = entries.find(e => e.entryName === '_metadata.json');
  let generatedBy = 'unknown';
  let timestamp = new Date().toISOString();
  if (metaEntry) {
    try {
      const meta = JSON.parse(metaEntry.getData().toString('utf-8'));
      generatedBy = meta.generatedBy ?? 'unknown';
      timestamp = meta.timestamp ?? timestamp;
    } catch (err) {
      // Corrupted _metadata.json. Restore can still proceed with default
      // metadata, but a malformed metadata file is a real signal that the
      // backup may be partially corrupt — log so QA can investigate.
      console.warn('[backup] _metadata.json could not be parsed; using defaults:', err);
    }
  }

  const data: Record<string, any[]> = {};
  for (const entry of entries) {
    if (entry.entryName === '_metadata.json') continue;
    if (!entry.entryName.endsWith('.csv')) continue;

    const tableName = entry.entryName.replace('.csv', '');
    const csvContent = entry.getData().toString('utf-8');
    data[tableName] = parseCsvContent(csvContent);
  }

  return {
    metadata: {
      version: '1.0.0',
      timestamp,
      generatedBy,
      tableCount: Object.keys(data).length,
      checksum: computeBackupChecksum(data),
      format: 'csv',
    },
    data,
  };
}

function parseBackupFile(rawBuffer: Buffer): BackupData {
  // Detect ZIP (.csv backup) — ZIP magic bytes: 0x50 0x4b
  if (rawBuffer[0] === 0x50 && rawBuffer[1] === 0x4b) {
    return parseCsvZipBackup(rawBuffer);
  }

  // Detect gzip (.bak) — gzip magic bytes: 0x1f 0x8b
  let content: string;
  if (rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b) {
    try {
      // maxOutputLength is the only thing between a 100 MB upload and an OOM:
      // gzip reaches ~1000:1 on repetitive input, so an unbounded gunzipSync of
      // a max-size upload can demand ~100 GB of heap. This is a single-process
      // API serving the tablet fleet — killing it takes the cleanroom floor with
      // it. zlib throws past the cap, which the catch turns into INVALID_BAK.
      content = gunzipSync(rawBuffer, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf-8');
    } catch {
      throw Object.assign(new Error('Failed to decompress .bak file. File may be corrupted or expands beyond the decompression limit.'), {
        code: 'INVALID_BAK',
      });
    }
  } else {
    content = rawBuffer.toString('utf-8');
  }

  // Detect SQL format
  if (content.trimStart().startsWith('-- DigiLog Database Backup')) {
    return parseSqlBackup(content);
  }

  let backup: BackupData;
  try {
    backup = JSON.parse(content);
  } catch {
    throw Object.assign(new Error('Backup file is not valid JSON. Supported formats: .json, .bak, .sql, .zip (CSV)'), {
      code: 'INVALID_JSON',
    });
  }

  if (!backup.metadata || !backup.data) {
    throw Object.assign(new Error('Backup file is missing metadata or data sections'), {
      code: 'INVALID_BACKUP',
    });
  }

  return backup;
}

// ---------------------------------------------------------------------------
// Export: JSON format (default)
// ---------------------------------------------------------------------------

export async function exportJson(
  username: string,
  ctx: RequestContext,
): Promise<{ backup: BackupData; filename: string }> {
  const data = await fetchAllTablesRaw();
  const checksum = computeBackupChecksum(data);
  const timestamp = new Date().toISOString();

  const backup: BackupData = {
    metadata: {
      version: '1.0.0',
      timestamp,
      generatedBy: username,
      tableCount: Object.keys(data).length,
      checksum,
      format: 'json',
    },
    data,
  };

  await auditLog({
    userId: ctx.userId,
    userRole: ctx.userRole,
    action: 'BACKUP_CREATED',
    targetType: 'system',
    targetId: 'database_backup',
    afterValue: {
      format: 'json',
      timestamp,
      checksum,
      tableCount: Object.keys(data).length,
      totalRecords: Object.values(data).reduce((sum, arr) => sum + arr.length, 0),
    },
    signatureMeaning: 'Full database backup created by administrator',
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    sessionId: ctx.sessionId,
  });

  return { backup, filename: `digilog_backup_${dateStamp()}.json` };
}

// ---------------------------------------------------------------------------
// Export: BAK format (gzip-compressed JSON)
// ---------------------------------------------------------------------------

export async function exportBak(
  username: string,
  ctx: RequestContext,
): Promise<{ compressed: Buffer; filename: string }> {
  const data = await fetchAllTablesRaw();
  const checksum = computeBackupChecksum(data);
  const timestamp = new Date().toISOString();

  const backup: BackupData = {
    metadata: {
      version: '1.0.0',
      timestamp,
      generatedBy: username,
      tableCount: Object.keys(data).length,
      checksum,
      format: 'bak',
    },
    data,
  };

  // BigInt replacer — audit 2026-05-04 fix C3 added a BIGSERIAL chain_position
  // column to audit_trail. The pg driver returns BIGSERIAL as native BigInt,
  // and JSON.stringify throws on BigInt without a replacer. Stringify them
  // here so the backup is JSON-clean. Restore parses them back as strings;
  // operators reading the backup file see the value verbatim.
  const jsonStr = JSON.stringify(backup, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  const compressed = gzipSync(Buffer.from(jsonStr, 'utf-8'), { level: 9 });

  await auditLog({
    userId: ctx.userId,
    userRole: ctx.userRole,
    action: 'BACKUP_CREATED',
    targetType: 'system',
    targetId: 'database_backup',
    afterValue: {
      format: 'bak',
      timestamp,
      checksum,
      tableCount: Object.keys(data).length,
      totalRecords: Object.values(data).reduce((sum, arr) => sum + arr.length, 0),
      compressedSize: compressed.length,
      originalSize: jsonStr.length,
    },
    signatureMeaning: 'Compressed database backup created by administrator',
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    sessionId: ctx.sessionId,
  });

  return { compressed, filename: `digilog_backup_${dateStamp()}.bak` };
}

// ---------------------------------------------------------------------------
// Export: SQL format
// ---------------------------------------------------------------------------

export async function exportSql(
  username: string,
  ctx: RequestContext,
): Promise<{ sqlContent: string; filename: string }> {
  const rawData = await fetchAllTablesRaw();
  const tables = Object.keys(rawData);
  const totalRecords = Object.values(rawData).reduce((sum, arr) => sum + arr.length, 0);

  const sqlParts: string[] = [];
  sqlParts.push('-- DigiLog Database Backup');
  sqlParts.push(`-- Generated: ${new Date().toISOString()}`);
  sqlParts.push(`-- Generated By: ${username}`);
  sqlParts.push(`-- Total Records: ${totalRecords}`);
  sqlParts.push(`-- Format: PostgreSQL SQL`);
  sqlParts.push('');
  sqlParts.push('BEGIN;');
  sqlParts.push('');

  // FK-safe order: delete children first, insert parents first
  const deleteOrder = [...tables].reverse();
  for (const table of deleteOrder) {
    sqlParts.push(`TRUNCATE TABLE "${table}" CASCADE;`);
  }
  sqlParts.push('');

  for (const table of tables) {
    const rows = rawData[table];
    if (rows.length === 0) {
      sqlParts.push(`-- Table: ${table} (0 rows)`);
      sqlParts.push('');
      continue;
    }
    const columns = Object.keys(rows[0]);
    sqlParts.push(`-- Table: ${table} (${rows.length} rows)`);
    for (const row of rows) {
      const values = columns.map(col => escapeSqlValue(row[col]));
      sqlParts.push(
        `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});`,
      );
    }
    sqlParts.push('');
  }

  sqlParts.push('COMMIT;');

  await auditLog({
    userId: ctx.userId,
    userRole: ctx.userRole,
    action: 'BACKUP_CREATED',
    targetType: 'system',
    targetId: 'database_backup',
    afterValue: { format: 'sql', timestamp: new Date().toISOString(), totalRecords },
    signatureMeaning: 'SQL database backup created by administrator',
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    sessionId: ctx.sessionId,
  });

  return { sqlContent: sqlParts.join('\n'), filename: `digilog_backup_${dateStamp()}.sql` };
}

// ---------------------------------------------------------------------------
// Export: CSV format (ZIP archive of per-table CSVs)
// ---------------------------------------------------------------------------

export async function exportCsv(
  username: string,
  ctx: RequestContext,
): Promise<{ zipBuffer: Buffer; filename: string }> {
  const rawData = await fetchAllTablesRaw();
  const tables = Object.keys(rawData);
  const totalRecords = Object.values(rawData).reduce((sum, arr) => sum + arr.length, 0);

  const zip = new AdmZip();

  for (const table of tables) {
    const rows = rawData[table];
    const csvContent = generateCsv(rows);
    zip.addFile(`${table}.csv`, Buffer.from(csvContent, 'utf-8'));
  }

  // Add a metadata file
  const metaContent = JSON.stringify(
    {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      generatedBy: username,
      format: 'csv',
      tableCount: tables.length,
      totalRecords,
      tables: Object.fromEntries(tables.map(t => [t, rawData[t].length])),
    },
    null,
    2,
  );
  zip.addFile('_metadata.json', Buffer.from(metaContent, 'utf-8'));

  await auditLog({
    userId: ctx.userId,
    userRole: ctx.userRole,
    action: 'BACKUP_CREATED',
    targetType: 'system',
    targetId: 'database_backup',
    afterValue: { format: 'csv', timestamp: new Date().toISOString(), totalRecords },
    signatureMeaning: 'CSV database backup created by administrator',
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    sessionId: ctx.sessionId,
  });

  return { zipBuffer: zip.toBuffer(), filename: `digilog_backup_${dateStamp()}.zip` };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export async function restore(
  fileBuffer: Buffer,
  ctx: RequestContext,
  opts: { force?: boolean } = {},
): Promise<{
  success: boolean;
  message: string;
  backupTimestamp: string;
  backupVersion: string;
}> {
  const backup = parseBackupFile(fileBuffer);

  if (!backup.metadata.version) {
    throw Object.assign(new Error('Backup metadata is incomplete'), {
      code: 'INVALID_METADATA',
    });
  }

  // Checksum verification (skip for SQL/CSV since checksum is computed on import)
  const fmt = backup.metadata.format ?? 'json';
  if (fmt === 'json' || fmt === 'bak') {
    if (!backup.metadata.checksum) {
      throw Object.assign(new Error('Backup metadata is missing checksum'), {
        code: 'INVALID_METADATA',
      });
    }
    const computedChecksum = computeBackupChecksum(backup.data);
    if (computedChecksum !== backup.metadata.checksum) {
      throw Object.assign(new Error(
        'Backup file integrity check failed. The file may have been tampered with or corrupted.',
      ), { code: 'CHECKSUM_MISMATCH' });
    }
  }

  // Audit 2026-05-04 fix #7: pass force-flag through to restoreFromBackup so
  // a tampered audit_trail chain is refused unless the operator explicitly
  // overrides. Force is itself audited in the BACKUP_RESTORED row below
  // (afterValue.forced=true).
  await restoreFromBackup(backup, { force: opts.force });

  // Audit log the restore
  await auditLog({
    userId: ctx.userId,
    userRole: ctx.userRole,
    action: 'BACKUP_RESTORED',
    targetType: 'system',
    targetId: 'database_restore',
    afterValue: {
      backupTimestamp: backup.metadata.timestamp,
      backupVersion: backup.metadata.version,
      backupChecksum: backup.metadata.checksum,
      generatedBy: backup.metadata.generatedBy,
      forced: opts.force === true,
    },
    signatureMeaning: opts.force
      ? 'Database restored from backup by administrator (audit-chain verification BYPASSED)'
      : 'Database restored from backup by administrator',
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    sessionId: ctx.sessionId,
  });

  return {
    success: true,
    message: 'Database restored successfully',
    backupTimestamp: backup.metadata.timestamp,
    backupVersion: backup.metadata.version,
  };
}

// ---------------------------------------------------------------------------
// Validate (no DB mutation)
// ---------------------------------------------------------------------------

export async function validate(
  fileBuffer: Buffer,
): Promise<{
  valid: boolean;
  metadata: BackupData['metadata'];
  tableSummary: Record<string, number>;
  checksumValid: boolean;
  checksumSupported: boolean;
  totalRecords: number;
}> {
  const backup = parseBackupFile(fileBuffer);

  // #low-batch: the checksum is only an INDEPENDENT integrity check for json/bak,
  // whose digest is stored in the file. SQL/CSV synthesize the checksum FROM the
  // parsed data at import time (parseSqlBackup/parseCsvZipBackup), so comparing it
  // to a fresh recompute is a self-comparison that is always true — it verifies
  // nothing. The restore path already skips the checksum for those formats; report
  // it honestly here too via `checksumSupported` instead of a false "VALID".
  const fmt = backup.metadata.format ?? 'json';
  const checksumSupported = fmt === 'json' || fmt === 'bak';
  const checksumValid = checksumSupported
    ? computeBackupChecksum(backup.data) === backup.metadata.checksum
    : false;

  const tableSummary: Record<string, number> = {};
  for (const [key, value] of Object.entries(backup.data)) {
    if (Array.isArray(value)) tableSummary[key] = value.length;
  }

  return {
    // json/bak: a tampered file (checksum mismatch) is NOT valid. SQL/CSV: no
    // independent checksum exists, but a parseable file is still restorable.
    valid: checksumSupported ? checksumValid : true,
    metadata: backup.metadata,
    tableSummary,
    checksumValid,
    checksumSupported,
    totalRecords: Object.values(tableSummary).reduce((s, n) => s + n, 0),
  };
}
