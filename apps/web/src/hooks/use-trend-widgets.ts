import useSWR from 'swr';
import { coerceTrendWidgetTexts, type TrendWidgetTexts } from '@digilog/shared';

/** The one SWR key for the resolved wording. Exported so a save can revalidate it. */
export const TREND_WIDGETS_KEY = '/api/config/trend-widgets/current';

/** The SUPER_ADMIN-only RAW row, which the edit dialog prefills from. */
export const TREND_WIDGETS_RAW_KEY = '/api/config/dynamic/trend-widgets';

/**
 * The administered wording and date/time formats for the instrument trend page's
 * widgets.
 *
 * Served to every authenticated user by the narrow slice route
 * `GET /api/config/trend-widgets/current` — the def itself stays SUPER_ADMIN-only,
 * so without that route a non-admin would see the shipped wording while the admin
 * who set it saw their own. One page, two vocabularies.
 *
 * **While the request is in flight this returns the SHIPPED wording** — never a
 * blank heading, and never a literal written out here. The one fallback in the
 * browser is `coerceTrendWidgetTexts`, which is also what makes a malformed or
 * stale response render the shipped wording instead of throwing on
 * `labels.alarmsTitle` of `undefined` and white-screening the trend page over a
 * column heading.
 *
 * The RESOLUTION is still the server's — this hook re-derives no policy. It only
 * guarantees the shape the page then reads.
 */
export function useTrendWidgets(): TrendWidgetTexts {
  const { data } = useSWR<TrendWidgetTexts>(TREND_WIDGETS_KEY, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });
  return coerceTrendWidgetTexts(data);
}
