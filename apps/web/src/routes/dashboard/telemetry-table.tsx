import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { readingAge } from './status';
import { formatSetPoint, outOfSpec, NOT_AVAILABLE } from './set-point';
import { formatDecimals } from '@digilog/shared';
import {
  useTelemetryOverview,
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
 * system produces differential pressure — no schema field for it — so the
 * column only ever showed NA. Re-adding it means adding the data first.
 *
 * DARK TABLE, on operator preference — a light themed version was tried and this
 * was preferred. The styling lives in the `.tv-*` block at the end of app.css, not
 * here, so the palette is one edit. The HEADER follows the app theme using its two
 * DARK tones (sidebar-bg, primary-dark), measured at worst 5.02:1 for white across
 * all 10 presets. Never put white text on `--theme-primary`: several presets
 * measure ~3.7:1, which fails at 11px.
 *
 * The column set is declared once in COLUMN_GROUPS; the operator is defining the
 * final content separately, so changing columns should be an edit to that list.
 */

const CELL = 'px-3 py-2.5 text-center text-[13px] whitespace-nowrap';
const HEAD = 'px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider';

/**
 * `width` is per COLUMN (so a group with two subs occupies 2 x width). Declared
 * here beside the labels so the <colgroup> below cannot drift out of step with
 * the header.
 *
 * Without explicit widths the browser sizes columns to content, and the
 * instrument sub-line ("Child A · not placed") stretched the ID column to roughly
 * 400px while squeezing the readings the table exists to show.
 */
const COLUMN_GROUPS = [
  { key: 'code', label: 'Instrument ID', align: 'left' as const, width: '24%' },
  { key: 'temp', label: 'Temp. (°C)', sub: ['Actual', 'Set Point'], width: '13%' },
  { key: 'rh', label: 'RH (%)', sub: ['Actual', 'Set Point'], width: '13%' },
  { key: 'status', label: 'Status', width: '12%' },
  { key: 'trend', label: 'Mimic / Trend', width: '12%' },
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

/**
 * An actual reading, or NA — never a dash, so the table reads consistently.
 *
 * `decimals` is the ROW's instrument precision (`r.decimals.temperature`), not a
 * page-wide setting. Through `formatDecimals`, which cannot throw — a stray
 * attribute value must not take the whole table down with a RangeError.
 */
function actual(v: { value: number } | null | undefined, decimals: number): string {
  if (!v) return NOT_AVAILABLE;
  return formatDecimals(v.value, decimals) ?? NOT_AVAILABLE;
}

/** Where a set point came from, as a tooltip. */
function setPointSource(source: OverviewRow['limitSource']): string | undefined {
  if (source === 'INSTRUMENT') return "This instrument's own limit attributes — the same limits alarms are raised against.";
  if (source === 'ROOM') return 'The room specification. This instrument declares no limit attributes of its own.';
  return 'No limits set — neither this instrument nor its room specifies a range.';
}

export function TelemetryTable({ functionalLocationId, directOnly }: { functionalLocationId?: string; directOnly?: boolean } = {}) {
  const { rows, isLoading, error, refreshMs } = useTelemetryOverview({ functionalLocationId, directOnly });
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
  const offlineCount = shown.filter((r) => !r.reporting).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by instrument, name or room&hellip;"
          className="w-full max-w-sm rounded-lg border border-slate-500 px-3 py-2 text-sm focus:outline-none focus:ring-2"
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

      <div
        className="overflow-hidden overflow-x-auto rounded-xl bg-slate-700 shadow-elevated"
        style={{ border: '1px solid color-mix(in srgb, var(--theme-primary) 30%, white)' }}
      >
        <table className="min-w-full table-fixed border-collapse">
          <colgroup>
            {COLUMN_GROUPS.flatMap((g) =>
              Array.from({ length: g.sub ? g.sub.length : 1 }, (_, i) => (
                <col key={`${g.key}-${i}`} style={{ width: g.width }} />
              )),
            )}
          </colgroup>
          <thead>
            {/* Row 1 — measurement groups. */}
            <tr>
              {COLUMN_GROUPS.map((g) => (
                <th
                  key={g.key}
                  colSpan={g.sub ? g.sub.length : 1}
                  rowSpan={g.sub ? 1 : 2}
                  onClick={g.key === 'code' ? () => toggle('code') : undefined}
                  className={`tv-head ${HEAD} border border-white/20 ${
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
                      onClick={key ? () => toggle(key) : undefined}
                      className={`tv-subhead ${HEAD} border border-white/40 text-center ${
                        label === 'Actual' ? 'tv-group' : ''
                      } ${key ? sortable : ''}`}
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
                <td colSpan={COLSPAN} className="bg-slate-700 px-4 py-8 text-center text-sm text-slate-200">
                  Loading&hellip;
                </td>
              </tr>
            )}
            {!isLoading && shown.length === 0 && (
              <tr>
                <td colSpan={COLSPAN} className="bg-slate-700 px-4 py-8 text-center text-sm text-slate-200">
                  {rows.length === 0
                    ? 'No instruments registered yet.'
                    : 'No instruments match that filter.'}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const latest = [r.temperature?.ts, r.humidity?.ts].filter(Boolean).sort().pop() ?? null;
              // The limit breach lives HERE now that the status cell is
              // online/offline. Losing this styling loses the compliance signal.
              const tempBad = outOfSpec(r.temperature?.value, r.limits?.tempMin, r.limits?.tempMax);
              const rhBad = outOfSpec(r.humidity?.value, r.limits?.rhMin, r.limits?.rhMax);
              // ACTUAL is the number people read; SET POINT is reference. Weight
              // and size carry that, so the eye lands on the reading first.
              const val = (bad: boolean) =>
                `tv-group ${CELL} tabular-nums border border-slate-500 text-[15px] font-semibold ${
                  bad ? 'bg-red-900/60 text-rose-100' : 'text-white'
                }`;
              const spec = `${CELL} tabular-nums border border-slate-500 text-[12px] text-slate-200`;

              return (
                <tr key={r.instrumentId} className="tv-row transition-colors">
                  <td className={`${CELL} border border-slate-500 text-left !whitespace-normal`}>
                    <Link
                      to={`/instruments/${r.instrumentId}`}
                      className="font-semibold text-white hover:underline"
                    >
                      {r.code}
                    </Link>
                    {/* Name, and the room the SET POINT comes from. Without the
                        room here, "18.0 - 25.0" has no visible source and an
                        unplaced instrument looks identical to one with no spec. */}
                    <div className="truncate text-[11px] text-slate-300">
                      {r.name}
                      {r.room
                        ? <> &middot; {r.room.code}{r.room.label ? ` (${r.room.label})` : ''}</>
                        : <span className="italic"> &middot; not placed</span>}
                    </div>
                  </td>

                  <td
                    className={val(tempBad)}
                    style={tempBad ? { boxShadow: 'inset 3px 0 0 #fca5a5' } : undefined}
                    title={tempBad ? 'Outside the room specification' : undefined}
                  >
                    {actual(r.temperature, r.decimals.temperature)}
                  </td>
                  {/* `title` only — the source is a tooltip, not a visible column:
                      it answers "why do two probes in one room show different
                      bands" when asked, without another cell to read past. */}
                  <td className={spec} title={setPointSource(r.limitSource)}>
                    {formatSetPoint(r.limits?.tempMin, r.limits?.tempMax, r.decimals.temperature)}
                  </td>

                  <td
                    className={val(rhBad)}
                    style={rhBad ? { boxShadow: 'inset 3px 0 0 #fca5a5' } : undefined}
                    title={rhBad ? 'Outside the room specification' : undefined}
                  >
                    {actual(r.humidity, r.decimals.humidity)}
                  </td>
                  <td className={spec} title={setPointSource(r.limitSource)}>
                    {formatSetPoint(r.limits?.rhMin, r.limits?.rhMax, r.decimals.humidity)}
                  </td>

                  {/* ONLINE / OFFLINE — solid cell, as the reference table does it.
                      The word carries the meaning; the colour only reinforces it. */}
                  <td className="tv-group border border-slate-500 p-0">
                    <div
                      className={`flex items-center justify-center gap-1.5 px-3 py-2.5 text-[12px] font-bold uppercase tracking-wider text-white ${
                        r.reporting
                          ? 'bg-gradient-to-b from-emerald-500 to-emerald-700'
                          : 'bg-gradient-to-b from-red-500 to-red-700'
                      }`}
                      title={r.reporting
                        ? `Reporting — last reading ${readingAge(latest)}`
                        : `No telemetry within the expected interval — last reading ${readingAge(latest)}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${r.reporting ? 'bg-emerald-200' : 'bg-red-200'}`} />
                      {r.reporting ? 'Online' : 'Offline'}
                    </div>
                  </td>

                  <td className={`tv-group ${CELL} border border-slate-500`}>
                    <div className="flex items-center justify-center gap-2">
                      {/* BOTH links in this cell go to the trend page. The
                          column is headed "Mimic / Trend", so every target in
                          it must be a trend — this code link pointed at the
                          instrument's config page until 2026-08-24, which meant
                          clicking the obvious thing (the instrument's name) in a
                          column labelled Trend silently took you somewhere else.
                          The identity column on the far left is where you go to
                          CONFIGURE an instrument; this column is where you go to
                          LOOK at it. */}
                      <Link
                        to={`/instruments/${r.instrumentId}/trend`}
                        title={`Trend page for ${r.code}`}
                        className="font-semibold text-sky-200 hover:text-white hover:underline"
                      >
                        {r.code}
                      </Link>
                      {/* Not gated on `r.room`: an instrument's history does not
                          depend on whether anyone has drawn it on a floorplan —
                          an unplaced instrument still has readings to trend. */}
                      <Link
                        to={`/instruments/${r.instrumentId}/trend`}
                        title={`Trend page — last reading ${readingAge(latest)}`}
                        aria-label={`Open trend page for ${r.code}`}
                        className="text-slate-200 hover:text-white"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 17l4-6 4 3 5-8 5 6" />
                        </svg>
                      </Link>
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
