import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { readingAge } from './status';
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
 * ROWS ARE INSTRUMENTS and INSTRUMENT ID leads (operator request). The room still
 * appears beneath the ID because the SET POINT columns come FROM the room — remove
 * it and a spec of "18.0 - 25.0" has no visible source, and an unplaced instrument
 * becomes indistinguishable from one whose room simply has no specification.
 *
 * STATUS IS ONLINE / OFFLINE ONLY (operator request, 2026-08-13), replacing the
 * five-state in-spec/out-of-spec/not-reporting/partial/no-data cell. It reports
 * `reporting`: is telemetry arriving within this instrument's expected interval.
 *
 * ⚠ The out-of-spec signal did NOT disappear with it — it moved to the value
 * cells, which render red and bold when a reading breaches its room's limits. An
 * instrument can legitimately read ONLINE while its temperature cell is red: the
 * probe is healthy, the room is not. Do not "tidy up" that red styling; it is now
 * the only place a limit breach is visible on this screen.
 *
 * DP (mmWc) WAS REMOVED at the operator's request (2026-08-13). Nothing in this
 * system produces differential pressure — no schema field, no AHU concept — so the
 * column only ever showed NA. Re-adding it means adding the data first.
 *
 * COLOURS FOLLOW THE APP THEME (`--theme-*`, set by Config → Branding) rather
 * than being hardcoded. Header bands use `--theme-primary-dark`, which is the
 * 700-level tone in every preset and so keeps white header text above 4.5:1;
 * `--theme-primary` is NOT used behind white text — several presets sit near
 * 3.7:1 there, which fails for 11px type.
 *
 * The column set is declared once in COLUMN_GROUPS; the operator is defining the
 * final content separately, so changing columns should be an edit to that list.
 */

const CELL = 'px-3 py-2 text-center text-[13px] whitespace-nowrap';
const HEAD = 'px-3 py-2 text-[11px] font-bold uppercase tracking-wide';

const COLUMN_GROUPS = [
  { key: 'code', label: 'Instrument ID', align: 'left' as const },
  { key: 'temp', label: 'Temp. (°C)', sub: ['Actual', 'Set Point'] },
  { key: 'rh', label: 'RH (%)', sub: ['Actual', 'Set Point'] },
  { key: 'status', label: 'Status' },
  { key: 'trend', label: 'Mimic / Trend' },
];

const COLSPAN = COLUMN_GROUPS.reduce((n, g) => n + (g.sub ? g.sub.length : 1), 0);

type SortKey = 'code' | 'temperature' | 'humidity' | 'status';

function sortValue(row: OverviewRow, key: SortKey): string | number {
  switch (key) {
    case 'code': return row.code.toLowerCase();
    case 'temperature': return row.temperature?.value ?? Number.NEGATIVE_INFINITY;
    case 'humidity': return row.humidity?.value ?? Number.NEGATIVE_INFINITY;
    // Offline first, so the rows that need attention surface under one click.
    case 'status': return row.reporting ? 1 : 0;
  }
}

/** An actual reading, or NA — never a dash, so the table reads consistently. */
function actual(v: { value: number } | null | undefined, decimals: number): string {
  return v ? v.value.toFixed(decimals) : NOT_AVAILABLE;
}

/** True when this reading is outside the room's specification. */
function breaches(
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (typeof min === 'number' && Number.isFinite(min) && value < min) return true;
  if (typeof max === 'number' && Number.isFinite(max) && value > max) return true;
  return false;
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

  const arrow = (k: SortKey) => (sort === k ? (asc ? ' ↑' : ' ↓') : '');
  const sortable = 'cursor-pointer select-none';
  const bandTop = { background: 'var(--theme-primary-dark)', color: '#ffffff' };
  const bandSub = { background: 'var(--theme-primary-light)', color: 'var(--theme-primary-dark)' };
  const offlineCount = shown.filter((r) => !r.reporting).length;

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
          {shown.length} of {rows.length} instruments
          {offlineCount > 0 && (
            <> &middot; <span className="font-semibold text-red-700">{offlineCount} offline</span></>
          )}
          {' '}&middot; updates every {Math.round(refreshMs / 1000)}s
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-300 bg-white shadow-soft">
        <table className="min-w-full border-collapse">
          <thead>
            {/* Row 1 — measurement groups. */}
            <tr>
              {COLUMN_GROUPS.map((g) => (
                <th
                  key={g.key}
                  colSpan={g.sub ? g.sub.length : 1}
                  rowSpan={g.sub ? 1 : 2}
                  style={bandTop}
                  onClick={g.key === 'code' ? () => toggle('code') : undefined}
                  className={`${HEAD} border border-white/25 ${
                    g.align === 'left' ? 'text-left' : 'text-center'
                  } ${g.key === 'code' ? sortable : ''}`}
                >
                  {g.label}{g.key === 'code' ? arrow('code') : ''}
                </th>
              ))}
            </tr>
            {/* Row 2 — the ACTUAL / SET POINT pairs. */}
            <tr>
              {COLUMN_GROUPS.filter((g) => g.sub).flatMap((g) =>
                g.sub!.map((label) => {
                  const key: SortKey | null =
                    label === 'Actual' && g.key === 'temp' ? 'temperature'
                    : label === 'Actual' && g.key === 'rh' ? 'humidity'
                    : null;
                  return (
                    <th
                      key={`${g.key}-${label}`}
                      style={bandSub}
                      onClick={key ? () => toggle(key) : undefined}
                      className={`${HEAD} border border-slate-300 text-center ${key ? sortable : ''}`}
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
                <td colSpan={COLSPAN} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading&hellip;
                </td>
              </tr>
            )}
            {!isLoading && shown.length === 0 && (
              <tr>
                <td colSpan={COLSPAN} className="px-4 py-8 text-center text-sm text-slate-500">
                  {rows.length === 0
                    ? 'No instruments registered yet.'
                    : 'No instruments match that filter.'}
                </td>
              </tr>
            )}
            {shown.map((r, i) => {
              const latest = [r.temperature?.ts, r.humidity?.ts].filter(Boolean).sort().pop() ?? null;
              const band = i % 2 === 0 ? 'bg-white' : 'bg-slate-50';
              // The limit breach lives HERE now that the status cell is
              // online/offline. Losing this styling loses the compliance signal.
              const tempBad = breaches(r.temperature?.value, r.limits?.tempMin, r.limits?.tempMax);
              const rhBad = breaches(r.humidity?.value, r.limits?.rhMin, r.limits?.rhMax);
              const val = (bad: boolean) =>
                `${CELL} tabular-nums border border-slate-300 ${
                  bad ? 'bg-red-100 font-bold text-red-800' : 'text-slate-800'
                }`;
              const spec = `${CELL} tabular-nums border border-slate-300 text-slate-600`;

              return (
                <tr key={r.instrumentId} className={`${band} hover:bg-slate-100`}>
                  <td className={`${CELL} border border-slate-300 text-left`}>
                    <Link
                      to={`/instruments/${r.instrumentId}`}
                      className="font-semibold text-slate-900 hover:underline"
                    >
                      {r.code}
                    </Link>
                    {/* Name, and the room the SET POINT comes from. Without the
                        room here, "18.0 - 25.0" has no visible source and an
                        unplaced instrument looks identical to one with no spec. */}
                    <div className="text-[11px] text-slate-500">
                      {r.name}
                      {r.room
                        ? <> &middot; {r.room.code}{r.room.label ? ` (${r.room.label})` : ''}</>
                        : <span className="italic"> &middot; not placed</span>}
                    </div>
                  </td>

                  <td className={val(tempBad)}>{actual(r.temperature, temperatureDecimals)}</td>
                  <td className={spec}>
                    {formatSetPoint(r.limits?.tempMin, r.limits?.tempMax, temperatureDecimals)}
                  </td>

                  <td className={val(rhBad)}>{actual(r.humidity, humidityDecimals)}</td>
                  <td className={spec}>
                    {formatSetPoint(r.limits?.rhMin, r.limits?.rhMax, humidityDecimals)}
                  </td>

                  {/* ONLINE / OFFLINE — solid cell, as the reference table does it.
                      The word carries the meaning; the colour only reinforces it. */}
                  <td className="border border-slate-300 p-0">
                    <div
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-white ${
                        r.reporting ? 'bg-emerald-600' : 'bg-red-600'
                      }`}
                      title={r.reporting
                        ? `Reporting — last reading ${readingAge(latest)}`
                        : `No telemetry within the expected interval — last reading ${readingAge(latest)}`}
                    >
                      {r.reporting ? 'Online' : 'Offline'}
                    </div>
                  </td>

                  <td className={`${CELL} border border-slate-300`}>
                    <div className="flex items-center justify-center gap-2">
                      <Link
                        to={`/instruments/${r.instrumentId}`}
                        className="font-semibold hover:underline"
                        style={{ color: 'var(--theme-primary-dark)' }}
                      >
                        {r.code}
                      </Link>
                      {r.room && (
                        <Link
                          to={`/instruments/${r.instrumentId}`}
                          title={`Trend — last reading ${readingAge(latest)}`}
                          aria-label={`Trend for ${r.code}`}
                          className="text-slate-500 hover:text-slate-800"
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
