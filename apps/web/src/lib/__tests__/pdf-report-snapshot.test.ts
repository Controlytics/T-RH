import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReport, renderSnapshotToPdf, normaliseSnapshot } from '../pdf-report';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * Snapshot v2 (2026-09-07): the renderer records EVERY drawing call, and the
 * same renderer replays the record. This is what lets a report request be
 * reviewed and later downloaded as the same document: the approver's DRAFT and
 * the approved copy are both replays of one frozen snapshot, so what was
 * reviewed is what is downloaded. Design:
 * docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 *
 * Asserted on autotable's resolved cells (`doc.lastAutoTable`), jsPDF's page
 * count, a spy on `addImage`, and the page text — the same techniques the
 * Data Report tests use.
 */
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const formatDateTime = (d: string) => d.slice(0, 16).replace('T', ' ');
const chrome = {
  title: 'Temperature and RH Data Report', subtitle: 'CWH/RDU/001-00', orientation: 'portrait' as const,
  reportKey: 'Instrument Time Series', formatDateTime,
  legend: [{ abbr: 'NMT', meaning: 'Not More Than' }],
  typography: { tablePt: 9, tableHeadAlign: 'center' as const },
  showAppName: false,
};

/** Every text the document draws, page by page. */
function pageTexts(doc: any): string[] {
  const pages = (doc.internal.pages as string[][]).filter(Boolean);
  return pages.map((p) => [...p.join('\n').matchAll(/\((.*?)\)\s*Tj/gs)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' '));
}

async function build() {
  const report = await createReport(chrome);
  report.addSectionTitle('Readings');
  report.addTable({
    body: [['Block :', { content: 'CWH Block', colSpan: 3 }], ['Temp. Limit :', 'NMT 25.0', 'RH Limit :', 'NA']],
    columnStyles: { 0: { cellWidth: 30 } },
  });
  report.addNote('REPRESENTATIVE SAMPLE: 2 of 3 stored values.', 'red');
  report.addImage(PNG_1x1, 100, 40);
  report.newPage();
  report.addSectionTitle('Period summary');
  report.addKeyValue([['Instrument', 'CWH/RDU/001-00'], ['Period', 'Custom']], 2);
  report.addTable({ head: ['DATE', 'TIME'], body: [['2026-08-24', '00:20'], ['2026-08-24', '00:10']], bold: [[false, true], [false, false]] });
  return report;
}

describe('ReportSnapshot v2', () => {
  let addImage: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const jspdf: any = await import('jspdf');
    addImage = vi.fn(jspdf.default.API.addImage);
    jspdf.default.API.addImage = addImage;
  });

  it('records every drawing call in order, with the chrome that shaped the page', async () => {
    const report = await build();
    const snap = report.getSnapshot();
    expect(snap.version).toBe(2);
    expect(snap.reportType).toBe('Instrument Time Series');
    expect(snap.title).toBe('Temperature and RH Data Report');
    expect(snap.config).toEqual({ legend: chrome.legend, typography: chrome.typography, showAppName: false });
    expect(snap.sections.map((s) => s.kind)).toEqual(['table', 'note', 'image', 'page-break', 'pairs', 'table']);
    // A title followed by a table rides on the table (as before); one followed
    // by a pairs block rides on the pairs block.
    expect((snap.sections[0] as any).title).toBe('Readings');
    expect((snap.sections[4] as any).title).toBe('Period summary');
    expect((snap.sections[0] as any).body[0]).toEqual(['Block :', { content: 'CWH Block', colSpan: 3 }]);
    expect((snap.sections[1] as any)).toEqual({ kind: 'note', text: 'REPRESENTATIVE SAMPLE: 2 of 3 stored values.', color: 'red' });
    expect((snap.sections[2] as any)).toEqual({ kind: 'image', dataUrl: PNG_1x1, widthMm: 100, heightMm: 40 });
    expect((snap.sections[5] as any).bold).toEqual([[false, true], [false, false]]);
  });

  it('records a title with nothing after it as its own section', async () => {
    const report = await createReport(chrome);
    report.addSectionTitle('Nothing follows');
    expect(report.getSnapshot().sections).toEqual([{ kind: 'title', text: 'Nothing follows' }]);
  });

  it('replays to the same document: pages, cells, bold, image', async () => {
    const original = await build();
    const originalPages = original.doc.getNumberOfPages();
    const originalTable = (original.doc as any).lastAutoTable;
    addImage.mockClear();

    const replay = await renderSnapshotToPdf(original.getSnapshot(), { formatDateTime });
    expect(replay.doc.getNumberOfPages()).toBe(originalPages);
    const t = (replay.doc as any).lastAutoTable;
    expect(t.body.map((r: any) => Object.values(r.cells).map((c: any) => c.text.join(''))))
      .toEqual(originalTable.body.map((r: any) => Object.values(r.cells).map((c: any) => c.text.join(''))));
    expect(t.body[0].cells[1].styles.fontStyle).toBe('bold');
    expect(t.body[1].cells[1].styles.fontStyle).toBe('normal');
    // The chart raster went in once, with the same bytes.
    expect(addImage.mock.calls.filter((c) => c[0] === PNG_1x1)).toHaveLength(1);
    // And the chrome came along: the legend prints, the app name does not.
    replay.save('x.pdf');
    const text = pageTexts(replay.doc).join(' ');
    expect(text).toContain('NMT = Not More Than');
  });

  it('DRAFT: watermarks every page and prints no signature — on the path the approver actually opens', async () => {
    // `openDraft` never calls `save()`; it hands the document to a new tab as a
    // blob URL. The watermark and the page numbers are painted by the same
    // finalisation `save()` runs, so the blob path must run it too (review,
    // 2026-09-07: the approver's tab opened clean, unpaginated, unwatermarked).
    const createObjectURL = vi.fn(() => 'blob:draft-url');
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }));
    const original = await build();
    const draft = await renderSnapshotToPdf(original.getSnapshot(), { formatDateTime, draft: true });
    expect(draft.toBlobUrl()).toBe('blob:draft-url');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    const pages = pageTexts(draft.doc);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) expect(p).toContain('DRAFT');
    expect(pages[0]).toContain('Page 1 of');
    expect(pages.join(' ')).not.toContain('Requested By');
    expect(pages.join(' ')).not.toContain('Printed By');
  });

  it('APPROVED: prints the signature TABLE — signers across the top, Name / Role / Date & Time down the left — and no watermark', async () => {
    // Operator, 2026-09-25: "name, role, date & Time should come one below
    // one, headings should be one row left side and reviewed by and approved
    // by on top side by side".
    const original = await build();
    const approved = await renderSnapshotToPdf(original.getSnapshot(), {
      formatDateTime,
      signatureTable: [
        { label: 'Reviewed By', name: 'rrq', role: 'QA', dateTime: '2026-09-07 14:02' },
        { label: 'Approved By', name: 'rra', role: 'QA_MANAGER', dateTime: '2026-09-07 15:10' },
      ],
    });
    approved.save('approved.pdf');
    const text = pageTexts(approved.doc).join(' ');
    for (const word of ['Reviewed By', 'Approved By', 'Name', 'Role', 'Date & Time', 'rrq', 'rra', 'QA', 'QA_MANAGER', '2026-09-07 14:02', '2026-09-07 15:10']) {
      expect(text).toContain(word);
    }
    // The old line form is gone.
    expect(text).not.toContain('Requested By:');
    expect(text).not.toContain('DRAFT');
  });

  it('the old line signatures still print when a caller passes them', async () => {
    const original = await build();
    const approved = await renderSnapshotToPdf(original.getSnapshot(), {
      formatDateTime,
      signatures: [{ label: 'Printed By', value: 'someone' }],
    });
    // The end block is painted at FINALISATION (save / toBlobUrl), not before.
    approved.save('lines.pdf');
    expect(pageTexts(approved.doc).join(' ')).toContain('Printed By: someone');
  });

  it('normaliseSnapshot accepts only version 2', () => {
    expect(() => normaliseSnapshot({ version: 1, title: 'x', sections: [] })).toThrow(/version/);
    expect(() => normaliseSnapshot(null)).toThrow();
    const ok = { version: 2, reportType: 'Alarms', title: 'ALARM REPORT', config: {}, sections: [] };
    expect(normaliseSnapshot(ok)).toEqual(ok);
  });
});
