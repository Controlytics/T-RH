import { useMemo, useState } from 'react';
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
  { key: 'code', label: 'Instrument ID', align: 'left', width: '16%', head: 'tv-h-id' },
  // Its OWN column since 2026-08-29, as the reference has it. It used to be a
  // sub-line under the ID. The reason it must appear somewhere is unchanged: the
  // SET POINT columns come FROM the room, so without it "18.0 - 27.0" has no
  // visible source and an unplaced instrument looks like one whose room simply
  // has no specification.
  { key: 'room', label: 'Location / Room', align: 'left', width: '18%', head: 'tv-h-loc' },
  { key: 'temp', label: 'Temperature (°C)', sub: ['Actual', 'Set Point'], width: '10%', head: 'tv-h-temp', subHead: 'tv-sub-temp' },
  { key: 'rh', label: 'Humidity (%)', sub: ['Actual', 'Set Point'], width: '10%', head: 'tv-h-rh', subHead: 'tv-sub-rh' },
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
  const { rows, isLoading, error, refreshMs, refresh, isValidating } = useTelemetryOverview({ functionalLocationId, directOnly });
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by instrument, name or room&hellip;"
            className="ctl w-full !pl-9"
            style={{ ['--tw-ring-color' as string]: 'var(--theme-primary)' } as React.CSSProperties}
          />
        </div>

        <div className="flex items-center gap-3">
          {/* Stated, not implied: this is a poll, not a live stream. */}
          <p className="text-xs text-slate-500">
            {shown.length} of {rows.length} instruments
            {offlineCount > 0 && (
              <> &middot; <span className="font-semibold text-red-700">{offlineCount} offline</span></>
            )}
            {' '}&middot; updates every {Math.round(refreshMs / 1000)}s
          </p>
          {/* Manual refresh. The poll above still runs — this is for the reader who
              wants the answer now rather than at the end of the interval. It
              revalidates the SAME SWR key, so it cannot race the poll. */}
          <button
            type="button"
            onClick={() => { void refresh(); }}
            disabled={isValidating}
            title="Refresh readings now"
            aria-label="Refresh readings now"
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50"
          >
            <svg
              className={`h-4 w-4 ${isValidating ? 'animate-spin' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M20 9A8 8 0 006 5.3M4 15a8 8 0 0014 3.7" />
            </svg>
          </button>
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
            {shown.map((r) => {
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
              const val = (bad: boolean, tint: string) =>
                `tv-group tv-cell ${tint} ${CELL} tabular-nums text-[0.9375rem] ${bad ? 'tv-val-bad' : 'tv-val'}`;
              const spec = (tint: string) =>
                `tv-cell ${tint} ${CELL} tabular-nums text-[0.75rem] tv-spec`;

              return (
                <tr key={r.instrumentId} className="tv-row transition-colors">
                  <td className={`tv-cell tv-c-id ${CELL} text-left`}>
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
                  <td className={`tv-cell tv-c-loc ${CELL} text-left !whitespace-normal`}>
                    <span className="font-medium text-slate-700">{r.name}</span>
                    {r.room
                      ? (r.room.label ?? (r.room.code === r.code ? null : r.room.code)) && (
                          <div className="text-[0.6875rem] text-slate-500">
                            {r.room.label ?? r.room.code}
                          </div>
                        )
                      : <div className="text-[0.6875rem] italic text-slate-400">Not placed</div>}
                  </td>

                  <td
                    className={val(tempBad, 'tv-c-temp')}
                    title={tempBad ? 'Outside the room specification' : undefined}
                  >
                    {actual(r.temperature, r.decimals.temperature)}
                  </td>
                  {/* `title` only — the source is a tooltip, not a visible column:
                      it answers "why do two probes in one room show different
                      bands" when asked, without another cell to read past. */}
                  <td className={spec('tv-c-temp-sp')} title={setPointSource(r.limitSource)}>
                    {formatSetPoint(r.limits?.tempMin, r.limits?.tempMax, r.decimals.temperature)}
                  </td>

                  <td
                    className={val(rhBad, 'tv-c-rh')}
                    title={rhBad ? 'Outside the room specification' : undefined}
                  >
                    {actual(r.humidity, r.decimals.humidity)}
                  </td>
                  <td className={spec('tv-c-rh-sp')} title={setPointSource(r.limitSource)}>
                    {formatSetPoint(r.limits?.rhMin, r.limits?.rhMax, r.decimals.humidity)}
                  </td>

                  {/* ONLINE / OFFLINE as a pill, per the reference. The word carries
                      the meaning; the colour only reinforces it. */}
                  <td className={`tv-group tv-cell tv-c-status ${CELL}`}>
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
                    className={`tv-cell tv-c-asof ${CELL} text-slate-600`}
                    title={asOf ? new Date(asOf).toLocaleString() : 'This instrument has never reported'}
                  >
                    {readingAge(asOf)}
                  </td>

                  {/* Just the arrow, as the reference has it. The duplicate code
                      link that used to sit beside it pointed at the SAME trend
                      page as the arrow, and the identity column already carries
                      the code — it was a third link to two destinations. */}
                  <td className={`tv-cell tv-c-trend ${CELL}`}>
                    <Link
                      to={`/instruments/${r.instrumentId}/trend`}
                      title={`Trend page for ${r.code} — last reading ${readingAge(latest)}`}
                      aria-label={`Open trend page for ${r.code}`}
                      className="inline-flex text-blue-600 transition-colors hover:text-blue-800"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 17l4-6 4 3 5-8 5 6" />
                      </svg>
                    </Link>
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
