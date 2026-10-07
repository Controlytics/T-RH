import { describe, it, expect, vi } from 'vitest';
import { createReport } from '../pdf-report';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * The HEADER block of every report — the headless parameter table (Block /
 * Area / … against the period on the Data Report, the Alarms page report and
 * the trend page's Instrument Alarms report) — is ruled DARK (operator,
 * 2026-10-05: "make all the reports headers tables lines into dark"). The
 * record tables beneath keep their light rules; a headed table is records,
 * a headless one is the form at the top.
 *
 * Asserted on autotable's resolved cells, the same way the spans are pinned.
 */
const chrome = { title: 't', orientation: 'portrait' as const, reportKey: 'x', formatDateTime: (d: string) => d };
const DARK = [15, 23, 42];
const LIGHT = [226, 232, 240];

describe('report table rules', () => {
  it('a headless (header) table is ruled dark on every cell', async () => {
    const report = await createReport(chrome);
    report.addTable({ body: [['Block :', 'CWH Block', 'Start Date :', '2026-05-27'], ['Area :', 'QC 3', 'Start Time :', '16:00']] });
    const t = (report.doc as any).lastAutoTable;
    for (const row of t.body) for (const c of Object.values(row.cells) as any[]) {
      expect(c.styles.lineColor).toEqual(DARK);
      expect(c.styles.lineWidth).toBe(0.2);
    }
  });

  it('a headed (records) table keeps its light rules', async () => {
    const report = await createReport(chrome);
    report.addTable({ head: ['Type', 'Raised'], body: [['High Temperature', '2026-05-28 12:02']] });
    const t = (report.doc as any).lastAutoTable;
    for (const c of Object.values(t.body[0].cells) as any[]) expect(c.styles.lineColor).toEqual(LIGHT);
  });

  it('a replayed snapshot rules its header block dark too', async () => {
    const first = await createReport(chrome);
    first.addTable({ body: [['Block :', 'CWH Block', 'Start Date :', '2026-05-27']] });
    const snap = first.getSnapshot();
    const { renderSnapshotToPdf } = await import('../pdf-report');
    const again = await renderSnapshotToPdf(snap, { formatDateTime: (d: string) => d });
    const t = (again.doc as any).lastAutoTable;
    for (const c of Object.values(t.body[0].cells) as any[]) expect(c.styles.lineColor).toEqual(DARK);
  });
});

/**
 * ONE header-block style for EVERY report (operator, 2026-10-05: "make all
 * reports header table same only dont put any differences like table lines
 * and font styles bold everything"; 2026-10-06: "in all reports headers
 * values should be not bold, only key should bold"): dark rules, one size,
 * the LABEL columns bold and the VALUE columns regular — whatever typography
 * the report itself prints its records at.
 */
const weightOf = (cells: any[]) => cells.map((c) => c.styles.fontStyle);
describe('one header block for every report', () => {
  it('a headless table bolds its label columns and NOT its values, at HEADER_BLOCK_PT, in a default-typography report', async () => {
    const { HEADER_BLOCK_PT } = await import('../pdf-report');
    const report = await createReport(chrome);
    report.addTable({ body: [['Block :', 'CWH Block', 'Start Date :', '2026-05-27']], columnStyles: { 0: { cellWidth: 32, fontStyle: 'bold' }, 1: { cellWidth: 59 }, 2: { cellWidth: 32, fontStyle: 'bold' }, 3: { cellWidth: 59 } } });
    const cells = Object.values((report.doc as any).lastAutoTable.body[0].cells) as any[];
    expect(cells).toHaveLength(4);
    expect(weightOf(cells)).toEqual(['bold', 'normal', 'bold', 'normal']);
    for (const c of cells) {
      expect(c.styles.fontSize).toBe(HEADER_BLOCK_PT);
      expect(c.styles.lineColor).toEqual(DARK);
    }
  });

  it('...and exactly the same in a report that prints its records larger (the Data Report), whatever the caller styled', async () => {
    const { HEADER_BLOCK_PT } = await import('../pdf-report');
    const report = await createReport({ ...chrome, typography: { tablePt: 10, tableHeadPt: 10.5, labelPt: 10 } });
    // A caller bolding a VALUE column (or none at all) still gets the one rule.
    report.addTable({ body: [['Block :', 'CWH Block', 'Start Date :', '2026-05-27']], columnStyles: { 1: { fontStyle: 'bold' } } });
    const cells = Object.values((report.doc as any).lastAutoTable.body[0].cells) as any[];
    expect(weightOf(cells)).toEqual(['bold', 'normal', 'bold', 'normal']);
    for (const c of cells) expect(c.styles.fontSize).toBe(HEADER_BLOCK_PT);
    expect(HEADER_BLOCK_PT).toBe(11); // 10 until 2026-10-07
  });

  it("a spanning value cell (the Data Report's lone Interval row) is regular too", async () => {
    const report = await createReport(chrome);
    report.addTable({ body: [['Interval :', { content: 'Raw (every reading)', colSpan: 3 }]] });
    const cells = Object.values((report.doc as any).lastAutoTable.body[0].cells) as any[];
    expect(weightOf(cells)).toEqual(['bold', 'normal']);
  });

  it('a headed (records) table is NOT bolded by this rule', async () => {
    const report = await createReport(chrome);
    report.addTable({ head: ['Type', 'Raised'], body: [['High Temperature', '2026-05-28 12:02']] });
    for (const c of Object.values((report.doc as any).lastAutoTable.body[0].cells) as any[]) expect(c.styles.fontStyle).toBe('normal');
  });
});
