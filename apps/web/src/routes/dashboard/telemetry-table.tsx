import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { statusClasses, readingAge } from './status';
import {
  useTelemetryOverview,
  useTelemetrySettings,
  formatSlot,
  type OverviewRow,
} from './use-telemetry';

type SortKey = 'code' | 'room' | 'temperature' | 'humidity' | 'status';

function sortValue(row: OverviewRow, key: SortKey): string | number {
  switch (key) {
    case 'code': return row.code.toLowerCase();
    // Unplaced instruments sort last under an ascending sort, rather than
    // clustering at the top under an empty string and burying the placed ones.
    case 'room': return row.room?.code.toLowerCase() ?? '￿';
    case 'temperature': return row.temperature?.value ?? Number.NEGATIVE_INFINITY;
    case 'humidity': return row.humidity?.value ?? Number.NEGATIVE_INFINITY;
    case 'status': return row.status;
  }
}

export function TelemetryTable() {
  const { rows, isLoading, error, refreshMs } = useTelemetryOverview();
  const { temperatureDecimals, humidityDecimals } = useTelemetrySettings();
  const [sort, setSort] = useState<SortKey>('code');
  const [asc, setAsc] = useState(true);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          r.code.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          (r.room?.code.toLowerCase().includes(q) ?? false) ||
          (r.room?.label?.toLowerCase().includes(q) ?? false))
      : rows;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort);
      const bv = sortValue(b, sort);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return asc ? cmp : -cmp;
    });
  }, [rows, sort, asc, query]);

  const toggle = (key: SortKey) => {
    if (key === sort) setAsc(!asc);
    else { setSort(key); setAsc(true); }
  };

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Could not load instrument readings. {String((error as Error)?.message ?? '')}
      </div>
    );
  }

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th
      onClick={() => toggle(k)}
      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 cursor-pointer select-none hover:text-slate-700"
    >
      {children}{sort === k ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by instrument, name or room&hellip;"
          className="w-full max-w-sm rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2"
          style={{ ['--tw-ring-color' as string]: 'var(--theme-primary)' } as React.CSSProperties}
        />
        {/* Stated, not implied: this is a poll, not a live stream. */}
        <p className="text-xs text-slate-500">
          {shown.length} of {rows.length} instruments &middot; updates every {Math.round(refreshMs / 1000)}s
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-soft">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th k="code">Instrument</Th>
              <Th k="room">Room</Th>
              <Th k="temperature">Temperature</Th>
              <Th k="humidity">Humidity</Th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                Last reading
              </th>
              <Th k="status">Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">Loading&hellip;</td>
              </tr>
            )}
            {!isLoading && shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                  {rows.length === 0
                    ? 'No instruments registered yet.'
                    : 'No instruments match that filter.'}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const c = statusClasses(r.status);
              // Whichever slot reported most recently — a probe sending only
              // temperature must still show a real age, not "Never".
              const latest = [r.temperature?.ts, r.humidity?.ts]
                .filter(Boolean)
                .sort()
                .pop() ?? null;
              const breach = r.status === 'OUT_OF_SPEC';
              return (
                <tr key={r.instrumentId} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      to={`/instruments/${r.instrumentId}`}
                      className="font-medium text-slate-800 hover:underline"
                    >
                      {r.code}
                    </Link>
                    <div className="text-xs text-slate-500">{r.name}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700">
                    {r.room ? (
                      <>
                        <span className="font-medium">{r.room.code}</span>
                        {r.room.label && <span className="text-slate-500"> &middot; {r.room.label}</span>}
                      </>
                    ) : (
                      <span className="text-slate-400">Not placed</span>
                    )}
                  </td>
                  <td className={`px-4 py-3 text-sm tabular-nums ${breach ? 'font-semibold text-red-700' : 'text-slate-800'}`}>
                    {formatSlot(r.temperature, temperatureDecimals, '°C')}
                  </td>
                  <td className={`px-4 py-3 text-sm tabular-nums ${breach ? 'font-semibold text-red-700' : 'text-slate-800'}`}>
                    {formatSlot(r.humidity, humidityDecimals, '%RH')}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-500">{readingAge(latest)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${c.bg} ${c.border} ${c.text}`}>
                      <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                      {c.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
