import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { apiClient } from './api-client';
import { getApiBase } from './api-base';

// Brand colors
const COLORS = {
  primary: [30, 58, 95] as [number, number, number],       // #1e3a5f
  secondary: [59, 130, 246] as [number, number, number],    // #3b82f6
  accent: [139, 92, 246] as [number, number, number],       // #8b5cf6
  dark: [15, 23, 42] as [number, number, number],           // #0f172a
  text: [30, 41, 59] as [number, number, number],           // #1e293b
  muted: [100, 116, 139] as [number, number, number],       // #64748b
  light: [148, 163, 184] as [number, number, number],       // #94a3b8
  border: [226, 232, 240] as [number, number, number],      // #e2e8f0
  headerBg: [241, 245, 249] as [number, number, number],    // #f1f5f9
  altRow: [248, 250, 252] as [number, number, number],      // #f8fafc
  green: [21, 128, 61] as [number, number, number],
  blue: [29, 78, 216] as [number, number, number],
  red: [220, 38, 38] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
};

let cachedLogo: { data: string; w: number; h: number } | null = null;

async function loadLogo(): Promise<{ data: string; w: number; h: number } | null> {
  if (cachedLogo) return cachedLogo;
  try {
    const res = await fetch(`${getApiBase()}/api/config/branding`);
    const branding = await res.json();
    // NOTE: logoUrl is deliberately NOT prefixed — the '/logo.jpg' default is a
    // bundled static asset that resolves against the app's own origin. A
    // DB-stored '/uploads/...' logo would need the API base (getPhotoUrl
    // semantics), but that asset-base question spans sidebar.tsx +
    // report-page-wrapper.tsx too and wants one policy, not a local prefix here.
    const logoUrl = branding?.logoUrl || '/logo.jpg';
    const imgRes = await fetch(logoUrl);
    if (!imgRes.ok) return null;
    const blob = await imgRes.blob();
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject();
      reader.readAsDataURL(blob);
    });
    // Get natural dimensions to preserve aspect ratio
    const dims: { w: number; h: number } = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 1, h: 1 });
      img.src = dataUrl;
    });
    cachedLogo = { data: dataUrl, w: dims.w, h: dims.h };
    return cachedLogo;
  } catch { return null; }
}

async function loadBranding(): Promise<{ companyName: string; appName: string }> {
  let companyName = 'Controlytics AI Pvt Ltd';
  let appName = 'DigiLog';
  // Base identity from Branding (public endpoint).
  try {
    const data = await fetch(`${getApiBase()}/api/config/branding`).then((r) => r.json());
    if (data?.companyName) companyName = data.companyName;
    if (data?.appName) appName = data.appName;
  } catch { /* keep defaults */ }
  // Report Page Titles overrides take precedence when set, so the PDF identity
  // matches the on-screen report (override → Branding). Authed endpoint.
  try {
    const ov = await apiClient.get<{ companyName?: string; appName?: string }>('/api/config/report-page-titles/current');
    if (ov?.companyName?.trim()) companyName = ov.companyName.trim();
    if (ov?.appName?.trim()) appName = ov.appName.trim();
  } catch { /* keep branding values */ }
  return { companyName, appName };
}

/** Current user's User ID (username) + role, for the report footer stamp. The
 *  role decides which signature LABEL is used (config → Report Signatories). */
async function loadCurrentUser(): Promise<{ username: string | null; role: string | null }> {
  try {
    const base = getApiBase();
    const token = sessionStorage.getItem('access_token');
    const res = await fetch(`${base}/api/auth/me`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    if (!res.ok) return { username: null, role: null };
    const data = await res.json();
    const u = data?.user ?? data;
    return { username: u?.username || null, role: u?.role || null };
  } catch { return { username: null, role: null }; }
}

type SignatoryMap = Record<string, Record<string, string>>; // roleName -> reportKey -> label

/** Per-role, per-report signature LABEL (Printed By / Reviewed By / Approved By).
 *  The generator's role + the report decide which label prints before their User
 *  ID. Keyed role -> reportKey. Null → footer falls back to "Printed By".
 *
 *  This used to GET `/api/config/report-signatories/resolved`. That config def
 *  was dropped in the Phase 0 domain strip, so the request 404'd on every PDF
 *  export and this function returned null via its `!res.ok` guard anyway.
 *  Returning null directly is behaviour-identical and drops the failed request.
 *  Restore the fetch if a report-signatories config def is ever re-added. */
async function loadSignatories(): Promise<SignatoryMap | null> {
  return null;
}

/**
 * Where to put the CENTRE of a centred header line, given a logo on the left.
 *
 * Page-centred by default. A long company name on A4 portrait can reach back past
 * a wide logo, and jsPDF draws the two on top of each other without complaint, so
 * the centre is nudged right by exactly enough to clear it — which reads as
 * "centred in the space that is left" rather than as a collision.
 *
 * @param textWidth measured at the size the text will be DRAWN at; measuring at a
 *   different size is the way to get a guard that passes and still overlaps.
 * @param logoEndX the x the logo ends at, gap included. Equals the left margin
 *   when there is no logo, and the result is then the true page centre.
 */
export function centredX(textWidth: number, pageWidth: number, logoEndX: number): number {
  return Math.max(pageWidth / 2, logoEndX + textWidth / 2);
}

export interface ReportConfig {
  title: string;
  subtitle?: string;
  orientation?: 'portrait' | 'landscape';
  formatDateTime: (d: string) => string;
  /** Stable report key used to look up this report's
   *  configured Printed/Reviewed/Approved By roles. Omit to keep just the
   *  default "Printed By: <generator>" footer. */
  reportKey?: string;
  /** Explicit signature lines (Printed/Reviewed/Approved By + User ID). When
   *  set, these REPLACE the role-based single line — used when re-rendering an
   *  approved report from a snapshot so all three signatures print. */
  signatures?: { label: string; value: string }[];
  /** Optional abbreviation key. Rendered as a "Legend" on the last page (above
   *  the Printed By stamp). Pass the shortcut words used in the report body
   *  (e.g. NA = Not Applicable). Omitted when empty. */
  legend?: { abbr: string; meaning: string }[];
}

export interface ReportDoc {
  doc: jsPDF;
  y: number;
  pw: number;
  ph: number;
  colors: typeof COLORS;
  addTable: (opts: {
    /** Omit for a headless parameter block. */
    head?: string[];
    body: string[][];
    columnStyles?: Record<number, any>;
    headColor?: [number, number, number];
  }) => void;
  addSectionTitle: (text: string) => void;
  addKeyValue: (pairs: [string, string][], columns?: number) => void;
  checkPageBreak: (needed: number) => void;
  /** Force a fresh page and reset the cursor to the top margin. */
  newPage: () => void;
  save: (filename: string) => void;
  /** Frozen snapshot of the rendered tables/titles — used by "Send for Review"
   *  to persist the report so it can be re-rendered identically later. */
  getSnapshot: () => ReportSnapshot;
}

export type SnapshotSection =
  | { title?: string; head: string[]; body: string[][]; columnStyles?: Record<number, any> }
  | { title?: string; pairs: [string, string][]; columns?: number };

export interface ReportSnapshot {
  reportType?: string;
  title: string;
  subtitle?: string;
  orientation?: 'portrait' | 'landscape';
  sections: SnapshotSection[];
}

/**
 * The report's type scale, in points, raised across the board on 2026-09-01
 * (operator: *"increase font sizes"*).
 *
 * Declared here rather than inline so the relationships stay visible — the title
 * must out-rank the company name it sits under, and the table body must stay
 * below the section titles above it. **This is SHARED by every report in the
 * product** (audit trail, instrument trend, alarms), which is the point: one
 * scale, not a per-report guess.
 *
 * `TABLE_PT` is the one with a hard ceiling. The alarm report prints up to ten
 * columns on A4 PORTRAIT, and autotable answers an over-wide table by wrapping
 * cells rather than by shrinking text, so pushing this much past 8 turns a
 * one-line row into three and costs more pages than it gains in legibility.
 */
const COMPANY_PT = 16;
const APPNAME_PT = 10;
const TITLE_PT = 13;
const SUBTITLE_PT = 9;
const SECTION_PT = 11;
const LABEL_PT = 9;
const TABLE_PT = 8;
const TABLE_HEAD_PT = 8.5;
const SMALLPRINT_PT = 8;

export async function createReport(config: ReportConfig): Promise<ReportDoc> {
  const [logo, branding, me, signatories] = await Promise.all([loadLogo(), loadBranding(), loadCurrentUser(), loadSignatories()]);
  // Labels configured for the generator's role (reportKey -> label), if any.
  const sig = me.role ? (signatories ?? {})[me.role] : undefined;
  const printedAt = config.formatDateTime(new Date().toISOString());
  const doc = new jsPDF({ orientation: config.orientation ?? 'portrait', unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.width;
  const ph = doc.internal.pageSize.height;
  let y = 10;

  // ── Top accent line ──
  doc.setFillColor(...COLORS.secondary);
  doc.rect(0, 0, pw, 2, 'F');

  y = 6;

  // ── Logo (aspect-ratio preserved, max 12mm tall) ──
  const maxLogoH = 12;
  let logoEndX = 14;
  if (logo) {
    try {
      const aspect = logo.w / logo.h;
      const logoH = maxLogoH;
      const logoW = logoH * aspect;
      doc.addImage(logo.data, 'JPEG', 14, y, logoW, logoH);
      logoEndX = 14 + logoW + 4;
    } catch { /* skip */ }
  }

  /**
   * ── Company name + app name, CENTRED (operator, 2026-09-01) ──
   *
   * Centred on the PAGE, not in the space beside the logo: the logo stays left
   * and the identity block reads as the page's own heading, which is how the
   * operator's reference report is laid out.
   *
   * The guard matters on a narrow page. A long company name centred on A4
   * portrait can reach back past a wide logo, and jsPDF will happily draw the two
   * on top of each other — so the centre is nudged right when the text would
   * actually collide. Measured, not assumed: `getTextWidth` respects the font
   * size set immediately above it, which is why each size is set before its
   * measurement rather than once at the top.
   */
  doc.setFontSize(COMPANY_PT); doc.setTextColor(...COLORS.primary);
  const centreFor = (text: string) => centredX(doc.getTextWidth(text), pw, logoEndX);
  doc.text(branding.companyName, centreFor(branding.companyName), y + 5.5, { align: 'center' });
  doc.setFontSize(APPNAME_PT); doc.setTextColor(...COLORS.muted);
  doc.text(branding.appName, centreFor(branding.appName), y + 11, { align: 'center' });

  y += maxLogoH + 4;

  // ── Report title bar ──
  doc.setFillColor(...COLORS.primary);
  // Taller by 1.5mm to keep the larger title optically centred in its bar.
  doc.rect(14, y, pw - 28, 9.5, 'F');
  // Centered title; no generated-on timestamp here (the print stamp at the end
  // of the report carries Printed Date & Time).
  doc.setFontSize(TITLE_PT); doc.setTextColor(...COLORS.white);
  doc.text(config.title, pw / 2, y + 6, { align: 'center' });

  y += 13.5;

  // ── Subtitle / filters info ──
  if (config.subtitle) {
    doc.setFontSize(SUBTITLE_PT); doc.setTextColor(...COLORS.muted);
    const lines = doc.splitTextToSize(config.subtitle, pw - 28);
    doc.text(lines, 14, y);
    y += lines.length * 4 + 2;
  }

  // Thin separator
  doc.setDrawColor(...COLORS.border); doc.setLineWidth(0.3);
  doc.line(14, y, pw - 14, y); y += 4;

  const addFooters = () => {
    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      // Footer line
      doc.setDrawColor(...COLORS.border); doc.setLineWidth(0.3);
      doc.line(14, ph - 12, pw - 14, ph - 12);
      /**
       * The page number ALONE, centred, bold, black (operator, 2026-09-01).
       *
       * The company and app names were in the left of every footer and are gone:
       * they are already in the header, and repeating branding on every page of a
       * §11 record adds nothing a reader needs. What a printed page genuinely
       * needs at the bottom is its place in the set — which is why the one thing
       * left is emphasised rather than greyed.
       */
      doc.setFontSize(SMALLPRINT_PT);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0, 0, 0);
      doc.text(`Page ${i} of ${pageCount}`, pw / 2, ph - 7, { align: 'center' });
      doc.setFont('helvetica', 'normal');
    }
  };

  // ── End-of-report block (last page, above the footer). Bottom-to-top:
  // Printed By + Printed Date & Time, then the optional abbreviation Legend,
  // then a Remarks box the operator fills in by hand. Anchored to the bottom
  // of the last page; spills onto a fresh page if it would overlap content.
  const addEndBlock = () => {
    const legendItems = config.legend ?? [];
    doc.setFontSize(SMALLPRINT_PT);
    const legendText = legendItems.length
      ? 'Legend:   ' + legendItems.map((l) => `${l.abbr} = ${l.meaning}`).join('      ')
      : '';
    const legendLines = legendText ? (doc.splitTextToSize(legendText, pw - 28) as string[]) : [];

    // Signature lines. Explicit `config.signatures` (re-render from an approved
    // snapshot) win — they carry the full Printed/Reviewed/Approved By chain.
    // Otherwise a single line whose label is chosen per role × per report
    // (config → Report Signatories) by the current generator.
    let sigLines: string[];
    if (config.signatures?.length) {
      sigLines = config.signatures.map((s) => `${s.label}: ${s.value}`);
    } else {
      const sigLabel = (config.reportKey ? (sig?.[config.reportKey] ?? '').trim() : '') || 'Printed By';
      sigLines = [`${sigLabel}: ${me.username ?? '-'}`];
    }

    const remarksH = 4 + 22 + 3;                         // label + box + gap
    const legendH = legendLines.length ? legendLines.length * 3.6 + 3 : 0;
    const printedH = 4 + sigLines.length * 4.5;
    const blockH = remarksH + legendH + printedH;

    const footerLineY = ph - 12;
    doc.setPage(doc.getNumberOfPages());
    let top = footerLineY - 3 - blockH;
    if (y > top - 2) { doc.addPage(); top = footerLineY - 3 - blockH; }
    doc.setPage(doc.getNumberOfPages());

    let by = top;
    // Remarks — empty bordered box for handwriting
    doc.setFontSize(LABEL_PT); doc.setTextColor(...COLORS.primary);
    doc.text('Remarks:', 14, by + 3);
    by += 4;
    doc.setDrawColor(...COLORS.border); doc.setLineWidth(0.3);
    doc.rect(14, by, pw - 28, 22);
    by += 22 + 3;
    // Legend (abbreviation key) — only when the report passes one
    if (legendLines.length) {
      doc.setFontSize(SMALLPRINT_PT); doc.setTextColor(...COLORS.muted);
      doc.text(legendLines, 14, by + 2.5);
      by += legendLines.length * 3.6 + 3;
    }
    // Signatory block (one line each) + Printed Date & Time on the first line.
    doc.setDrawColor(...COLORS.border); doc.setLineWidth(0.2);
    doc.line(14, by, pw - 14, by);
    doc.setFontSize(LABEL_PT); doc.setTextColor(...COLORS.text);
    sigLines.forEach((line, i) => doc.text(line, 14, by + 4.5 + i * 4.5));
    doc.text(`Printed Date & Time: ${printedAt}`, pw - 14, by + 4.5, { align: 'right' });
  };

  const checkPageBreak = (needed: number) => {
    if (y + needed > ph - 18) { doc.addPage(); y = 14; }
  };

  // Always start a fresh page (used to keep each grouped section on its own
  // page in the lifecycle report).
  const newPage = () => { doc.addPage(); y = 14; };

  // Snapshot capture — every section title + table is recorded so the report
  // can be re-rendered later (Send for Review).
  const snapSections: ReportSnapshot['sections'] = [];
  let pendingTitle: string | undefined;

  const addSectionTitle = (text: string) => {
    checkPageBreak(10);
    doc.setFillColor(...COLORS.headerBg);
    doc.roundedRect(14, y - 1, pw - 28, 7, 1, 1, 'F');
    doc.setFontSize(SECTION_PT); doc.setTextColor(...COLORS.primary);
    doc.text(text, 17, y + 4);
    y += 10;
    pendingTitle = text;
  };

  const addTable = (opts: {
    /** Omit for a HEADLESS table — a parameter block whose cells carry their own
     *  labels ("Block : CWH Block") rather than a heading row above them. */
    head?: string[];
    body: string[][];
    columnStyles?: Record<number, any>;
    headColor?: [number, number, number];
  }) => {
    snapSections.push({ title: pendingTitle, head: opts.head ?? [], body: opts.body, columnStyles: opts.columnStyles });
    pendingTitle = undefined;
    checkPageBreak(20);
    autoTable(doc, {
      startY: y,
      ...(opts.head ? { head: [opts.head] } : {}),
      body: opts.body,
      theme: 'grid',
      styles: { fontSize: TABLE_PT, cellPadding: 2.5, lineColor: COLORS.border, lineWidth: 0.2, textColor: COLORS.text, overflow: 'linebreak' },
      headStyles: { fillColor: opts.headColor ?? COLORS.primary, textColor: COLORS.white, fontStyle: 'bold', fontSize: TABLE_HEAD_PT },
      // Zebra striping reads as "these are records"; a parameter block is a
      // form, and striping it makes the reader look for a fifth row.
      /**
       * A ROW IS NEVER SPLIT ACROSS PAGES (operator, 2026-09-01).
       *
       * autotable's default breaks a tall row mid-cell, so an alarm's date could
       * print at the foot of one page and its value at the head of the next. On a
       * §11 record that is not cosmetic — the two halves read as two different
       * observations and nothing tells the reader they are one. `'avoid'` moves
       * the whole row down instead.
       */
      rowPageBreak: 'avoid',
      ...(opts.head ? { alternateRowStyles: { fillColor: COLORS.altRow } } : {}),
      columnStyles: opts.columnStyles ?? {},
    });
    y = (doc as any).lastAutoTable.finalY + 5;
  };

  const addKeyValue = (pairs: [string, string][], columns = 3) => {
    snapSections.push({ title: pendingTitle, pairs, columns });
    pendingTitle = undefined;
    checkPageBreak(12);
    const colW = (pw - 28) / columns;
    let row = 0;
    for (let i = 0; i < pairs.length; i++) {
      const col = i % columns;
      if (col === 0 && i > 0) { row++; y += 10; }
      if (col === 0) checkPageBreak(11);
      const x = 14 + col * colW;
      // The LABEL stays a step below its VALUE: this block is read for the values
      // (the Block, the Inst ID, the period), and equal weight makes a caption
      // compete with the thing it captions.
      doc.setFontSize(SMALLPRINT_PT); doc.setTextColor(...COLORS.muted);
      doc.text(pairs[i][0], x, y);
      doc.setFontSize(LABEL_PT + 1); doc.setTextColor(...COLORS.text);
      doc.text(pairs[i][1] || '-', x, y + 4.5);
    }
    y += 13;
  };

  return {
    doc, get y() { return y; }, set y(v) { y = v; },
    pw, ph, colors: COLORS,
    addTable, addSectionTitle, addKeyValue, checkPageBreak, newPage,
    save: (filename: string) => { addEndBlock(); addFooters(); doc.save(filename); },
    getSnapshot: (): ReportSnapshot => ({
      reportType: config.reportKey,
      title: config.title,
      subtitle: config.subtitle,
      orientation: config.orientation,
      sections: snapSections,
    }),
  };
}

/**
 * Re-render a persisted report snapshot to a PDF with explicit signature lines
 * (Printed By / Reviewed By / Approved By). Used to download an APPROVED report.
 */
export async function renderSnapshotToPdf(
  snapshot: ReportSnapshot,
  signatures: { label: string; value: string }[],
  formatDateTime: (d: string) => string,
  filename: string,
): Promise<void> {
  const report = await createReport({
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    orientation: snapshot.orientation,
    formatDateTime,
    signatures,
  });
  for (const s of snapshot.sections) {
    if (s.title) report.addSectionTitle(s.title);
    if ('pairs' in s) report.addKeyValue(s.pairs, s.columns);
    else report.addTable({ head: s.head, body: s.body, columnStyles: s.columnStyles });
  }
  report.save(filename);
}
