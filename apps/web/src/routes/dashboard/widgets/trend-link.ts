/**
 * Where a widget's instrument leads: its trend page, carrying the dashboard's
 * origin AND its breadcrumb trail (`from: 'dashboard'`, `trail`) — the rule
 * every way from the dashboard into the trend page follows (apps/web/CLAUDE.md,
 * "Every link from the dashboard into the trend page carries the dashboard's
 * breadcrumb TRAIL").
 *
 * The host hands the trail. With none — the Add widget dialog's live preview,
 * and a dashboard being edited (`WidgetPanel` withholds it, R7-9) — there is NO
 * link (null), so a click cannot leave a page holding an unsaved draft.
 *
 * ONE rule for the status grid's tiles and the instrument list's rows.
 */

/** The dashboard's breadcrumb as links — what a way into the trend page carries back. */
export type WidgetTrail = readonly { label: string; to: string }[];

export interface TrendLink {
  to: string;
  state: { from: 'dashboard'; trail: WidgetTrail };
}

export function trendLinkFor(instrumentId: string, trail: WidgetTrail | undefined): TrendLink | null {
  if (!trail) return null;
  return { to: `/instruments/${instrumentId}/trend`, state: { from: 'dashboard', trail } };
}
