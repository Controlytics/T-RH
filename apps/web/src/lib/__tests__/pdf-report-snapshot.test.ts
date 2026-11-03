import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { builtinReportTemplate } from '@digilog/shared';
import {
  createReport, renderSnapshotToPdf, normaliseSnapshot, imageFormatOf, loadReportChrome, REPORT_TITLES_UNREADABLE,
  REPORT_BRANDING_UNREADABLE, type ReportChrome,
} from '../pdf-report';
import { BRANDING_LOGO_PNG, brandingFetch, stubBrandingFetch } from '@/test-support/branding-stub';

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
    // A report made now reads Branding and its logo, and refuses when it cannot (ruling F-1).
    stubBrandingFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('records every drawing call in order, with the chrome that shaped the page', async () => {
    const report = await build();
    const snap = report.getSnapshot();
    // v3 since 2026-11-03: every report freezes the chrome it was drawn with.
    expect(snap.version).toBe(3);
    expect(snap.reportType).toBe('Instrument Time Series');
    expect(snap.title).toBe('Temperature and RH Data Report');
    // The WHOLE resolved scale is frozen (2026-10-07), so a replay prints at the
    // sizes reviewed even after the shared default moves.
    const { DEFAULT_TYPOGRAPHY } = await import('../pdf-report');
    expect(snap.config).toEqual({ legend: chrome.legend, typography: { ...DEFAULT_TYPOGRAPHY, ...chrome.typography }, showAppName: false });
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
    // Draft rendering has had NO caller since 2026-10-01 (`openDraft` and View draft removed); kept as a renderer capability. It never calls `save()`; it hands the document to a new tab as a
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

  it('a snapshot stored before 2026-10-07 replays at the scale it was reviewed at, not the new default', async () => {
    // Before 2026-10-07 a snapshot froze only the keys its report OVERRODE.
    // Merged over today's larger, bold default it would re-flow a document an
    // approver already signed; its gaps are filled from the frozen legacy scale.
    const { LEGACY_TYPOGRAPHY_2026_10_06 } = await import('../pdf-report');
    const old = {
      version: 2 as const, reportType: 'Alarms', title: 'ALARM REPORT', orientation: 'portrait' as const,
      config: { typography: { tablePt: 9 } },
      sections: [
        { kind: 'table' as const, head: [], body: [['Start Date :', '2026-10-06', 'End Date :', '2026-10-06']] },
        { kind: 'table' as const, head: ['DATE', 'TIME'], body: [['2026-10-06', '00:00']] },
      ],
    };
    const replay = await renderSnapshotToPdf(normaliseSnapshot(old), { formatDateTime });
    const stream = (replay.doc.internal as any).pages.filter(Boolean).flat().join('\n');
    const at = stream.indexOf('(ALARM REPORT) Tj');
    const tf = [...stream.slice(0, at).matchAll(/\/F(\d) ([\d.]+) Tf/g)].pop()!;
    expect(tf[1]).toBe('1'); // regular, as it was
    expect(Number(tf[2])).toBe(LEGACY_TYPOGRAPHY_2026_10_06.titlePt);
    const records = (replay.doc as any).lastAutoTable;
    const cell = Object.values(records.body[0].cells)[0] as any;
    expect(cell.styles.fontSize).toBe(9); // its own override survives
    expect(cell.styles.cellPadding).toEqual({ top: 2.5, bottom: 2.5, left: LEGACY_TYPOGRAPHY_2026_10_06.cellPadX, right: LEGACY_TYPOGRAPHY_2026_10_06.cellPadX });
    // ...and a NEW snapshot carries its whole scale, so it is immune to the next change.
    const fresh = (await build()).getSnapshot();
    expect(Object.keys(fresh.config.typography ?? {}).sort()).toEqual(Object.keys(LEGACY_TYPOGRAPHY_2026_10_06).sort());
  });

  it('normaliseSnapshot accepts version 2 and a v3 with its chrome — nothing else', () => {
    expect(() => normaliseSnapshot({ version: 1, title: 'x', sections: [] })).toThrow(/version/);
    expect(() => normaliseSnapshot({ version: 4, title: 'x', sections: [] })).toThrow(/version/);
    expect(() => normaliseSnapshot(null)).toThrow();
    const ok = { version: 2, reportType: 'Alarms', title: 'ALARM REPORT', config: {}, sections: [] };
    expect(normaliseSnapshot(ok)).toEqual(ok);
    const v3 = { version: 3, reportType: 'Widget: Gauge', title: 'Gauge', config: {}, sections: [], chrome: FROZEN };
    expect(normaliseSnapshot(v3)).toEqual(v3);
    // A v3 WITHOUT a well-formed chrome would replay by fetching today's
    // branding — the very thing v3 exists to prevent — so it is refused.
    expect(() => normaliseSnapshot({ ...v3, chrome: undefined })).toThrow(/chrome/);
    expect(() => normaliseSnapshot({ ...v3, chrome: { ...FROZEN, companyName: 7 } })).toThrow(/chrome/);
    expect(() => normaliseSnapshot({ ...v3, chrome: { ...FROZEN, logoDataUrl: undefined } })).toThrow(/chrome/);
    expect(() => normaliseSnapshot({ ...v3, chrome: { ...FROZEN, footer: null } })).toThrow(/chrome/);
  });
});

/** A 1x1 PNG, the custom / frozen logo of the v3 tests. */
const FROZEN: ReportChrome = {
  companyName: 'Frozen Pharma Ltd',
  appName: 'Frozen Monitor',
  showAppName: true,
  logoDataUrl: PNG_1x1,
  footer: { showPageNumbers: true, showPrintedBy: true, showPrintedAt: true, signatureLine: false },
  orientation: 'landscape',
};

/** Every `fetch` and every Report Page Titles read is a failure on these paths. */
function forbidFetch() {
  const fetchSpy = vi.fn(async (url: unknown) => { throw new Error(`fetch(${String(url)}) on a frozen-chrome path`); });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

async function titlesReads(): Promise<unknown[][]> {
  const { apiClient } = await import('@/lib/api-client');
  return (apiClient.get as any).mock.calls.filter((c: unknown[]) => String(c[0]).includes('report-page-titles'));
}

/**
 * ReportSnapshot v3 (2026-11-02, widget report templates): a report drawn from
 * a template's CHROME — company, app name, logo, accent, footer, orientation —
 * freezes that chrome in the snapshot, and the replay draws from it and
 * fetches NOTHING. Since 2026-11-03 every report is v3 (see the describe
 * below); a v2 snapshot stored before then replays as before. Spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §8, §12.
 */
describe('ReportSnapshot v3 — the chrome is frozen', () => {
  let addImage: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const jspdf: any = await import('jspdf');
    addImage = vi.fn(jspdf.default.API.addImage);
    jspdf.default.API.addImage = addImage;
    const { apiClient } = await import('@/lib/api-client');
    (apiClient.get as any).mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function buildV3(chrome: ReportChrome = FROZEN) {
    const report = await createReport({ title: 'Gauge', subtitle: 'Plant · Latest', formatDateTime, reportKey: 'Widget: Gauge', chrome });
    report.addKeyValue([['Selection', 'QC Block'], ['Instruments', '2']]);
    report.addTable({ head: ['Instrument ID', 'Value'], body: [['CWH/RDU/001-00', '21.5'], ['CWH/RDU/002-00', '22.0']] });
    report.newPage();
    report.addNote('Not available for this profile: Pressure', 'muted');
    return report;
  }

  it('draws from the chrome it is given, fetches nothing, and freezes that chrome as v3', async () => {
    const fetchSpy = forbidFetch();
    const report = await buildV3();
    const snap = report.getSnapshot();
    expect(snap.version).toBe(3);
    expect(snap.chrome).toEqual(FROZEN);
    expect(snap.reportType).toBe('Widget: Gauge');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await titlesReads()).toEqual([]);
    // The logo drawn is the chrome's, in the format its BYTES name.
    expect(addImage.mock.calls.filter((c) => c[0] === PNG_1x1 && c[1] === 'PNG')).toHaveLength(1);
    // The orientation is the chrome's.
    expect(report.pw).toBeGreaterThan(report.ph);
    report.save('v3.pdf');
    const text = pageTexts(report.doc).join(' ');
    expect(text).toContain('Frozen Pharma Ltd');
    expect(text).toContain('Frozen Monitor');
  });

  it('a v3 snapshot REPLAYS without a single fetch: same names, same logo, same pages', async () => {
    const original = await buildV3();
    const pages = original.doc.getNumberOfPages();
    // Through JSON, as it is stored and served.
    const stored = normaliseSnapshot(JSON.parse(JSON.stringify(original.getSnapshot())));
    const fetchSpy = forbidFetch();
    const { apiClient } = await import('@/lib/api-client');
    (apiClient.get as any).mockClear();
    addImage.mockClear();

    const replay = await renderSnapshotToPdf(stored, { formatDateTime });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await titlesReads()).toEqual([]);
    expect(addImage.mock.calls.filter((c) => c[0] === PNG_1x1 && c[1] === 'PNG')).toHaveLength(1);
    expect(replay.doc.getNumberOfPages()).toBe(pages);
    expect(replay.pw).toBeGreaterThan(replay.ph);
    // The replay is itself a v3 record of the same chrome.
    expect(replay.getSnapshot().chrome).toEqual(FROZEN);
    replay.save('v3-replay.pdf');
    const text = pageTexts(replay.doc).join(' ');
    expect(text).toContain('Frozen Pharma Ltd');
    expect(text).toContain('Frozen Monitor');
    expect(text).not.toContain('Controlytics AI Pvt Ltd');
  });

  it('a report given no chrome resolves TODAY\'s chrome up front and freezes it too (v3 for every report, 2026-11-03)', async () => {
    stubBrandingFetch();
    const original = await build();
    const snap = original.getSnapshot();
    expect(snap.version).toBe(3);
    expect(snap.chrome?.showAppName).toBe(false);
    expect(snap.chrome?.orientation).toBe('portrait');
    // Its replay draws from that frozen chrome: nothing is fetched.
    const fetchSpy = forbidFetch();
    const replay = await renderSnapshotToPdf(normaliseSnapshot(JSON.parse(JSON.stringify(snap))), { formatDateTime });
    expect(replay.doc.getNumberOfPages()).toBe(original.doc.getNumberOfPages());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replay.getSnapshot().chrome).toEqual(snap.chrome);
  });

  it('the footer flags hide only the GENERATOR\'s own lines; text, signature line, remarks label and legend print', async () => {
    forbidFetch();
    const report = await createReport({
      title: 'Gauge', formatDateTime,
      chrome: {
        ...FROZEN, orientation: 'portrait',
        footer: { text: 'Controlled copy - do not photocopy', showPageNumbers: false, showPrintedBy: false, showPrintedAt: false, signatureLine: true },
        remarksLabel: 'Reviewer notes', legend: 'NA = Not Applicable',
      },
    });
    report.addTable({ head: ['A'], body: [['1']] });
    report.newPage();
    report.addTable({ head: ['A'], body: [['2']] });
    report.save('footer.pdf');
    const pages = pageTexts(report.doc);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) expect(p).toContain('Controlled copy - do not photocopy');
    const all = pages.join(' ');
    expect(all).not.toContain('Page 1 of');
    expect(all).not.toContain('Printed By');
    expect(all).not.toContain('Printed Date & Time');
    expect(all).toContain('Signature:');
    expect(all).toContain('Reviewer notes:');
    expect(all).not.toContain('Remarks:');
    expect(all).toContain('NA = Not Applicable');
  });

  it('the default footer of a chrome prints exactly what a page report prints', async () => {
    forbidFetch();
    const report = await createReport({ title: 'Gauge', formatDateTime, chrome: FROZEN });
    report.addTable({ head: ['A'], body: [['1']] });
    report.save('footer-default.pdf');
    const all = pageTexts(report.doc).join(' ');
    for (const w of ['Page 1 of 1', 'Printed By', 'Printed Date & Time', 'Remarks:']) expect(all).toContain(w);
    expect(all).not.toContain('Signature:');
  });

  it('no footer flag can take the e-signatures off an approved copy, or the DRAFT mark off a draft', async () => {
    const chrome: ReportChrome = { ...FROZEN, footer: { showPageNumbers: false, showPrintedBy: false, showPrintedAt: false, signatureLine: true } };
    forbidFetch();
    const snap = (await buildV3(chrome)).getSnapshot();
    const approved = await renderSnapshotToPdf(snap, {
      formatDateTime,
      signatureTable: [{ label: 'Approved By', name: 'rra', role: 'QA_MANAGER', dateTime: '2026-11-02 15:10' }],
    });
    approved.save('approved-v3.pdf');
    const a = pageTexts(approved.doc);
    for (const w of ['Approved By', 'rra', 'QA_MANAGER']) expect(a.join(' ')).toContain(w);
    // A wet-ink line under an e-signed record would invite a second signature.
    expect(a.join(' ')).not.toContain('Signature:');
    // "Page x of N" is the record's completeness mark (GDP): a signed copy
    // carries it on EVERY page whatever the template's flag says (review m6).
    a.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${a.length}`));

    const draft = await renderSnapshotToPdf(snap, { formatDateTime, draft: true });
    draft.save('draft-v3.pdf');
    const d = pageTexts(draft.doc);
    for (const p of d) expect(p).toContain('DRAFT');
    d.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${d.length}`));
    expect(d.join(' ')).not.toContain('Signature:');

    const lines = await renderSnapshotToPdf(snap, { formatDateTime, signatures: [{ label: 'Approved By', value: 'rra' }] });
    lines.save('lines-v3.pdf');
    expect(pageTexts(lines.doc)[0]).toContain('Page 1 of');
  });

  it('a footer text keeps the records clear of it: no table row reaches into the footer', async () => {
    forbidFetch();
    const report = await createReport({
      title: 'Gauge', formatDateTime,
      chrome: { ...FROZEN, orientation: 'portrait', footer: { ...FROZEN.footer, text: 'Controlled copy - do not photocopy' } },
    });
    report.addTable({ head: ['N'], body: Array.from({ length: 120 }, (_, i) => [String(i)]) });
    const table = (report.doc as any).lastAutoTable;
    const bottoms = table.body.map((r: any) => Object.values(r.cells).map((c: any) => c.y + c.height)).flat() as number[];
    // The footer rule moves up by the text's line (12mm + one 9.5pt line); a
    // row printed below 16.3mm from the edge would sit on the footer text.
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(report.ph - 16.3);
  });

  it('the accent colour paints the strip and the title bar', async () => {
    forbidFetch();
    const report = await createReport({ title: 'Gauge', formatDateTime, chrome: { ...FROZEN, accentColor: '#c0392b' } });
    const stream = (report.doc.internal as any).pages.filter(Boolean).flat().join('\n');
    // jsPDF writes an RGB fill as three 0..1 fractions, to two places
    // ("0.75 0.22 0.17 rg" for #c0392b).
    const rgb = [0xc0, 0x39, 0x2b].map((v) => v / 255);
    const ops = [...stream.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(ops.filter((o) => o.every((v, i) => Math.abs(v - rgb[i]) < 0.006)).length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Snapshot v3 for EVERY report (2026-11-03, page reports on templates — spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §9):
 * `createReport` resolves the chrome BEFORE drawing even when no template
 * gives one — Branding, Report Page Titles, the Branding logo's bytes, the
 * default footer — and `getSnapshot` freezes it. An approved page report then
 * replays with the names and logo it was signed under, fetching nothing. A v2
 * snapshot (every page report requested before this build) has no chrome and
 * still replays with today's Branding, exactly as before (plan Review Focus 1).
 */
describe('Snapshot v3 for every report — the chrome is resolved up front', () => {
  let addImage: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const jspdf: any = await import('jspdf');
    addImage = vi.fn(jspdf.default.API.addImage);
    jspdf.default.API.addImage = addImage;
    const { apiClient } = await import('@/lib/api-client');
    (apiClient.get as any).mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * The Branding logo's bytes: the SAME logo every Branding stub in this file
   * serves (`BRANDING_LOGO_PNG`). The logo is cached per page load once read,
   * so whichever test reads it first decides it for the rest of the file.
   */
  const PNG_BYTES = Uint8Array.from(atob(BRANDING_LOGO_PNG.split(',')[1]), (c) => c.charCodeAt(0));
  /** Today's Branding and its logo, as the public endpoint serves them. */
  function liveBranding(companyName = 'Live Branding Ltd') {
    const fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/api/config/branding')) return { ok: true, json: async () => ({ companyName, appName: 'Live Monitor', logoUrl: '/logo.png' }) };
      if (u === '/logo.png') return { ok: true, blob: async () => new Blob([PNG_BYTES], { type: 'image/png' }) };
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }
  const brandingCalls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.filter((c) => String(c[0]).endsWith('/api/config/branding'));

  it('(a) a report with NO chrome writes v3 with today\'s Branding, logo and the default footer frozen', async () => {
    liveBranding();
    const report = await createReport({ title: 'T', formatDateTime });
    report.addTable({ head: ['A'], body: [['1']] });
    const snap = report.getSnapshot();
    expect(snap.version).toBe(3);
    expect(snap.chrome).toEqual({
      companyName: 'Live Branding Ltd',
      appName: 'Live Monitor',
      showAppName: true,
      logoDataUrl: BRANDING_LOGO_PNG,
      footer: { showPageNumbers: true, showPrintedBy: true, showPrintedAt: true, signatureLine: false },
      orientation: 'portrait',
    });
    // The frozen record passes the ONE reader every stored snapshot goes through.
    expect(normaliseSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(JSON.parse(JSON.stringify(snap)));
    // `showAppName: false` and `orientation` given to the report reach its chrome.
    const quiet = await createReport({ title: 'T', formatDateTime, showAppName: false, orientation: 'landscape' });
    expect(quiet.getSnapshot().chrome).toMatchObject({ showAppName: false, orientation: 'landscape' });
    expect(quiet.pw).toBeGreaterThan(quiet.ph);
  });

  it('(b) its replay fetches NOTHING — the Branding of the day it was signed prints, not today\'s', async () => {
    liveBranding();
    const original = await createReport({ title: 'T', formatDateTime });
    original.addTable({ head: ['A'], body: [['1']] });
    const stored = normaliseSnapshot(JSON.parse(JSON.stringify(original.getSnapshot())));
    // Branding is re-branded since; every fetch is a failure on this path.
    const fetchSpy = forbidFetch();
    const { apiClient } = await import('@/lib/api-client');
    (apiClient.get as any).mockClear();
    addImage.mockClear();
    const replay = await renderSnapshotToPdf(stored, { formatDateTime });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await titlesReads()).toEqual([]);
    // The frozen logo is drawn from the snapshot's own bytes.
    expect(addImage.mock.calls.filter((c) => c[0] === BRANDING_LOGO_PNG)).toHaveLength(1);
    replay.save('v3-page-replay.pdf');
    const text = pageTexts(replay.doc).join(' ');
    expect(text).toContain('Live Branding Ltd');
    expect(text).toContain('Live Monitor');
    expect(text).not.toContain('Controlytics AI Pvt Ltd');
  });

  it('(c) a v2 snapshot stored before this build has no chrome: its replay DOES fetch today\'s Branding', async () => {
    const v2 = normaliseSnapshot({
      version: 2, reportType: 'alarms', title: 'ALARM REPORT', orientation: 'portrait',
      config: { showAppName: true }, sections: [{ kind: 'table', head: ['DATE'], body: [['2026-10-06']] }],
    });
    const fetchSpy = liveBranding('Branding Of Today Ltd');
    addImage.mockClear();
    const replay = await renderSnapshotToPdf(v2, { formatDateTime });
    expect(brandingCalls(fetchSpy).length).toBeGreaterThan(0);
    // The whole of today's chrome is read, as a v2 replay always did: the
    // Report Page Titles override, and the Branding logo, which is drawn.
    expect((await titlesReads()).length).toBeGreaterThan(0);
    expect(addImage.mock.calls.filter((c) => c[0] === BRANDING_LOGO_PNG)).toHaveLength(1);
    replay.save('v2-replay.pdf');
    expect(pageTexts(replay.doc).join(' ')).toContain('Branding Of Today Ltd');
    // A replay is itself drawn from a chrome, so its own snapshot is v3 of TODAY's
    // chrome (by design; nothing stores a replay's snapshot).
    expect(replay.getSnapshot().version).toBe(3);
    expect(replay.getSnapshot().chrome?.companyName).toBe('Branding Of Today Ltd');
  });

  /**
   * Ruling F-1 (2026-11-03): a chrome resolved for a report being made NOW is
   * frozen into its record, so a FAILED Report Page Titles read must refuse the
   * download — never freeze Branding's name where the administered override
   * belongs. Only a v2 replay (an old record) keeps the forgiving fallback.
   * Rejected BY URL: `createReport` also reads `/api/auth/me`, which must not
   * swallow a one-shot rejection.
   */
  async function titlesFail(): Promise<() => void> {
    const { apiClient } = await import('@/lib/api-client');
    (apiClient.get as any).mockImplementation(async (url: unknown) => {
      if (String(url).includes('report-page-titles')) throw new Error('503 Service Unavailable');
      return {};
    });
    return () => (apiClient.get as any).mockImplementation(async () => ({}));
  }

  it('(d) a report made with NO chrome REFUSES when Report Page Titles cannot be read — it never freezes Branding\'s name', async () => {
    liveBranding();
    const restore = await titlesFail();
    try {
      await expect(createReport({ title: 'T', formatDateTime })).rejects.toThrow(REPORT_TITLES_UNREADABLE);
      expect((await titlesReads()).length).toBe(1);
    } finally { restore(); }
  });

  it('(e) a TEMPLATE\'s chrome refuses the same way — unless the template names both itself, when nothing is read', async () => {
    liveBranding();
    const restore = await titlesFail();
    try {
      const doc = builtinReportTemplate('page:alarms');
      await expect(loadReportChrome(doc)).rejects.toThrow(REPORT_TITLES_UNREADABLE);
      const own = await loadReportChrome({ ...doc, header: { ...doc.header, companyName: 'Own Co', appName: 'Own App' } });
      expect(own).toMatchObject({ companyName: 'Own Co', appName: 'Own App' });
    } finally { restore(); }
  });

  it('(f) a v2 REPLAY still opens when Report Page Titles cannot be read: Branding\'s name, as it always did', async () => {
    const v2 = normaliseSnapshot({
      version: 2, reportType: 'alarms', title: 'ALARM REPORT', orientation: 'portrait',
      config: { showAppName: true }, sections: [{ kind: 'table', head: ['DATE'], body: [['2026-10-06']] }],
    });
    liveBranding('Branding Of Today Ltd');
    const restore = await titlesFail();
    try {
      const replay = await renderSnapshotToPdf(v2, { formatDateTime });
      expect((await titlesReads()).length).toBe(1);
      replay.save('v2-replay-titles-down.pdf');
      expect(pageTexts(replay.doc).join(' ')).toContain('Branding Of Today Ltd');
      expect(replay.getSnapshot().chrome).toMatchObject({ companyName: 'Branding Of Today Ltd', showAppName: true, orientation: 'portrait' });
    } finally { restore(); }
  });
});

describe('imageFormatOf — the BYTES decide, never the label', () => {
  it('names a PNG and a JPEG', () => {
    expect(imageFormatOf(PNG_1x1)).toBe('PNG');
    expect(imageFormatOf('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==')).toBe('JPEG');
  });
  it('a PNG uploaded under a .jpg name is a PNG; a PNG served as octet-stream is a PNG', () => {
    const payload = PNG_1x1.slice('data:image/png;base64,'.length);
    expect(imageFormatOf(`data:image/jpeg;base64,${payload}`)).toBe('PNG');
    expect(imageFormatOf(`data:application/octet-stream;base64,${payload}`)).toBe('PNG');
  });
  it('anything it cannot name falls back to JPEG, as jsPDF was always told', () => {
    expect(imageFormatOf('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe('JPEG');
    expect(imageFormatOf('not a data url')).toBe('JPEG');
  });
});

/**
 * Ruling F-1 EXTENDED (2026-11-03): a report being made freezes the CONFIGURED
 * chrome or nothing — a failed Branding read (names) or Branding-logo read
 * refuses it, as a failed Report Page Titles read does; a v2 REPLAY keeps every
 * old fallback (shipped names, no logo). A `custom` / `none` logo fetches
 * nothing and so cannot fail.
 *
 * LAST in this file, and on a FRESH module per test: the Branding logo is
 * cached per page load once read (`cachedLogoDataUrl`), so an earlier test's
 * logo would hide the failure. `vi.resetModules` hands each test a new
 * `pdf-report` (the api-client MOCK survives a reset, history and all).
 */
describe('Ruling F-1 extended — Branding and its logo', () => {
  async function fresh() {
    vi.resetModules();
    const pdf = await import('../pdf-report');
    const { apiClient } = await import('@/lib/api-client');
    return { pdf, apiGet: apiClient.get as unknown as ReturnType<typeof vi.fn> };
  }
  /** Branding answered by the stub, except the URLs `fail` names, which answer as given (or reject). */
  function brandingExcept(fail: Record<string, 'reject' | number>) {
    const base = brandingFetch({ companyName: 'Live Branding Ltd', appName: 'Live Monitor', logoUrl: '/logo.png' });
    const spy = vi.fn(async (url: unknown) => {
      const u = String(url);
      const hit = Object.keys(fail).find((k) => u.endsWith(k));
      if (hit) {
        if (fail[hit] === 'reject') throw new TypeError(`fetch failed: ${u}`);
        return { ok: false, status: fail[hit], json: async () => ({ error: 'X' }), blob: async () => new Blob([]) };
      }
      return base(url);
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }
  const V2 = {
    version: 2, reportType: 'alarms', title: 'ALARM REPORT', orientation: 'portrait',
    config: { showAppName: true }, sections: [{ kind: 'table', head: ['DATE'], body: [['2026-10-06']] }],
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('the stub answers: a report made now freezes Branding\'s names and its LOGO', async () => {
    const { pdf } = await fresh();
    brandingExcept({});
    const r = await pdf.createReport({ title: 'T', formatDateTime });
    expect(r.getSnapshot().chrome).toMatchObject({ companyName: 'Live Branding Ltd', appName: 'Live Monitor', logoDataUrl: BRANDING_LOGO_PNG });
  });

  it('(g) Branding cannot be read — the request fails, or answers an error — the report is REFUSED', async () => {
    for (const fail of ['reject', 500] as const) {
      const { pdf } = await fresh();
      brandingExcept({ '/api/config/branding': fail });
      await expect(pdf.createReport({ title: 'T', formatDateTime })).rejects.toThrow(REPORT_BRANDING_UNREADABLE);
      await expect(pdf.loadReportChrome(builtinReportTemplate('page:alarms'))).rejects.toThrow(REPORT_BRANDING_UNREADABLE);
      // A template with its OWN logo still prints Branding's NAMES: no logo read
      // is made, so this refusal is the names' alone (the logo's would mask it).
      const doc = builtinReportTemplate('page:alarms');
      await expect(pdf.loadReportChrome({ ...doc, header: { ...doc.header, logo: { mode: 'custom', dataUrl: PNG_1x1 } } }))
        .rejects.toThrow(REPORT_BRANDING_UNREADABLE);
    }
  });

  it('(h) the Branding LOGO cannot be read — the request fails, or answers 404 — the report is REFUSED', async () => {
    for (const fail of ['reject', 404] as const) {
      const { pdf } = await fresh();
      brandingExcept({ '/logo.png': fail });
      await expect(pdf.createReport({ title: 'T', formatDateTime })).rejects.toThrow(REPORT_BRANDING_UNREADABLE);
      await expect(pdf.loadReportChrome(builtinReportTemplate('page:alarms'))).rejects.toThrow(REPORT_BRANDING_UNREADABLE);
    }
  });

  it('(h) a `custom` or `none` logo with both names fetches NOTHING — nothing to fail', async () => {
    const { pdf, apiGet } = await fresh();
    // `vi.resetModules` keeps the MOCK registry: the api-client mock carries every earlier test's calls.
    apiGet.mockClear();
    const spy = vi.fn(async () => { throw new TypeError('nothing may be fetched'); });
    vi.stubGlobal('fetch', spy);
    const doc = builtinReportTemplate('page:alarms');
    const named = { ...doc.header, companyName: 'Own Co', appName: 'Own App' };
    expect(await pdf.loadReportChrome({ ...doc, header: { ...named, logo: { mode: 'none' } } })).toMatchObject({ logoDataUrl: null });
    expect(await pdf.loadReportChrome({ ...doc, header: { ...named, logo: { mode: 'custom', dataUrl: PNG_1x1 } } })).toMatchObject({ logoDataUrl: PNG_1x1 });
    expect(spy).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('(i) a v2 REPLAY still opens with Branding AND its logo unreadable: the shipped names, no logo', async () => {
    const { pdf } = await fresh();
    brandingExcept({ '/api/config/branding': 'reject', '/logo.png': 404 });
    const replay = await pdf.renderSnapshotToPdf(pdf.normaliseSnapshot(V2), { formatDateTime });
    expect(replay.getSnapshot().chrome).toMatchObject({ companyName: 'Controlytics AI Pvt Ltd', logoDataUrl: null, showAppName: true });
    replay.save('v2-replay-branding-down.pdf');
    expect(pageTexts(replay.doc).join(' ')).toContain('Controlytics AI Pvt Ltd');
  });

  it('(i) a v2 REPLAY with Branding answering an error and the logo request failing: the same fallbacks', async () => {
    const { pdf } = await fresh();
    brandingExcept({ '/api/config/branding': 500, '/logo.png': 'reject' });
    const replay = await pdf.renderSnapshotToPdf(pdf.normaliseSnapshot(V2), { formatDateTime });
    expect(replay.getSnapshot().chrome).toMatchObject({ logoDataUrl: null, showAppName: true });
  });
});
