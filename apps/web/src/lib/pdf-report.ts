import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { BRANDING_TAB_TITLE_DEFAULT } from '@digilog/shared';
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
  // The shared product default, never the upstream "DigiLog" literal (audit
  // 2026-10-03, WEB-16): a fresh install prints this in every PDF header
  // until Branding is saved.
  let appName = BRANDING_TAB_TITLE_DEFAULT;
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
    // Through `apiClient` (audit 2026-10-03, WEB-11), not a hand-rolled fetch
    // reading the token itself — the ONE header builder, so a change to where
    // the token lives cannot silently blank the footer stamp.
    const data = await apiClient.get<any>('/api/auth/me');
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
  /**
   * The approved copy's SIGNATURE TABLE (2026-09-25): one column per signer
   * (Reviewed By, Approved By) and Name / Role / Date & Time as the rows.
   * Wins over `signatures` when given. Drawn with autotable in the end block.
   */
  signatureTable?: { label: string; name: string; role: string | null; dateTime: string }[];
  /** Optional abbreviation key. Rendered as a "Legend" on the last page (above
   *  the Printed By stamp). Pass the shortcut words used in the report body
   *  (e.g. NA = Not Applicable). Omitted when empty. */
  legend?: { abbr: string; meaning: string }[];
  /**
   * Per-report overrides of the shared type scale — see {@link ReportTypography}.
   * Omitted keys keep the shared default, so a report that names only
   * `tablePt` changes nothing else about the chrome.
   */
  typography?: Partial<ReportTypography>;
  /**
   * Print the app name under the company name. Default true. The Data Report
   * turns it off (operator, 2026-09-05: *"remove header on header"*) — its
   * reference carries the site line and the title and nothing between them.
   */
  showAppName?: boolean;
  /**
   * A DRAFT for review (2026-09-07): `DRAFT — NOT APPROVED` across every page
   * and NO signature line. The approver reads exactly the document the
   * requester asked for, marked as unsigned, before signing it.
   */
  draft?: boolean;
}

/**
 * The report's type scale, in points, plus the two decisions a heading carries
 * besides its size. Every report gets {@link DEFAULT_TYPOGRAPHY} unless it says
 * otherwise through `ReportConfig.typography`.
 *
 * **Why a report can override it at all (2026-09-05).** The Data Report was
 * asked to print bigger and bolder, with its column headings centred (operator:
 * *"in data report make headings to center and in header, and increase font
 * sizes and thickness"*). The scale is shared because one product should not
 * have three guesses at a heading size — but `tablePt` has a hard ceiling set by
 * the alarm report's ten portrait columns, and a four-column log does not have
 * to live under it. So the default stays what every other report prints at, and
 * a report opts UP by naming the values it needs, in one place, where the tests
 * can pin them.
 */
export interface ReportTypography {
  /** Company name in the page header. */
  companyPt: number;
  /** App name under the company name. */
  appNamePt: number;
  /** The title in its bar. */
  titlePt: number;
  subtitlePt: number;
  /** `addSectionTitle` pills. */
  sectionPt: number;
  /** Remarks / Printed By labels and `addKeyValue` values. */
  labelPt: number;
  /** Table body cells. */
  tablePt: number;
  /** Table heading cells. */
  tableHeadPt: number;
  /** Legend, footer page number, `addKeyValue` captions. */
  smallprintPt: number;
  /** Weight of the company name, app name and title. */
  headingWeight: 'normal' | 'bold';
  /** Horizontal alignment of table HEADING cells. Body cells take their own
   *  `columnStyles`; a heading centred over a left-aligned column reads as
   *  belonging to the next one, so this is a per-report choice, not a default. */
  tableHeadAlign: 'left' | 'center';
}

/**
 * A body cell that SPANS columns — `{ content, colSpan }`, autotable's own
 * shape (2026-09-07). A parameter block never prints an empty cell: when a
 * slot has no bound in force its Max / Min pair is gone and the remaining pair
 * takes the row. The alternative tried first — drawing the empty cells with no
 * border — left the block's outline with open corners (operator: "table was
 * not forming properly"); a span keeps every table a rectangle.
 */
export interface SpanCell { content: string; colSpan: number }
export type TableCell = string | SpanCell;

export interface ReportDoc {
  doc: jsPDF;
  y: number;
  pw: number;
  ph: number;
  colors: typeof COLORS;
  addTable: (opts: {
    /** Omit for a headless parameter block. */
    head?: string[];
    /** Strings, or `{ content, colSpan }` to span columns (see `SpanCell`). */
    body: TableCell[][];
    columnStyles?: Record<number, any>;
    headColor?: [number, number, number];
    /** `bold[row][col]` — body cells to print bold (a reading that crossed
     *  its limit, a fault word). Same shape as `body`, indexed by COLUMN, so
     *  do not combine with spans on the same row; absent = none. */
    bold?: boolean[][];
  }) => void;
  addSectionTitle: (text: string) => void;
  addKeyValue: (pairs: [string, string][], columns?: number) => void;
  /**
   * A wrapped paragraph of body text — a disclosure, a "no readings" line.
   * NOT `addSectionTitle`: that draws a fixed pill and one unwrapped line, so a
   * sentence longer than the page runs off the right edge. A §11 statement the
   * reader cannot finish reading is not a statement.
   */
  addNote: (text: string, color?: NoteColor) => void;
  /** A raster (a chart PNG) across the text column, `heightMm` tall. */
  addImage: (dataUrl: string, widthMm: number, heightMm: number) => void;
  checkPageBreak: (needed: number) => void;
  /** Force a fresh page and reset the cursor to the top margin. */
  newPage: () => void;
  save: (filename: string) => void;
  /**
   * The FINALISED document as a blob URL — the same end block, footers and
   * (for a draft) watermark `save()` paints, without the download. This is how
   * the approver's draft reaches a new tab; `doc.output('bloburl')` on the raw
   * document is the un-finalised one, with no page numbers and no DRAFT mark
   * (review, 2026-09-07).
   */
  toBlobUrl: () => string;
  /** The frozen document — every drawing call, in order, plus the chrome that
   *  shaped it. `renderSnapshotToPdf` replays it through this same interface. */
  getSnapshot: () => ReportSnapshot;
}

export type NoteColor = 'red' | 'muted' | 'text';

/**
 * ReportSnapshot v2 (2026-09-07) — the report review workflow's RECORD.
 *
 * Every PDF download is a request an approver signs, and the approver's DRAFT
 * and the approved download are both replays of this snapshot, so what was
 * reviewed is byte-for-byte what is downloaded (apart from the watermark and
 * the signature block). The v1 shape recorded tables and titles only; a trend
 * report also draws notes and chart rasters, and the Data Report breaks pages
 * between instruments, so v2 records those too, plus the `config` that shapes
 * the chrome (legend, typography, app-name line). No v1 snapshot exists in any
 * database — the table they lived in was dropped in the 2026-07-18 strip — so
 * `normaliseSnapshot` refuses anything but v2 rather than migrating.
 */
export type SnapshotSection =
  | { kind: 'table'; title?: string; head: string[]; body: TableCell[][]; columnStyles?: Record<number, any>; bold?: boolean[][] }
  | { kind: 'pairs'; title?: string; pairs: [string, string][]; columns?: number }
  | { kind: 'title'; text: string }
  | { kind: 'note'; text: string; color: NoteColor }
  | { kind: 'image'; dataUrl: string; widthMm: number; heightMm: number }
  | { kind: 'page-break' };

export interface ReportSnapshot {
  version: 2;
  /** The audit reportType, e.g. 'Instrument Time Series'. */
  reportType: string;
  title: string;
  subtitle?: string;
  orientation?: 'portrait' | 'landscape';
  config: { legend?: ReportConfig['legend']; typography?: ReportConfig['typography']; showAppName?: boolean };
  sections: SnapshotSection[];
}

/** The stored JSON as a v2 snapshot, or a thrown error — never a guess. */
export function normaliseSnapshot(v: unknown): ReportSnapshot {
  const s = v as Partial<ReportSnapshot> | null;
  if (!s || typeof s !== 'object') throw new Error('The stored report is not a snapshot.');
  if (s.version !== 2) throw new Error(`Unsupported report snapshot version ${String((s as any).version)} (expected 2).`);
  if (typeof s.title !== 'string' || !Array.isArray(s.sections)) throw new Error('The stored report snapshot is malformed.');
  return { ...s, reportType: s.reportType ?? '', config: s.config ?? {} } as ReportSnapshot;
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
 * `tablePt` is the one with a hard ceiling. The alarm report prints up to ten
 * columns on A4 PORTRAIT, and autotable answers an over-wide table by wrapping
 * cells rather than by shrinking text, so pushing this much past 8 turns a
 * one-line row into three and costs more pages than it gains in legibility.
 * A report with fewer columns may raise it through `ReportConfig.typography`.
 */
/**
 * ONE header block for EVERY report (operator, 2026-10-05: "make all reports
 * header table same only dont put any differences like table lines and font
 * styles bold everything"): a headless table — the Block / Area / … form at
 * the top of a report — prints at THIS size with every cell bold and dark
 * rules, whatever typography the report prints its records at. It is the
 * Data Report's record size, so that report's header did not move and the
 * others grew to match it.
 */
export const HEADER_BLOCK_PT = 10;

export const DEFAULT_TYPOGRAPHY: ReportTypography = {
  companyPt: 16,
  appNamePt: 10,
  titlePt: 13,
  subtitlePt: 9,
  sectionPt: 11,
  labelPt: 9,
  tablePt: 8,
  tableHeadPt: 8.5,
  smallprintPt: 8,
  headingWeight: 'normal',
  tableHeadAlign: 'left',
};

/**
 * autotable's own default margin is 40pt = 14.11mm, while the rest of this
 * chrome — the title bar, the rules, the end block — sits on a 14mm gutter. Left
 * to its default, every table started 0.11mm inside the bar above it and a
 * parameter block pinned to the full 182mm content width overran the page by
 * 0.22mm (autotable logged "could not fit page" on every Data Report). One
 * gutter for everything.
 */
const GUTTER_MM = 14;

export async function createReport(config: ReportConfig): Promise<ReportDoc> {
  const [logo, branding, me, signatories] = await Promise.all([loadLogo(), loadBranding(), loadCurrentUser(), loadSignatories()]);
  const t: ReportTypography = { ...DEFAULT_TYPOGRAPHY, ...config.typography };
  const headingFont = () => doc.setFont('helvetica', t.headingWeight);
  const normalFont = () => doc.setFont('helvetica', 'normal');
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
  // Baselines scale with the size, so a report that prints its identity larger
  // keeps the same optical spacing (at the defaults: 5.6mm and 10.6mm, as before).
  const companyBaseline = y + t.companyPt * 0.35;
  const appBaseline = companyBaseline + t.appNamePt * 0.5;
  headingFont();
  doc.setFontSize(t.companyPt); doc.setTextColor(...COLORS.primary);
  const centreFor = (text: string) => centredX(doc.getTextWidth(text), pw, logoEndX);
  doc.text(branding.companyName, centreFor(branding.companyName), companyBaseline, { align: 'center' });
  const showAppName = config.showAppName !== false;
  if (showAppName) {
    doc.setFontSize(t.appNamePt); doc.setTextColor(...COLORS.muted);
    doc.text(branding.appName, centreFor(branding.appName), appBaseline, { align: 'center' });
  }

  // Clear whichever is taller — the logo, or an identity block set large.
  y += Math.max(maxLogoH, (showAppName ? appBaseline : companyBaseline) - y + 1.5) + 4;

  // ── Report title bar ──
  doc.setFillColor(...COLORS.primary);
  // The bar grows with its title (9.5mm at the 13pt default, which keeps the
  // title optically centred in it); the baseline sits at 63% of its height.
  const barH = 9.5 * (t.titlePt / 13);
  doc.rect(GUTTER_MM, y, pw - GUTTER_MM * 2, barH, 'F');
  // Centered title; no generated-on timestamp here (the print stamp at the end
  // of the report carries Printed Date & Time).
  doc.setFontSize(t.titlePt); doc.setTextColor(...COLORS.white);
  doc.text(config.title, pw / 2, y + barH * 0.63, { align: 'center' });
  normalFont();

  y += barH + 4;

  // ── Subtitle / filters info ──
  if (config.subtitle) {
    doc.setFontSize(t.subtitlePt); doc.setTextColor(...COLORS.muted);
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
      doc.setFontSize(t.smallprintPt);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0, 0, 0);
      doc.text(`Page ${i} of ${pageCount}`, pw / 2, ph - 7, { align: 'center' });
      normalFont();
      if (config.draft) {
        // Light grey, diagonal, on EVERY page: a page torn out of a draft must
        // still say it is one.
        doc.setFontSize(48);
        doc.setTextColor(200, 200, 200);
        // jsPDF rotates about the text's START point, so the start is placed
        // half the text's width down-left of the page centre along the 35° line;
        // `align: 'center'` is ignored with an angle and left the text clipped.
        const mark = 'DRAFT — NOT APPROVED';
        const half = doc.getTextWidth(mark) / 2;
        const rad = (35 * Math.PI) / 180;
        doc.text(mark, pw / 2 - half * Math.cos(rad), ph / 2 + half * Math.sin(rad), { angle: 35 });
        doc.setTextColor(...COLORS.text);
      }
    }
  };

  // ── End-of-report block (last page, above the footer). Bottom-to-top:
  // Printed By + Printed Date & Time, then the optional abbreviation Legend,
  // then a Remarks box the operator fills in by hand. Anchored to the bottom
  // of the last page; spills onto a fresh page if it would overlap content.
  const addEndBlock = () => {
    const legendItems = config.legend ?? [];
    // Line heights follow the sizes (3.6mm and 4.5mm at the defaults).
    const legendLineH = t.smallprintPt * 0.45;
    const sigLineH = t.labelPt * 0.5;
    doc.setFontSize(t.smallprintPt);
    const legendText = legendItems.length
      ? 'Legend:   ' + legendItems.map((l) => `${l.abbr} = ${l.meaning}`).join('      ')
      : '';
    const legendLines = legendText ? (doc.splitTextToSize(legendText, pw - 28) as string[]) : [];

    // Signature lines. Explicit `config.signatures` (re-render from an approved
    // snapshot) win — they carry the full Printed/Reviewed/Approved By chain.
    // Otherwise a single line whose label is chosen per role × per report
    // (config → Report Signatories) by the current generator.
    // The signature TABLE (2026-09-25): head row + three body rows at the label
    // size — measured by autotable after drawing, but the block has to be
    // sized BEFORE it is placed, so this is the height it is reserved.
    const sigTable = !config.draft && config.signatureTable?.length ? config.signatureTable : null;
    const SIG_TABLE_H = 4 * (t.labelPt * 0.3528 * 1.15 + 2.8) + 2;
    let sigLines: string[];
    if (config.draft) {
      // Unsigned by definition; the signatures arrive with the approved copy.
      sigLines = [];
    } else if (sigTable) {
      sigLines = [];
    } else if (config.signatures?.length) {
      sigLines = config.signatures.map((s) => `${s.label}: ${s.value}`);
    } else {
      const sigLabel = (config.reportKey ? (sig?.[config.reportKey] ?? '').trim() : '') || 'Printed By';
      sigLines = [`${sigLabel}: ${me.username ?? '-'}`];
    }

    const remarksH = 4 + 22 + 3;                         // label + box + gap
    const legendH = legendLines.length ? legendLines.length * legendLineH + 3 : 0;
    const printedH = sigTable ? 4 + SIG_TABLE_H : 4 + sigLines.length * sigLineH;
    const blockH = remarksH + legendH + printedH;

    const footerLineY = ph - 12;
    doc.setPage(doc.getNumberOfPages());
    let top = footerLineY - 3 - blockH;
    if (y > top - 2) { doc.addPage(); top = footerLineY - 3 - blockH; }
    doc.setPage(doc.getNumberOfPages());

    let by = top;
    // Remarks — empty bordered box for handwriting
    doc.setFontSize(t.labelPt); doc.setTextColor(...COLORS.primary);
    doc.text('Remarks:', 14, by + 3);
    by += 4;
    doc.setDrawColor(...COLORS.border); doc.setLineWidth(0.3);
    doc.rect(14, by, pw - 28, 22);
    by += 22 + 3;
    // Legend (abbreviation key) — only when the report passes one
    if (legendLines.length) {
      doc.setFontSize(t.smallprintPt); doc.setTextColor(...COLORS.muted);
      doc.text(legendLines, 14, by + 2.5);
      by += legendLines.length * legendLineH + 3;
    }
    // Signatory block + Printed Date & Time on the first line.
    doc.setDrawColor(...COLORS.border); doc.setLineWidth(0.2);
    doc.line(14, by, pw - 14, by);
    doc.setFontSize(t.labelPt); doc.setTextColor(...COLORS.text);
    if (sigTable) {
      // The table: signers across the top, Name / Role / Date & Time down the
      // left. It takes the left of the line; Printed Date & Time keeps the
      // right, as on the line layout.
      autoTable(doc, {
        startY: by + 2,
        margin: { left: 14, right: 14 },
        tableWidth: Math.max(90, pw - 28 - 64),
        head: [['', ...sigTable.map((c) => c.label)]],
        body: [
          ['Name', ...sigTable.map((c) => c.name)],
          ['Role', ...sigTable.map((c) => c.role ?? '—')],
          ['Date & Time', ...sigTable.map((c) => c.dateTime)],
        ],
        theme: 'grid',
        styles: { fontSize: t.labelPt, cellPadding: 1.4, textColor: COLORS.text, lineColor: COLORS.border, lineWidth: 0.2 },
        headStyles: { fillColor: COLORS.headerBg, textColor: COLORS.primary, fontStyle: 'bold' },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 } },
      });
    } else {
      sigLines.forEach((line, i) => doc.text(line, 14, by + sigLineH + i * sigLineH));
    }
    doc.setFontSize(t.labelPt); doc.setTextColor(...COLORS.text);
    doc.text(`Printed Date & Time: ${printedAt}`, pw - 14, by + sigLineH, { align: 'right' });
  };

  const checkPageBreak = (needed: number) => {
    if (y + needed > ph - 18) { doc.addPage(); y = 14; }
  };

  // Snapshot capture — EVERY drawing call is recorded so the report can be
  // replayed identically later (the review workflow's draft and approved copies).
  const snapSections: ReportSnapshot['sections'] = [];
  let pendingTitle: string | undefined;
  // A title rides on the table or pairs block that follows it (the v1 shape);
  // followed by anything else it is recorded on its own.
  const flushTitle = () => {
    if (pendingTitle !== undefined) { snapSections.push({ kind: 'title', text: pendingTitle }); pendingTitle = undefined; }
  };

  // Always start a fresh page (the Data Report puts each instrument on its own).
  const newPage = () => { flushTitle(); snapSections.push({ kind: 'page-break' }); doc.addPage(); y = 14; };

  const addSectionTitle = (text: string) => {
    flushTitle();
    checkPageBreak(10);
    doc.setFillColor(...COLORS.headerBg);
    doc.roundedRect(14, y - 1, pw - 28, 7, 1, 1, 'F');
    doc.setFontSize(t.sectionPt); doc.setTextColor(...COLORS.primary);
    doc.text(text, 17, y + 4);
    y += 10;
    pendingTitle = text;
  };

  const NOTE_COLORS: Record<NoteColor, [number, number, number]> = { red: COLORS.red, muted: COLORS.muted, text: COLORS.text };
  const addNote = (text: string, color: NoteColor = 'text') => {
    flushTitle();
    snapSections.push({ kind: 'note', text, color });
    const lines = doc.splitTextToSize(text, pw - GUTTER_MM * 2) as string[];
    checkPageBreak(lines.length * 4 + 4);
    doc.setFontSize(8);
    doc.setTextColor(...NOTE_COLORS[color]);
    doc.text(lines, GUTTER_MM, y);
    y += lines.length * 4 + 4;
    doc.setTextColor(...COLORS.text);
  };

  const addImage = (dataUrl: string, widthMm: number, heightMm: number) => {
    flushTitle();
    snapSections.push({ kind: 'image', dataUrl, widthMm, heightMm });
    checkPageBreak(heightMm + 4);
    doc.addImage(dataUrl, 'PNG', GUTTER_MM, y, widthMm, heightMm);
    y += heightMm + 6;
  };

  const addTable = (opts: {
    /** Omit for a HEADLESS table — a parameter block whose cells carry their own
     *  labels ("Block : CWH Block") rather than a heading row above them. */
    head?: string[];
    body: TableCell[][];
    columnStyles?: Record<number, any>;
    headColor?: [number, number, number];
    bold?: boolean[][];
  }) => {
    snapSections.push({ kind: 'table', title: pendingTitle, head: opts.head ?? [], body: opts.body, columnStyles: opts.columnStyles, ...(opts.bold ? { bold: opts.bold } : {}) });
    pendingTitle = undefined;
    checkPageBreak(20);
    autoTable(doc, {
      startY: y,
      ...(opts.head ? { head: [opts.head] } : {}),
      body: opts.body,
      theme: 'grid',
      margin: { left: GUTTER_MM, right: GUTTER_MM },
      // A HEADLESS table is the report's header block (the Block / Area / …
      // form at the top): ONE style on every report — dark rules, every cell
      // bold, HEADER_BLOCK_PT (operator, 2026-10-05, twice: "make all the
      // reports headers tables lines into dark", then "make all reports header
      // table same … bold everything"). A headed table is records and keeps
      // the report's own typography and the light rule.
      styles: opts.head
        ? { fontSize: t.tablePt, cellPadding: 2.5, lineColor: COLORS.border, lineWidth: 0.2, textColor: COLORS.text, overflow: 'linebreak' }
        : { fontSize: HEADER_BLOCK_PT, fontStyle: 'bold', cellPadding: 2.5, lineColor: COLORS.dark, lineWidth: 0.2, textColor: COLORS.text, overflow: 'linebreak' },
      headStyles: { fillColor: opts.headColor ?? COLORS.primary, textColor: COLORS.white, fontStyle: 'bold', fontSize: t.tableHeadPt, halign: t.tableHeadAlign },
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
      // Per-cell emphasis, decided by the caller (a limit crossed, a fault
      // word). Applied here rather than by handing autotable styled cell
      // objects, so `body` stays plain strings and the snapshot above stays
      // re-renderable. (Spans ARE handed over as cell objects — that is
      // autotable's own shape for them, and the snapshot keeps it verbatim.)
      ...(opts.bold ? {
        didParseCell: (d: any) => {
          if (d.section === 'body' && opts.bold![d.row.index]?.[d.column.index]) d.cell.styles.fontStyle = 'bold';
        },
      } : {}),
    });
    y = (doc as any).lastAutoTable.finalY + 5;
  };

  const addKeyValue = (pairs: [string, string][], columns = 3) => {
    snapSections.push({ kind: 'pairs', title: pendingTitle, pairs, columns });
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
      doc.setFontSize(t.smallprintPt); doc.setTextColor(...COLORS.muted);
      doc.text(pairs[i][0], x, y);
      doc.setFontSize(t.labelPt + 1); doc.setTextColor(...COLORS.text);
      doc.text(pairs[i][1] || '-', x, y + 4.5);
    }
    y += 13;
  };

  // The end block and footers go on exactly once, whichever output is asked for
  // first — a second pass would print a second "Page N of N" over the first.
  let finalised = false;
  const finalise = () => { if (finalised) return; finalised = true; addEndBlock(); addFooters(); };

  return {
    doc, get y() { return y; }, set y(v) { y = v; },
    pw, ph, colors: COLORS,
    addTable, addSectionTitle, addKeyValue, addNote, addImage, checkPageBreak, newPage,
    save: (filename: string) => { finalise(); doc.save(filename); },
    toBlobUrl: () => { finalise(); return doc.output('bloburl') as unknown as string; },
    getSnapshot: (): ReportSnapshot => {
      flushTitle();
      return {
        version: 2,
        reportType: config.reportKey ?? '',
        title: config.title,
        subtitle: config.subtitle,
        orientation: config.orientation,
        config: { legend: config.legend, typography: config.typography, showAppName: config.showAppName },
        sections: snapSections,
      };
    },
  };
}

/**
 * Replay a frozen snapshot through the ONE renderer: as the approver's DRAFT
 * (`draft: true` — watermark, no signatures) or as the approved copy with its
 * two signature lines. Returns the document; the caller saves or opens it.
 */
export async function renderSnapshotToPdf(
  snapshot: ReportSnapshot,
  opts: {
    formatDateTime: (d: string) => string;
    signatures?: { label: string; value: string }[];
    signatureTable?: ReportConfig['signatureTable'];
    draft?: boolean;
  },
): Promise<ReportDoc> {
  const report = await createReport({
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    orientation: snapshot.orientation,
    reportKey: snapshot.reportType || undefined,
    legend: snapshot.config?.legend,
    typography: snapshot.config?.typography,
    showAppName: snapshot.config?.showAppName,
    formatDateTime: opts.formatDateTime,
    signatures: opts.signatures,
    signatureTable: opts.signatureTable,
    draft: opts.draft,
  });
  for (const s of snapshot.sections) {
    switch (s.kind) {
      case 'table':
        if (s.title) report.addSectionTitle(s.title);
        report.addTable({ head: s.head.length ? s.head : undefined, body: s.body, columnStyles: s.columnStyles, bold: s.bold });
        break;
      case 'pairs':
        if (s.title) report.addSectionTitle(s.title);
        report.addKeyValue(s.pairs, s.columns);
        break;
      case 'title': report.addSectionTitle(s.text); break;
      case 'note': report.addNote(s.text, s.color); break;
      case 'image': report.addImage(s.dataUrl, s.widthMm, s.heightMm); break;
      case 'page-break': report.newPage(); break;
    }
  }
  return report;
}
