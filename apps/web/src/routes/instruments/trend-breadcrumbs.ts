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
 * **`/` is the DASHBOARD** (`main.tsx`). The old trail's first crumb was
 * labelled "Home" and pointed at `/`, so it was mislabelled as well as
 * misordered. Fixed here. A separate `/home` Module Guide page existed until
 * 2026-09-19; it is gone, and every page's root crumb now reads Dashboard.
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
  /**
   * The dashboard's OWN breadcrumb at the moment the reader left it — each
   * crumb a link back to that selection (`/?fl=…`), see `trailFor` in
   * `dashboard/location-nav.ts`. Added 2026-10-03 (operator: "when i click
   * on its not going to all instruments page its going to instruments
   * page"): `from: 'dashboard'` alone produced Dashboard / <code> / Trend,
   * with no crumb for the All Instruments (or Block / Area) view the reader
   * had been looking at, because that selection lives in the dashboard's
   * URL and was never carried across.
   */
  trail?: Crumb[];
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
 * Reads the dashboard trail out of an untyped router state. `null` unless it
 * is an array of `{label: string, to: string}` — a malformed entry from an
 * older link or a hand-built state must not become a dead crumb.
 */
export function trailFrom(state: unknown): Crumb[] | null {
  const trail = (state as TrendNavState | null | undefined)?.trail;
  if (!Array.isArray(trail)) return null;
  const ok = trail.every((c) => c && typeof c === 'object'
    && typeof (c as Crumb).label === 'string' && typeof (c as Crumb).to === 'string');
  return ok ? trail.map((c) => ({ label: c.label, to: c.to })) : null;
}

/**
 * @param origin where the reader came from
 * @param instrumentId `null` while the route param is missing
 * @param code the instrument's code, or null before it has loaded — the crumb
 *   then reads "Instrument" rather than an empty gap, and still links.
 * @param trail the dashboard's breadcrumb when the reader came from there
 *   (`trailFrom(location.state)`); it HEADS the crumbs so the view they left
 *   — All Instruments, a Block, an Area — is one click back. Ignored for any
 *   other origin; absent or empty, the bare Dashboard crumb stands.
 */
export function trendCrumbs(
  origin: TrendOrigin,
  instrumentId: string | null,
  code: string | null,
  trail?: Crumb[] | null,
): Crumb[] {
  const head: Crumb[] = origin === 'dashboard'
    ? (trail && trail.length > 0 ? trail : [{ label: 'Dashboard', to: '/' }])
    : [{ label: 'Dashboard', to: '/' }, { label: 'Instruments', to: '/instruments' }];

  // The instrument itself is always NAMED in the trail: the trend page is a
  // view OF that record. Whether its crumb LINKS depends on the way in. From
  // the Instruments list the detail page is on the path and the crumb links
  // to it. From the DASHBOARD it is not — the reader never saw the detail
  // page, and that crumb was the one they pressed to go "back" (operator,
  // 2026-10-03: "still its going to instrument page not going to all
  // instruments widget"). So from the dashboard the code is a plain crumb;
  // the way back is the trail before it, and that is the only link.
  const instrument = instrumentId
    ? [origin === 'dashboard'
      ? { label: code ?? 'Instrument' }
      : { label: code ?? 'Instrument', to: `/instruments/${instrumentId}` }]
    : [];

  return [
    ...head,
    ...instrument,
    { label: 'Trend' },
  ];
}
