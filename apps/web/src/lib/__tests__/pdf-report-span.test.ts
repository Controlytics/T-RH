import { describe, it, expect, vi } from 'vitest';
import { createReport } from '../pdf-report';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * `addTable` body cells may SPAN columns (2026-09-07). A parameter block is a
 * form; when a slot has no bound in force its Max / Min pair is gone, and the
 * remaining pair must fill the row rather than leave two empty cells beside it.
 * The first attempt at "no empty box" (operator: *"if value was not there dont
 * show that boxes in report"*) drew the empty cells with no border, and the
 * operator's next message was *"table was not forming properly"* — the block's
 * outline had open corners, and the alarm table lost its right edge on the row
 * with a switched-off bound. A span keeps the table a rectangle: there is no
 * empty cell to draw or not draw.
 *
 * Asserted on autotable's resolved cells (`doc.lastAutoTable`), the same way
 * the Data Report's bold cells are pinned.
 */
const chrome = { title: 't', orientation: 'portrait' as const, reportKey: 'x', formatDateTime: (d: string) => d };

describe('addTable column spans', () => {
  it('applies a colSpan cell, so the row has fewer, wider cells and no gap', async () => {
    const report = await createReport(chrome);
    report.addTable({ body: [['A :', { content: '1', colSpan: 3 }], ['B :', '2', 'C :', '3']] });
    const t = (report.doc as any).lastAutoTable;
    expect(Object.keys(t.body[0].cells)).toHaveLength(2);
    expect(t.body[0].cells[1].colSpan).toBe(3);
    expect(Object.keys(t.body[1].cells)).toHaveLength(4);
    // Every drawn cell keeps its border — nothing is unboxed.
    for (const row of t.body) for (const c of Object.values(row.cells) as any[]) expect(c.styles.lineWidth).toBe(0.2);
  });

  it('keeps the span in the snapshot, so a re-rendered report lays out the same', async () => {
    const report = await createReport(chrome);
    report.addTable({ body: [['A :', { content: '1', colSpan: 3 }]] });
    const sections = report.getSnapshot().sections as any[];
    expect(sections[0].body[0]).toEqual(['A :', { content: '1', colSpan: 3 }]);
  });

  it('has no unboxEmpty option any more', async () => {
    // The unboxing primitive lasted an hour on 2026-09-07 and was replaced by
    // spans; a table with a hidden border is the defect this test guards against.
    const report = await createReport(chrome);
    report.addTable({ body: [['A :', '', '', '']] });
    const t = (report.doc as any).lastAutoTable;
    for (const c of Object.values(t.body[0].cells) as any[]) expect(c.styles.lineWidth).toBe(0.2);
    expect((report.getSnapshot().sections[0] as any).unboxEmpty).toBeUndefined();
  });
});
