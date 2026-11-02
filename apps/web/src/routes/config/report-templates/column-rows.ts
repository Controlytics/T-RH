import type { ReportField, ReportTemplateColumn } from '@digilog/shared';

/**
 * The Columns section's rows: the template's own columns in their stored order,
 * then every catalogue field the template does not name yet, offered HIDDEN.
 *
 * `keep` decides what a save writes. A column that was in the stored document
 * is always kept — including one whose field the profile no longer has (a key
 * removed from the profile): it prints as an empty, named "not available"
 * column, it is never dropped silently (spec §6, review focus 1). A catalogue
 * field nobody touched is NOT written: a profile with many keys and attributes
 * would otherwise fill the document with hidden rows up to the 100-column cap
 * and every save would be refused. Touching a row (Show, heading, decimals,
 * unit) keeps it.
 *
 * The rows are keyed by `id` — the schema refuses a document that names one
 * twice, so the id follows the row through every reorder.
 */
export interface ColumnRow {
  id: string;
  heading: string;
  show: boolean;
  decimals?: number;
  unit?: string;
  keep: boolean;
}

export function rowsFromColumns(columns: readonly ReportTemplateColumn[]): ColumnRow[] {
  return columns.map((c) => ({
    id: c.id,
    heading: c.heading,
    show: c.show,
    ...(c.decimals !== undefined ? { decimals: c.decimals } : {}),
    ...(c.unit !== undefined ? { unit: c.unit } : {}),
    keep: true,
  }));
}

/**
 * Appends the catalogue's fields the rows do not have yet, hidden and headed
 * by the field's label. Returns the SAME array when there is nothing to add, so
 * an effect that merges on every catalogue revalidation settles.
 */
export function withCatalogue(rows: ColumnRow[], fields: readonly ReportField[]): ColumnRow[] {
  const have = new Set(rows.map((r) => r.id));
  const extra = fields.filter((f) => !have.has(f.id));
  if (extra.length === 0) return rows;
  return [...rows, ...extra.map((f) => ({ id: f.id, heading: f.label, show: false, keep: false }))];
}

/** What a save writes, in row order. */
export function columnsFromRows(rows: readonly ColumnRow[]): ReportTemplateColumn[] {
  return rows.filter((r) => r.keep).map((r) => ({
    id: r.id,
    heading: r.heading,
    show: r.show,
    ...(r.decimals !== undefined ? { decimals: r.decimals } : {}),
    ...(r.unit !== undefined && r.unit.trim() !== '' ? { unit: r.unit } : {}),
  }));
}

export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows.slice();
  const next = rows.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
