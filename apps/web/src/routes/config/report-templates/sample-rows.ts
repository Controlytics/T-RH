import type { ReportField } from '@digilog/shared';

/**
 * The rows the Report Templates PREVIEW prints (2026-11-02): three rows of
 * placeholder values, one value per catalogue field, typed by the field's
 * `kind`. They are not readings and never pretend to be — a text cell reads
 * "<label> 1", so a reviewer cannot mistake the preview for a real report.
 *
 * A datetime cell is a STRING, already formatted — `buildWidgetReport` takes
 * rows "already formatted by the caller's datetime hook", and the preview's
 * caller passes the application's own formatter so the preview prints dates
 * the way the real download will.
 */
export type SampleRow = Record<string, string | number | null>;

const NUMBERS = [21.5, 22.25, 23.75];
const STATUSES = ['Normal', 'Normal', 'High'];
/** Three instants a quarter of an hour apart, on a fixed day — not "now", so a preview is reproducible. */
const INSTANTS = ['2026-11-02T09:00:00.000Z', '2026-11-02T09:15:00.000Z', '2026-11-02T09:30:00.000Z'];

export function sampleRowsFor(
  fields: readonly ReportField[],
  formatDateTime: (iso: string) => string = (iso) => iso,
): SampleRow[] {
  return [0, 1, 2].map((i) => {
    const row: SampleRow = {};
    let n = 0;
    for (const f of fields) {
      switch (f.kind) {
        // Each number column its own figures (21.5, 31.5, 41.5 …), so two keys
        // side by side do not read as one value printed twice.
        case 'number': row[f.id] = NUMBERS[i]! + 10 * n++; break;
        case 'datetime': row[f.id] = formatDateTime(INSTANTS[i]!); break;
        case 'status': row[f.id] = STATUSES[i]!; break;
        default: row[f.id] = `${f.label} ${i + 1}`;
      }
    }
    return row;
  });
}
