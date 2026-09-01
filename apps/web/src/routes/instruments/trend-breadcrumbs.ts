/**
 * The trend page's breadcrumb, built from where the reader ACTUALLY came from.
 *
 * It used to be hardcoded to `Home / Instruments / <code> / Trend` whatever the
 * route in, and the two links that actually reach this page both come from the
 * DASHBOARD — its telemetry table and its alarms panel. So the commonest way in
 * produced a trail through a page nobody had visited (operator, 2026-09-01).
 *
 * A breadcrumb that names a path you did not take is worse than none: it is the
 * one control on the page whose entire job is to say where you are, and following
 * it back lands somewhere you were never at.
 *
 * **`/` is the DASHBOARD, not Home** (`main.tsx:107`; `/home` is a different
 * page at :108). The old trail's first crumb was labelled "Home" and pointed at
 * `/`, so it was mislabelled as well as misordered. Fixed here.
 *
 * The origin travels in React Router's `location.state`, set by whichever link
 * navigated. State is lost on a refresh or a pasted URL, which is exactly the
 * case where there IS no journey to describe — {@link FALLBACK_ORIGIN} then
 * gives the hierarchy, which is a claim about structure rather than about
 * history and is true regardless.
 */

export type TrendOrigin = 'dashboard' | 'instruments';

/** What a link into this page puts in `location.state`. */
export interface TrendNavState {
  from?: TrendOrigin;
}

/**
 * Direct URL, refresh, or a link that predates this. The instrument list is the
 * honest answer: it is where this record sits, and nothing about it claims the
 * reader passed through it.
 */
export const FALLBACK_ORIGIN: TrendOrigin = 'instruments';

export interface Crumb {
  label: string;
  to?: string;
}

/** Reads the origin out of an untyped router state, defaulting safely. */
export function originFrom(state: unknown): TrendOrigin {
  const from = (state as TrendNavState | null | undefined)?.from;
  return from === 'dashboard' || from === 'instruments' ? from : FALLBACK_ORIGIN;
}

/**
 * @param origin where the reader came from
 * @param instrumentId `null` while the route param is missing
 * @param code the instrument's code, or null before it has loaded — the crumb
 *   then reads "Instrument" rather than an empty gap, and still links.
 */
export function trendCrumbs(
  origin: TrendOrigin,
  instrumentId: string | null,
  code: string | null,
): Crumb[] {
  const head: Crumb[] = origin === 'dashboard'
    ? [{ label: 'Dashboard', to: '/' }]
    : [{ label: 'Dashboard', to: '/' }, { label: 'Instruments', to: '/instruments' }];

  return [
    ...head,
    // The instrument itself is always in the trail whichever way you arrived:
    // the trend page is a view OF that record, and its detail page is the one
    // hop back that is true in both journeys.
    ...(instrumentId ? [{ label: code ?? 'Instrument', to: `/instruments/${instrumentId}` }] : []),
    { label: 'Trend' },
  ];
}
