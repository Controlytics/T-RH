import { describe, it, expect, vi } from 'vitest';
import { createReport } from '../pdf-report';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * `addTable({ unboxEmpty })` (operator, 2026-09-07: *"when values are disabled
 * then boxes are empty right in reports, if value was not there dont show
 * that boxes in report"*). A parameter block is a form; a cell with nothing in
 * it — the Max / Min pair of a slot with no bound in force, the blank left half
 * of the Interval row — must not be drawn as an empty box, which reads as a
 * field somebody forgot to fill. autotable draws every cell's own border, so a
 * cell with `lineWidth` 0 draws none; the neighbours keep theirs.
 *
 * Asserted on autotable's resolved cell styles (`doc.lastAutoTable`), the same
 * way the Data Report's bold cells are pinned.
 */
const chrome = { title: 't', orientation: 'portrait' as const, reportKey: 'x', formatDateTime: (d: string) => d };
const body = [
  ['A :', '1', '', ''],
  ['', '', 'B :', '2'],
  ['C :', '-', 'D :', ' '],
];
const widths = (report: any) => report.doc.lastAutoTable.body.map((r: any) =>
  [0, 1, 2, 3].map((c) => r.cells[c].styles.lineWidth));

describe('addTable unboxEmpty', () => {
  it('draws no border on an empty body cell, and keeps every other cell boxed', async () => {
    const report = await createReport(chrome);
    report.addTable({ body, unboxEmpty: true });
    expect(widths(report)).toEqual([
      [0.2, 0.2, 0, 0],
      [0, 0, 0.2, 0.2],
      // A dash IS a value; whitespace is not.
      [0.2, 0.2, 0.2, 0],
    ]);
  });

  it('is opt-in — a table not asking for it boxes every cell as before', async () => {
    const report = await createReport(chrome);
    report.addTable({ body });
    expect(widths(report).flat().every((w: number) => w === 0.2)).toBe(true);
  });

  it('survives the snapshot, so a re-rendered report draws the same boxes', async () => {
    const report = await createReport(chrome);
    report.addTable({ body, unboxEmpty: true });
    report.addTable({ body });
    const sections = report.getSnapshot().sections as any[];
    expect(sections[0].unboxEmpty).toBe(true);
    expect(sections[1].unboxEmpty).toBeUndefined();
  });

  it('combines with per-cell bold', async () => {
    const report = await createReport(chrome);
    report.addTable({ body, unboxEmpty: true, bold: [[false, true, false, false], [false, false, false, false], [false, false, false, false]] });
    const t = (report.doc as any).lastAutoTable;
    expect(t.body[0].cells[1].styles.fontStyle).toBe('bold');
    expect(t.body[0].cells[2].styles.lineWidth).toBe(0);
  });
});
