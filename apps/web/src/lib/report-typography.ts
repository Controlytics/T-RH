import { HEADER_LABEL_MM } from './report-header-block';

/**
 * The Data Report's type scale and label column. Moved here from
 * `routes/instruments/data-report.ts` on 2026-11-03 (page reports on
 * templates) because the ONE templated builder (`lib/templated-report.ts`)
 * applies this scale to any template whose `page.typography` is
 * `'data-report'`, and a library module must not import a page's;
 * `data-report.ts` re-exports both names, so every caller that imported them
 * from there still does.
 */

/**
 * This report's type scale — larger and heavier than the shared chrome's
 * default, with its column headings centred (operator, 2026-09-05: *"in data
 * report make headings to center and in header, and increase font sizes and
 * thickness"*). The reference prints its site line, title, labels and column
 * headings bold and visibly larger than its readings, which stay regular — so
 * the weight goes on the headings alone and the body only grows.
 *
 * Four columns on a portrait page leave room the alarm report's ten do not,
 * which is why this report can sit above the shared `tablePt` ceiling. Only
 * the keys named here move; everything else keeps `DEFAULT_TYPOGRAPHY`.
 */
export const DATA_REPORT_TYPOGRAPHY = {
  // Raised a step on 2026-10-07 with the shared scale (operator: "improve
  // text in reports, bold and increase size"); still above it everywhere.
  companyPt: 21,
  appNamePt: 12,
  titlePt: 17,
  labelPt: 11,
  tablePt: 11,
  tableHeadPt: 11.5,
  smallprintPt: 10,
  headingWeight: 'bold',
  tableHeadAlign: 'center',
} as const;

/**
 * The parameter block's LABEL column, wider than the alarm report's 26mm:
 * `Temp. Limit :` in 10pt bold needs ~28mm with its padding, and a label that
 * wraps onto two lines makes one field read as two.
 */
/** The same label column every other header block uses (2026-10-05): one block for all reports. */
export const DATA_REPORT_LABEL_MM = HEADER_LABEL_MM;
