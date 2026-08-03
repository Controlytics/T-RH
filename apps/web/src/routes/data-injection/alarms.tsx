import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { AlarmAckDialog } from './alarm-ack-dialog';
import { SeverityPill } from './alarm-severity-pill';
import {
  ALARM_STATES, OPEN_ALARM_STATES, SEVERITY_ORDER, SEVERITY_LABELS, STATE_LABELS,
  describeThreshold, formatNumber, formatTimestamp, measurementLabel,
  type AlarmRow, type AlarmSeverity, type AlarmState,
} from './alarm-shared';

/** `OPEN` is a UI-only pseudo-state — the API has no "not closed" filter. */
type StateFilter = AlarmState | 'OPEN' | 'ALL';

const STATE_FILTER_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: 'OPEN', label: 'Open (hides closed)' },
  ...ALARM_STATES.map(s => ({ value: s as StateFilter, label: STATE_LABELS[s] })),
  { value: 'ALL', label: 'All states' },
];

function statesFor(filter: StateFilter): AlarmState[] {
  if (filter === 'OPEN') return OPEN_ALARM_STATES;
  if (filter === 'ALL') return ALARM_STATES;
  return [filter];
}

const STATE_STYLE: Record<AlarmState, string> = {
  ACTIVE: 'bg-red-50 text-red-800 border-red-300',
  ACTIVE_ACKED: 'bg-blue-50 text-blue-800 border-blue-300',
  RESOLVED_UNACKED: 'bg-amber-50 text-amber-800 border-amber-300',
  CLOSED: 'bg-slate-100 text-slate-600 border-slate-300',
};

function StatePill({ state }: { state: AlarmState }) {
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${STATE_STYLE[state]}`}>
      {STATE_LABELS[state]}
    </span>
  );
}

/** An alarm can only be signed while it is ACTIVE or RESOLVED_UNACKED — mirrors applyAck() on the server. */
function isAckable(a: AlarmRow): boolean {
  return a.state === 'ACTIVE' || a.state === 'RESOLVED_UNACKED';
}

export default function AlarmsPage() {
  const can = useCan();
  const [searchParams, setSearchParams] = useSearchParams();

  const [stateFilter, setStateFilter] = useState<StateFilter>('OPEN');
  const [severityFilter, setSeverityFilter] = useState<AlarmSeverity | ''>('');
  // Seeded from the query string so the instrument-detail strip can deep-link
  // straight into this queue filtered to one instrument.
  const instrumentFilter = searchParams.get('instrumentId') ?? '';

  const [ackTarget, setAckTarget] = useState<AlarmRow | null>(null);

  const states = statesFor(stateFilter);

  // One request per state. The API exposes a single `state` enum and caps each
  // response at 200 rows — folding several states into one unfiltered call
  // would let a long tail of CLOSED alarms push the open ones (the whole point
  // of the queue) past the cap and out of sight.
  const listKey = ['alarms', states.join(','), severityFilter, instrumentFilter] as const;
  const { data, isLoading, error, mutate } = useSWR<AlarmRow[]>(
    listKey,
    async () => {
      const responses = await Promise.all(states.map((s) => {
        const q = new URLSearchParams({ state: s });
        if (severityFilter) q.set('severity', severityFilter);
        if (instrumentFilter) q.set('instrumentId', instrumentFilter);
        return apiClient.get<AlarmRow[]>(`/api/alarms?${q.toString()}`);
      }));
      return responses.flat().sort(
        (a, b) => new Date(b.firstBreachAt).getTime() - new Date(a.firstBreachAt).getTime(),
      );
    },
    { refreshInterval: 15_000 },
  );

  // Conditional key — null when the user lacks the permission, so no 403 ever
  // reaches the console (same convention as the Data Injection dashboard).
  const { data: instruments } = useSWR<{ id: string; name: string; code: string }[]>(
    can('instruments.view') ? '/api/instruments' : null,
  );

  const rows = useMemo(() => data ?? [], [data]);
  const hasFilters = stateFilter !== 'OPEN' || severityFilter !== '' || instrumentFilter !== '';

  const setInstrumentFilter = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('instrumentId', id);
    else next.delete('instrumentId');
    setSearchParams(next, { replace: true });
  };

  const clearFilters = () => {
    setStateFilter('OPEN');
    setSeverityFilter('');
    setInstrumentFilter('');
  };

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Alarms</h1>
          <p className="mt-1 text-sm text-slate-500">
            Instrument excursions and device liveness. Acknowledging an alarm is an
            electronic signature and always requires your password.
          </p>
        </div>
        <span className="text-xs text-slate-400">refreshes every 15s</span>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          State
          <select
            value={stateFilter}
            onChange={e => setStateFilter(e.target.value as StateFilter)}
            className="mt-1 block rounded border border-slate-200 bg-white px-2 py-1 text-sm"
          >
            {STATE_FILTER_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="text-xs text-slate-600">
          Severity
          <select
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value as AlarmSeverity | '')}
            className="mt-1 block rounded border border-slate-200 bg-white px-2 py-1 text-sm"
          >
            <option value="">All severities</option>
            {SEVERITY_ORDER.map(s => (
              <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
            ))}
          </select>
        </label>

        {instruments && (
          <label className="text-xs text-slate-600">
            Instrument
            <select
              value={instrumentFilter}
              onChange={e => setInstrumentFilter(e.target.value)}
              className="mt-1 block rounded border border-slate-200 bg-white px-2 py-1 text-sm"
            >
              <option value="">All instruments</option>
              {instruments.map(i => (
                <option key={i.id} value={i.id}>{i.name} ({i.code})</option>
              ))}
            </select>
          </label>
        )}

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="rounded border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50"
          >Clear</button>
        )}
      </div>

      {/* ── Queue ────────────────────────────────────────────────────────── */}
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="p-3">Instrument</th>
              <th className="p-3">Measurement</th>
              <th className="p-3">Severity</th>
              <th className="p-3">State</th>
              <th className="p-3">First breach</th>
              <th className="p-3">Last breach</th>
              <th className="p-3">Breaches</th>
              <th className="p-3">Peak value</th>
              {can('alarms.acknowledge') && <th className="p-3" />}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={9} className="p-6 text-center text-slate-500">Loading alarms…</td></tr>
            )}
            {!isLoading && error && (
              <tr><td colSpan={9} className="p-6 text-center text-red-700">
                Could not load alarms. {(error as Error).message}
              </td></tr>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <tr><td colSpan={9} className="p-6 text-center text-slate-500">
                <div className="font-medium text-slate-700">No alarms match these filters</div>
                <div className="mt-1 text-xs">
                  {stateFilter === 'OPEN'
                    ? 'Nothing is currently in excursion. Closed alarms are hidden — switch the State filter to see them.'
                    : 'Try widening the filters above.'}
                </div>
              </td></tr>
            )}
            {rows.map(a => (
              <tr key={a.id} className="border-b border-slate-100 align-top last:border-0">
                <td className="p-3">
                  <Link to={`/data-injection/instruments/${a.instrumentId}`}
                    className="text-slate-900 hover:text-slate-600 hover:underline">
                    {a.instrument.name}
                  </Link>
                  <div className="font-mono text-xs text-slate-400">{a.instrument.code}</div>
                </td>
                <td className="p-3">
                  <span className="text-slate-800">{measurementLabel(a.key)}</span>
                  {a.threshold && (
                    <div className="mt-0.5 text-xs text-slate-400">{describeThreshold(a.threshold)}</div>
                  )}
                </td>
                <td className="p-3"><SeverityPill severity={a.severity} /></td>
                <td className="p-3"><StatePill state={a.state} /></td>
                <td className="p-3 text-slate-500">{formatTimestamp(a.firstBreachAt)}</td>
                <td className="p-3 text-slate-500">{formatTimestamp(a.lastBreachAt)}</td>
                <td className="p-3 tabular-nums text-slate-700">{a.breachCount}</td>
                <td className="p-3 tabular-nums text-slate-700">{formatNumber(a.peakValue)}</td>
                {can('alarms.acknowledge') && (
                  <td className="p-3">
                    {isAckable(a) ? (
                      <button
                        onClick={() => setAckTarget(a)}
                        className="rounded bg-slate-900 px-3 py-1 text-xs text-white hover:bg-slate-700"
                      >Acknowledge</button>
                    ) : (
                      // Not a disabled button — there is no action to re-enable.
                      // Naming the signer is more useful than a greyed control.
                      <span className="text-xs text-slate-400">
                        {a.ackedAt ? `Signed ${formatTimestamp(a.ackedAt)}` : '—'}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-sm text-slate-500">{rows.length} alarm(s)</div>

      <AlarmAckDialog
        alarm={ackTarget}
        onClose={() => setAckTarget(null)}
        onAcknowledged={() => { setAckTarget(null); void mutate(); }}
        onStale={() => { setAckTarget(null); void mutate(); }}
      />
    </div>
  );
}
