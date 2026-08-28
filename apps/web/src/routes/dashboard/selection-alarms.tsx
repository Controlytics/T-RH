import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';

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

const SEVERITY_STYLE: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-700',
  MAJOR: 'bg-orange-100 text-orange-700',
  MINOR: 'bg-amber-100 text-amber-700',
  INFO: 'bg-slate-100 text-slate-600',
};

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
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
          Active alarms in this selection
        </h2>
        <Link to="/alarms" className="text-xs font-medium text-slate-500 hover:underline">
          All alarms →
        </Link>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            {data ? 'No active alarms here.' : 'Loading…'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.INFO
                }`}>
                  {a.severity}
                </span>
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
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-white">
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
