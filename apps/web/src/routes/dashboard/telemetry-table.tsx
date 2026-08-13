import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { statusClasses, readingAge } from './status';
import { formatSetPoint, NOT_AVAILABLE } from './set-point';
import {
  useTelemetryOverview,
  useTelemetrySettings,
  type OverviewRow,
} from './use-telemetry';

/**
 * TABULAR VIEW — the room-condition overview, laid out to the operator's
 * reference table (`Tabular View.png`): a two-row grouped header where each
 * measurement is split into ACTUAL and SET POINT, a solid status cell, and a
 * trend link per row.
 *
 * ROWS ARE INSTRUMENTS, not rooms, even though ROOM NAME leads. A room-per-row
 * table would hide every unplaced instrument, and "this probe is not assigned to
 * a room" is exactly the kind of gap this screen exists to surface.
 *
 * DP (mmWc) IS PRESENT AND ALWAYS "NA". Nothing in this system produces
 * differential pressure — there is no field for it in the schema and no AHU
 * concept. The column is here so the layout matches the reference and so adding
 * DP later is a data change rather than a re-layout. Do not mistake it for a
 * broken reading.
 *
 * The column set is declared once in COLUMN_GROUPS below; the operator is
 * defining the final content separately, so changing the columns should be an
 * edit to that list, not a rewrite of the markup.
 */

/** Dark, dense styling — scoped to this table. The rest of the app is light. */
const CELL = 'px-3 py-2 text-center text-[13px] whitespace-nowrap';
const HEAD = 'px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-100';

/**
 * Header layout. `sub` = the ACTUAL / SET POINT pair under a measurement group;
 * a group with no `sub` spans both header rows.
 */
const COLUMN_GROUPS = [
  { key: 'room', label: 'Room Name', align: 'left' as const },
  { key: 'temp', label: 'Temp. (°C)', sub: ['Actual', 'Set Point'] },
  { key: 'rh', label: 'RH (%)', sub: ['Actual', 'Set Point'] },
  { key: 'dp', label: 'DP (mmWc)', sub: ['Actual', 'Set Point'] },
  { key: 'status', label: 'Status' },
  { key: 'trend', label: 'Mimic / Trend' },
];

const COLSPAN = COLUMN_GROUPS.reduce((n, g) => n + (g.sub ? g.sub.length : 1), 0);

type SortKey = 'room' | 'temperature' | 'humidity' | 'status';

function sortValue(row: OverviewRow, key: SortKey): string | number {
  switch (key) {
    // Unplaced instruments sort last ascending, rather than clustering at the top
    // under an empty string and burying the placed ones.
    case 'room': return row.room?.code.toLowerCase() ?? '￿';
    case 'temperature': return row.temperature?.value ?? Number.NEGATIVE_INFINITY;
    case 'humidity': return row.humidity?.value ?? Number.NEGATIVE_INFINITY;
    case 'status': return row.status;
  }
}

/** An actual reading, or NA — never a dash, so the table reads consistently. */
function actual(v: { value: number } | null | undefined, decimals: number): string {
  return v ? v.value.toFixed(decimals) : NOT_AVAILABLE;
}

export function TelemetryTable() {
  const { rows, isLoading, error, refreshMs } = useTelemetryOverview();
  const { temperatureDecimals, humidityDecimals } = useTelemetrySettings();
  const [sort, setSort] = useState<SortKey>('room');
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

  const arrow = (k: SortKey) => (sort === k ? (asc ? ' ↑' : ' ↓') : '');
  const sortable = 'cursor-pointer select-none hover:text-white';

  return (
    <div className="space-y-3">
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

      <div className="overflow-x-auto rounded-xl border border-slate-700 shadow-soft">
        <table className="min-w-full border-collapse bg-slate-700">
          <thead>
            {/* Row 1 — measurement groups. */}
            <tr className="bg-slate-900">
              {COLUMN_GROUPS.map((g) => (
                <th
                  key={g.key}
                  colSpan={g.sub ? g.sub.length : 1}
                  rowSpan={g.sub ? 1 : 2}
                  onClick={g.key === 'room' ? () => toggle('room') : undefined}
                  className={`${HEAD} border border-slate-600 ${
                    g.align === 'left' ? 'text-left' : 'text-center'
                  } ${g.key === 'room' ? sortable : ''}`}
                >
                  {g.label}{g.key === 'room' ? arrow('room') : ''}
                </th>
              ))}
            </tr>
            {/* Row 2 — the ACTUAL / SET POINT pairs. */}
            <tr className="bg-slate-800">
              {COLUMN_GROUPS.filter((g) => g.sub).flatMap((g) =>
                g.sub!.map((label) => {
                  const key: SortKey | null =
                    label === 'Actual' && g.key === 'temp' ? 'temperature'
                    : label === 'Actual' && g.key === 'rh' ? 'humidity'
                    : null;
                  return (
                    <th
                      key={`${g.key}-${label}`}
                      onClick={key ? () => toggle(key) : undefined}
                      className={`${HEAD} border border-slate-600 text-center ${key ? sortable : ''}`}
                    >
                      {label}{key ? arrow(key) : ''}
                    </th>
                  );
                }),
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={COLSPAN} className="px-4 py-8 text-center text-sm text-slate-300">
                  Loading&hellip;
                </td>
              </tr>
            )}
            {!isLoading && shown.length === 0 && (
              <tr>
                <td colSpan={COLSPAN} className="px-4 py-8 text-center text-sm text-slate-300">
                  {rows.length === 0
                    ? 'No instruments registered yet.'
                    : 'No instruments match that filter.'}
                </td>
              </tr>
            )}
            {shown.map((r, i) => {
              const c = statusClasses(r.status);
              const breach = r.status === 'OUT_OF_SPEC';
              // Whichever slot reported most recently — a probe sending only
              // temperature must still show a real age, not "Never".
              const latest = [r.temperature?.ts, r.humidity?.ts].filter(Boolean).sort().pop() ?? null;
              const band = i % 2 === 0 ? 'bg-slate-700' : 'bg-slate-600';
              const value = `${CELL} tabular-nums ${breach ? 'font-bold text-rose-200' : 'text-white'}`;
              const spec = `${CELL} tabular-nums text-slate-200`;

              return (
                <tr key={r.instrumentId} className={`${band} hover:bg-slate-500`}>
                  <td className={`${CELL} border border-slate-600 text-left`}>
                    {r.room ? (
                      <>
                        <span className="font-semibold text-white">{r.room.code}</span>
                        {r.room.label && <span className="text-slate-200"> ({r.room.label})</span>}
                      </>
                    ) : (
                      <span className="text-slate-300 italic">Not placed</span>
                    )}
                    {/* The instrument is still identified — this is an instrument
                        row, and two probes in one room must be distinguishable. */}
                    <div className="text-[11px] text-slate-300">{r.code}</div>
                  </td>

                  <td className={`${value} border border-slate-600`}>
                    {actual(r.temperature, temperatureDecimals)}
                  </td>
                  <td className={`${spec} border border-slate-600`}>
                    {formatSetPoint(r.limits?.tempMin, r.limits?.tempMax, temperatureDecimals)}
                  </td>

                  <td className={`${value} border border-slate-600`}>
                    {actual(r.humidity, humidityDecimals)}
                  </td>
                  <td className={`${spec} border border-slate-600`}>
                    {formatSetPoint(r.limits?.rhMin, r.limits?.rhMax, humidityDecimals)}
                  </td>

                  {/* DP: no source in this system. See the file header. */}
                  <td className={`${spec} border border-slate-600`}>{NOT_AVAILABLE}</td>
                  <td className={`${spec} border border-slate-600`}>{NOT_AVAILABLE}</td>

                  {/* Solid status cell, as in the reference table. The WORD is in
                      the cell — colour is never the only signal. */}
                  <td className={`border border-slate-600 p-0`}>
                    <div
                      className={`flex h-full items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-white ${
                        r.status === 'OK' ? 'bg-emerald-700'
                        : r.status === 'OUT_OF_SPEC' ? 'bg-red-700'
                        : r.status === 'NO_DATA' ? 'bg-slate-500'
                        : 'bg-amber-700'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                      {c.label}
                    </div>
                  </td>

                  <td className={`${CELL} border border-slate-600`}>
                    <div className="flex items-center justify-center gap-2">
                      <Link
                        to={`/instruments/${r.instrumentId}`}
                        className="font-semibold text-sky-200 hover:text-white hover:underline"
                      >
                        {r.code}
                      </Link>
                      {/* Trend only where there is a room to chart. */}
                      {r.room && (
                        <Link
                          to={`/instruments/${r.instrumentId}`}
                          title={`Trend — last reading ${readingAge(latest)}`}
                          aria-label={`Trend for ${r.code}`}
                          className="text-slate-200 hover:text-white"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 17l4-6 4 3 5-8 5 6" />
                          </svg>
                        </Link>
                      )}
                    </div>
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
