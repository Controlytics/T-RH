import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { StatusBadge } from '@/components/ui/status-badge';
import { severityTone } from '@/routes/alarms/alarm-display';
import { SkeletonRows } from '@/components/ui/skeleton';

/**
 * Active alarms on the instruments in the current drill-down.
 *
 * The existing Alarms COUNT card is a top-level navigation destination and stays
 * as it is; this is the list, and unlike that card it follows the selection —
 * which is why the count card was written to appear only at the top level in the
 * first place ("a global alarm count would be misleading" deeper in the tree).
 *
 * Scoped twice over on the server: by the caller's instrument visibility, and by
 * the location filter. The second narrows within the first and can never escape it.
 */

interface AlarmRow {
  id: string;
  instrumentId: string;
  instrumentCode: string | null;
  metric: string;
  severity: string;
  triggeredValue: number | null;
  limitKind: string | null;
  raisedAt: string;
  acknowledgedAt: string | null;
}

/*
 * Severity is rendered by StatusBadge, from the ONE mapping in
 * routes/alarms/alarm-display.ts.
 *
 * This file used to carry a fourth severity palette of its own — red/orange/
 * amber/slate — which disagreed with the Alarms page (red/amber/sky) on two of
 * the four levels. The same CRITICAL alarm therefore appeared in one colour on
 * the dashboard and another on the alarms screen, and MAJOR and MINOR were
 * adjacent oranges that were genuinely hard to tell apart in a list.
 */

export function SelectionAlarms({ functionalLocationId }: { functionalLocationId?: string }) {
  const { formatDateTime } = useDatetimeFormat();
  const qs = new URLSearchParams({ state: 'ACTIVE', limit: '25' });
  if (functionalLocationId) qs.set('functionalLocationId', functionalLocationId);

  const { data, error } = useSWR<{ data: AlarmRow[] }>(
    `/api/alarms?${qs.toString()}`,
    { refreshInterval: 30_000 },
  );

  // A permission error must not render as "no alarms" — that reads as "nothing is
  // wrong" to someone who simply cannot see them. Same reasoning as the count
  // card's `canSeeAlarms` guard.
  if (error) return null;

  const rows = data?.data ?? [];

  return (
    <section className="space-y-2">
      {/* No heading here: PanelCard supplies it, and the operator may have
          renamed it. A second hard-coded title would contradict theirs. */}
      <div className="flex items-baseline justify-end">
        <Link to="/alarms" className="text-xs font-medium text-slate-500 hover:underline">
          All alarms →
        </Link>
      </div>

      {/* TRANSPARENT, not bg-white. This sits inside a PanelCard that already
          draws the border, the rounding and — the point of this change — the
          operator's chosen tint. An opaque box here painted over the tint, so
          only the card's border appeared to change colour. */}
      <div className="rounded-xl border border-slate-200/70">
        {!data ? (
          <div className="p-4">
            <SkeletonRows rows={3} columns={3} />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No active alarms here.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                <StatusBadge tone={severityTone(a.severity)} label={a.severity} className="shrink-0" />
                <Link
                  to={`/instruments/${a.instrumentId}/trend`}
                  className="font-medium text-slate-800 hover:underline"
                >
                  {a.instrumentCode ?? a.instrumentId.slice(0, 8)}
                </Link>
                <span className="text-slate-600">
                  {a.metric.toLowerCase()}
                  {a.limitKind ? ` ${a.limitKind.toLowerCase()}` : ''}
                  {a.triggeredValue !== null ? ` — ${a.triggeredValue}` : ''}
                </span>
                <span className="ml-auto shrink-0 text-xs text-slate-500">
                  {formatDateTime(a.raisedAt)}
                </span>
                {/* Unacknowledged is the actionable state, so it is what gets the
                    badge. Marking the acknowledged ones instead would put emphasis
                    on the rows nobody needs to do anything about. */}
                {!a.acknowledgedAt && (
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[0.625rem] font-semibold text-white">
                    unacknowledged
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
