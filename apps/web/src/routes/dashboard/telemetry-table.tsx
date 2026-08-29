import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { readingAge, oldestReadingTs } from './status';
import { formatSetPoint, outOfSpec, NOT_AVAILABLE } from './set-point';
import { formatDecimals } from '@digilog/shared';
import {
  useTelemetryOverview,
  type OverviewRow,
} from './use-telemetry';

/**
 * TABULAR VIEW — the room-condition overview, laid out to the operator's
 * reference table (`screen-2.png`, 2026-08-29): a two-row grouped header where
 * each measurement is split into ACTUAL and SET POINT, a status pill, and a trend
 * link per row.
 *
 * ROWS ARE INSTRUMENTS and INSTRUMENT ID leads (operator request). The room has
 * its OWN column as of 2026-08-29 — it was a sub-line under the ID before. It has
 * to appear somewhere either way, because the SET POINT columns come FROM the
 * room: remove it and a spec of "18.0 - 25.0" has no visible source, and an
 * unplaced instrument becomes indistinguishable from one whose room simply has no
 * specification.
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
 * LIGHT AND COLOUR-CODED to `screen-2.png` (2026-08-29). This REPLACED the dark
 * table chosen on 2026-08-13; the operator supplied the new reference and asked
 * for it, so that earlier preference is superseded. Each column carries its own
 * hue — identity blue, location teal, temperature orange, humidity green, status
 * violet — which is what lets the eye find a column in a dense grid.
 *
 * The palette lives in the `.tv-*` block at the end of app.css, NOT here, so it is
 * one edit. Two constraints are recorded there and matter: those rules are
 * UNLAYERED and therefore beat every Tailwind utility, so cell backgrounds must
 * come from `.tv-*` and never from a `bg-*` class; and the header hues are one
 * step darker than the reference image because 11px bold uppercase needs 4.5:1
 * against white and the image's brighter tones do not reach it.
 *
 * NO AMBER "NEAR LIMIT" STATE, despite one appearing in the reference image (a
 * humidity of 44 shown amber inside a 0-70 band). Nothing in this system defines
 * a near-limit threshold, and inventing one in the browser would be exactly the
 * client-side policy re-derivation this codebase forbids. Values are in-spec green
 * or breach red, decided by the same `outOfSpec` the alarms agree with.
 *
 * The column set is declared once in COLUMN_GROUPS; the operator is defining the
 * final content separately, so changing columns should be an edit to that list.
 */

const CELL = 'px-2 py-2 text-center text-[0.8125rem] whitespace-nowrap';
const HEAD = 'px-2 py-2 text-[0.6875rem] font-bold uppercase tracking-wider';

/**
 * `width` is per COLUMN (so a group with two subs occupies 2 x width). Declared
 * here beside the labels so the <colgroup> below cannot drift out of step with
 * the header.
 *
 * Without explicit widths the browser sizes columns to content, and the
 * instrument sub-line ("Child A · not placed") stretched the ID column to roughly
 * 400px while squeezing the readings the table exists to show.
 */
/**
 * Header glyphs, one per column, as the reference has them. Inline rather than an
 * icon package: six paths weigh less than a dependency, and they must inherit
 * `currentColor` to sit on the gradient headers.
 */
const ICON: Record<string, ReactElement> = {
  code: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h10M7 16h6" />,
  room: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z M12 10a1 1 0 100-2 1 1 0 000 2z" />,
  temp: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14V5a2 2 0 114 0v9a4 4 0 11-4 0z" />,
  rh: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3s6 6.5 6 10a6 6 0 11-12 0c0-3.5 6-10 6-10z" />,
  status: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 11-6 0" />,
  asOf: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />,
  trend: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 17l6-6 4 4 8-8" />,
};

function HeadIcon({ name }: { name: string }) {
  if (!ICON[name]) return null;
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {ICON[name]}
    </svg>
  );
}

interface ColumnGroup {
  key: string;
  label: string;
  align?: 'left';
  width: string;
  /** Solid header colour for this column — see the `.tv-h-*` block in app.css. */
  head: string;
  sub?: string[];
  /** Light tint for the ACTUAL / SET POINT row beneath a grouped header. */
  subHead?: string;
}

const COLUMN_GROUPS: ColumnGroup[] = [
  { key: 'code', label: 'Instrument ID', align: 'left', width: '15%', head: 'tv-h-id' },
  // Its OWN column since 2026-08-29, as the reference has it. It used to be a
  // sub-line under the ID. The reason it must appear somewhere is unchanged: the
  // SET POINT columns come FROM the room, so without it "18.0 - 27.0" has no
  // visible source and an unplaced instrument looks like one whose room simply
  // has no specification.
  { key: 'room', label: 'Location / Room', align: 'left', width: '21%', head: 'tv-h-loc' },
  { key: 'temp', label: 'Temperature (°C)', sub: ['Actual', 'Set Point'], width: '9.5%', head: 'tv-h-temp', subHead: 'tv-sub-temp' },
  { key: 'rh', label: 'Humidity (%)', sub: ['Actual', 'Set Point'], width: '9.5%', head: 'tv-h-rh', subHead: 'tv-sub-rh' },
  { key: 'status', label: 'Status', width: '10%', head: 'tv-h-status' },
  // Added 2026-08-28. The payload always carried the reading timestamps and this
  // table only ever showed them in a tooltip, so a value that stopped updating an
  // hour ago looked exactly like a live one.
  { key: 'asOf', label: 'As Of', width: '9%', head: 'tv-h-asof' },
  { key: 'trend', label: 'Trend', width: '7%', head: 'tv-h-trend' },
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
  const { rows, isLoading, error } = useTelemetryOverview({ functionalLocationId, directOnly });
  const [sort, setSort] = useState<SortKey>('code');
  const [asc, setAsc] = useState(true);
  const [query, setQuery] = useState('');
  // Filters and paging, both from the reference's toolbar and footer. Client-side
  // on purpose: the overview payload is already the whole (visibility-scoped) set
  // in hand, so paging it here costs no request and cannot disagree with the
  // counts beside the search box.
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [breachOnly, setBreachOnly] = useState(false);
  const [perPage, setPerPage] = useState(25);
  const [page, setPage] = useState(1);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let filtered = q
      ? rows.filter((r) =>
          r.code.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          (r.room?.code.toLowerCase().includes(q) ?? false) ||
          (r.room?.label?.toLowerCase().includes(q) ?? false))
      : rows;
    if (statusFilter !== 'all') {
      const want = statusFilter === 'online';
      filtered = filtered.filter((r) => r.reporting === want);
    }
    // "Out of spec" asks the SAME question the red readings answer, through the
    // same `outOfSpec` — so the filter and the colouring can never disagree.
    if (breachOnly) {
      filtered = filtered.filter((r) =>
        outOfSpec(r.temperature?.value, r.limits?.tempMin, r.limits?.tempMax) ||
        outOfSpec(r.humidity?.value, r.limits?.rhMin, r.limits?.rhMax));
    }
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort);
      const bv = sortValue(b, sort);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return asc ? cmp : -cmp;
    });
  }, [rows, sort, asc, query, statusFilter, breachOnly]);

  // Paging derived, never stored: a stored page survives a filter that shortens
  // the list and strands the reader on an empty screen. Clamped instead.
  const pageCount = Math.max(1, Math.ceil(shown.length / perPage));
  const current = Math.min(page, pageCount);
  const paged = useMemo(
    () => shown.slice((current - 1) * perPage, current * perPage),
    [shown, current, perPage],
  );

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
  const activeFilters = (statusFilter !== 'all' ? 1 : 0) + (breachOnly ? 1 : 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Search, with the magnifier inside the field as the reference has it. */}
        <div className="relative w-full max-w-sm">
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Filter by instrument, name or room&hellip;"
            className="ctl w-full !pl-9"
            style={{ ['--tw-ring-color' as string]: 'var(--theme-primary)' } as React.CSSProperties}
          />
        </div>

        {/* Filters. A visible control that did nothing would be worse than no
            control, so it carries the two questions this table can actually
            answer from the payload already in hand. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition-colors ${
              activeFilters > 0
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            Filters
            {activeFilters > 0 && (
              <span className="rounded-full bg-blue-600 px-1.5 text-[0.625rem] font-bold text-white">{activeFilters}</span>
            )}
          </button>
          {showFilters && (
            <div className="absolute left-0 z-20 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
              <p className="mb-1.5 text-[0.6875rem] font-bold uppercase tracking-wider text-slate-400">Status</p>
              {(['all', 'online', 'offline'] as const).map((v) => (
                <label key={v} className="flex cursor-pointer items-center gap-2 py-1 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="tv-status"
                    checked={statusFilter === v}
                    onChange={() => { setStatusFilter(v); setPage(1); }}
                  />
                  {v === 'all' ? 'All' : v === 'online' ? 'Online' : 'Offline'}
                </label>
              ))}
              <label className="mt-2 flex cursor-pointer items-center gap-2 border-t border-slate-100 pt-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={breachOnly}
                  onChange={(e) => { setBreachOnly(e.target.checked); setPage(1); }}
                />
                Out of spec only
              </label>
            </div>
          )}
        </div>

      </div>

      <div className="overflow-hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-elevated">
        <table className="min-w-full table-fixed border-collapse">
          <colgroup>
            {COLUMN_GROUPS.flatMap((g) =>
              Array.from({ length: g.sub ? g.sub.length : 1 }, (_, i) => (
                <col key={`${g.key}-${i}`} style={{ width: g.width }} />
              )),
            )}
          </colgroup>
          <thead>
            {/* Row 1 — measurement groups, each in its own hue. */}
            <tr>
              {COLUMN_GROUPS.map((g) => (
                <th
                  key={g.key}
                  colSpan={g.sub ? g.sub.length : 1}
                  rowSpan={g.sub ? 1 : 2}
                  onClick={g.key === 'code' ? () => toggle('code') : undefined}
                  className={`${g.head} ${HEAD} border border-white/25 ${
                    g.align === 'left' ? 'text-left' : 'text-center'
                  } ${g.key === 'code' ? sortable : ''}`}
                >
                  <span className={`flex items-center gap-1.5 ${g.align === 'left' ? '' : 'justify-center'}`}>
                    <HeadIcon name={g.key} />
                    {g.label}{g.key === 'code' ? arrow('code') : ''}
                  </span>
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
                      className={`${g.subHead} ${HEAD} border border-white/40 text-center ${
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
            {paged.map((r) => {
              const latest = [r.temperature?.ts, r.humidity?.ts].filter(Boolean).sort().pop() ?? null;
              // The OLDER of the two, which is a different question from `latest`
              // above: that one drives the Status tooltip and asks "are we hearing
              // from this instrument at all". This asks "how stale might the
              // numbers ON THIS ROW be", and the freshest of two values cannot
              // answer it.
              const asOf = oldestReadingTs(r.temperature, r.humidity);
              // The limit breach lives HERE now that the status cell is
              // online/offline. Losing this styling loses the compliance signal.
              const tempBad = outOfSpec(r.temperature?.value, r.limits?.tempMin, r.limits?.tempMax);
              const rhBad = outOfSpec(r.humidity?.value, r.limits?.rhMin, r.limits?.rhMax);
              // ACTUAL is the number people read; SET POINT is reference. Weight
              // and size carry that, so the eye lands on the reading first.
              // Hue while in spec, red on breach — see the `.tv-val-*` note in app.css.
              const val = (bad: boolean, hue: 'temp' | 'rh') =>
                `tv-group tv-cell ${CELL} tabular-nums text-[0.9375rem] ${bad ? 'tv-val-bad' : `tv-val-${hue}`}`;
              const spec = `tv-cell ${CELL} tabular-nums text-[0.75rem] tv-spec`;

              return (
                <tr key={r.instrumentId} className="tv-row transition-colors">
                  <td className={`tv-cell ${CELL} text-left`}>
                    <Link
                      to={`/instruments/${r.instrumentId}`}
                      className="font-bold text-blue-700 hover:underline"
                    >
                      {r.code}
                    </Link>
                  </td>

                  {/* Location / Room. The PRIMARY text is the instrument's `name`,
                      which is what the reference shows here and what actually
                      names the location in this data: verified against the
                      database 2026-08-29, every `floorplan_rooms.label` is NULL
                      and every `floorplan_rooms.code` is a verbatim copy of the
                      instrument code, so `room.code` would just repeat the ID
                      column. The room is still shown when it says something the
                      ID does not — that is the SET POINT's visible source, and
                      without it "18.0 - 27.0" comes from nowhere.

                      "Not placed" stays explicit: a blank cell would read as a
                      missing value rather than an unplaced instrument. */}
                  <td className={`tv-cell ${CELL} text-left !whitespace-normal`}>
                    <span className="flex items-start gap-1.5 font-medium text-slate-700" title={r.name}>
                      <svg aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="9" strokeWidth={2} />
                        <circle cx="12" cy="12" r="3" strokeWidth={2} />
                      </svg>
                      <span className="line-clamp-2">{r.name}</span>
                    </span>
                    {r.room
                      ? (r.room.label ?? (r.room.code === r.code ? null : r.room.code)) && (
                          <div className="text-[0.6875rem] text-slate-500">
                            {r.room.label ?? r.room.code}
                          </div>
                        )
                      : <div className="text-[0.6875rem] italic text-slate-400">Not placed</div>}
                  </td>

                  <td
                    className={val(tempBad, 'temp')}
                    title={tempBad ? 'Outside the room specification' : undefined}
                  >
                    {actual(r.temperature, r.decimals.temperature)}
                    {r.temperature && <span className="tv-unit">°C</span>}
                  </td>
                  {/* `title` only — the source is a tooltip, not a visible column:
                      it answers "why do two probes in one room show different
                      bands" when asked, without another cell to read past. */}
                  <td className={spec} title={setPointSource(r.limitSource)}>
                    {formatSetPoint(r.limits?.tempMin, r.limits?.tempMax, r.decimals.temperature)}
                  </td>

                  <td
                    className={val(rhBad, 'rh')}
                    title={rhBad ? 'Outside the room specification' : undefined}
                  >
                    {actual(r.humidity, r.decimals.humidity)}
                    {r.humidity && <span className="tv-unit">%</span>}
                  </td>
                  <td className={spec} title={setPointSource(r.limitSource)}>
                    {formatSetPoint(r.limits?.rhMin, r.limits?.rhMax, r.decimals.humidity)}
                  </td>

                  {/* ONLINE / OFFLINE as a pill, per the reference. The word carries
                      the meaning; the colour only reinforces it. */}
                  <td className={`tv-group tv-cell ${CELL}`}>
                    <span
                      className={`tv-pill ${r.reporting ? 'tv-pill-on' : 'tv-pill-off'}`}
                      title={r.reporting
                        ? `Reporting — last reading ${readingAge(latest)}`
                        : `No telemetry within the expected interval — last reading ${readingAge(latest)}`}
                    >
                      <span className="tv-dot" />
                      {r.reporting ? 'Online' : 'Offline'}
                    </span>
                  </td>

                  {/* How stale the readings on this row are. The absolute time is on
                      hover; the cell stays coarse, because the reader is asking "is
                      this current?" and a to-the-second figure on a 30-second cadence
                      changes on every poll for no information gained. */}
                  <td
                    className={`tv-cell ${CELL} text-slate-600`}
                    title={asOf ? new Date(asOf).toLocaleString() : 'This instrument has never reported'}
                  >
                    <span className="flex items-center justify-center gap-1.5 text-slate-600">
                      <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {readingAge(asOf)}
                    </span>
                  </td>

                  {/* Just the arrow, as the reference has it. The duplicate code
                      link that used to sit beside it pointed at the SAME trend
                      page as the arrow, and the identity column already carries
                      the code — it was a third link to two destinations. */}
                  <td className={`tv-cell ${CELL}`}>
                    <Link
                      to={`/instruments/${r.instrumentId}/trend`}
                      title={`Trend page for ${r.code} — last reading ${readingAge(latest)}`}
                      aria-label={`Open trend page for ${r.code}`}
                      className="inline-flex text-blue-600 transition-colors hover:text-blue-800"
                    >
                      {/* An ICON, deliberately, not a sparkline. The reference draws a
                          little line per row; a real one needs each instrument's
                          HISTORY, which this overview endpoint does not return — and a
                          decorative squiggle shaped like a chart would be read as data
                          it is not. Clicking through gives the true series. */}
                      <svg className="h-5 w-8" fill="none" stroke="currentColor" viewBox="0 0 32 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 18l5-6 4 4 5-8 4 5 4-4 4 3" />
                      </svg>
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Rows per page + pager, as the reference has them. Purely a view over
          `shown`; nothing here refetches. */}
      {shown.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <label className="flex items-center gap-2 text-xs text-slate-500">
            Rows per page:
            <select
              value={perPage}
              onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
              className="ctl !py-1 !text-xs"
            >
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>

          <div className="flex items-center gap-1">
            <span className="mr-2 text-xs text-slate-500">
              {(current - 1) * perPage + 1}&ndash;{Math.min(current * perPage, shown.length)} of {shown.length}
            </span>
            {([
              { label: '«', to: 1, off: current === 1 },
              { label: '‹', to: current - 1, off: current === 1 },
            ]).map((b) => (
              <button
                key={b.label}
                type="button"
                onClick={() => setPage(b.to)}
                disabled={b.off}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 disabled:opacity-40 hover:bg-slate-50"
              >{b.label}</button>
            ))}
            <span className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white">{current}</span>
            {([
              { label: '›', to: current + 1, off: current === pageCount },
              { label: '»', to: pageCount, off: current === pageCount },
            ]).map((b) => (
              <button
                key={b.label}
                type="button"
                onClick={() => setPage(b.to)}
                disabled={b.off}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 disabled:opacity-40 hover:bg-slate-50"
              >{b.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
