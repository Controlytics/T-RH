/**
 * The HEADER BLOCK every report prints at its top (2026-10-05, one block for
 * all reports) — the Block / Area / … against Start Date / Start Time / … form,
 * a headless four-column table ruled by `pdf-report.ts`'s `addTable`. Moved here
 * from `routes/alarms/alarms-report.ts` on 2026-11-03 (page reports on
 * templates) so the ONE templated builder (`lib/templated-report.ts`) can lay a
 * page kind's information rows out with it without a library module importing
 * a page's; `alarms-report.ts` re-exports all four names, so every caller that
 * imported them from there still does.
 */

/**
 * The parameter block as TABLE ROWS, label and value on ONE line (operator,
 * 2026-09-01: *"header part like Block, area, start date, etc these all should
 * show in one table, title and value should come in one Line, like
 * Block : CWH Block"*).
 *
 * It was `addKeyValue`, which stacks a small grey caption ABOVE its value — two
 * lines per field and no ruling. This is a headless four-column table, so each
 * row reads `Block : CWH Block   Start Date : 27-05-2026` and the values still
 * line up down the page, which a single joined string would not do.
 *
 * The colon lives on the LABEL cell rather than being a column of its own: a
 * third column of colons would be ruled like data and would take width from the
 * values on a portrait page.
 */
export function scopeTableRows(pairs: readonly [string, string][]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const [lk, lv] = pairs[i];
    const right = pairs[i + 1];
    out.push(right
      ? [`${lk} :`, lv, `${right[0]} :`, right[1]]
      // An odd trailing field pads rather than short-rowing: autotable would
      // otherwise stretch its last cell across the missing columns.
      : [`${lk} :`, lv, '', '']);
  }
  return out;
}

/** The default A4 portrait text column: 210mm less two 14mm margins. */
export const CONTENT_WIDTH_MM = 182;
/** The label column of EVERY report's header block (2026-10-05, one block for all): wide enough for `Start Date :` at HEADER_BLOCK_PT. */
export const HEADER_LABEL_MM = 32;

/**
 * All FOUR columns pinned, so the block's centre line lands in the CENTRE.
 *
 * Operator, 2026-09-01: *"Block table central line side is not in center it is on
 * one side"*. Only the two label columns were pinned; autotable then divided the
 * REMAINING width between the two value columns by their content, so a short
 * Block name against a long date pushed the divider well off centre and the block
 * read as two unequal panes.
 *
 * Each half is an equal share of the content width, split into a fixed label and
 * whatever is left. Derived from the page rather than hardcoded, because this
 * chrome is shared and the other reports are landscape.
 */
export function scopeColumnStyles(contentWidth = CONTENT_WIDTH_MM, labelWidth = HEADER_LABEL_MM) {
  const value = contentWidth / 2 - labelWidth;
  return {
    0: { cellWidth: labelWidth, fontStyle: 'bold' as const },
    1: { cellWidth: value },
    2: { cellWidth: labelWidth, fontStyle: 'bold' as const },
    3: { cellWidth: value },
  };
}
