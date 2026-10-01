import { useMemo, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { readingAge, oldestReadingTs } from './status';
import { formatSetPoint, outOfSpec, faultWord, boundInForce, NOT_AVAILABLE } from './set-point';
import { useSensorWords } from '@/hooks/use-failure-text';
import { usePanelToolbarSlot } from './panel-card';
import { formatDecimals, clampDecimals } from '@digilog/shared';
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

// 15px, up from 13 (operator, 2026-09-25: "in instruments readings increase
// font sizes and make bold"). The reading and set-point chips set their own
// size in `.tv-chip` / `.tv-spec` — those rules are unlayered and win anyway.
const CELL = 'px-2 py-2 text-center text-[0.9375rem] whitespace-nowrap';
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
  // A building for the FUNCTIONAL location and a folded map for the free-text
  // placement — two glyphs for two different facts, so the columns are not read
  // as repeats. The Room pin went with its column; an icon nothing keys to is a
  // decoy, and `ICON` is looked up by column key alone.
  area: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21h18M5 21V7l7-4 7 4v14M10 21v-5h4v5" />,
  location: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-6 2V6l6-2m0 16 6 2m-6-2V4m6 18 6-2V4l-6 2m0 16V6" />,
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

export interface ColumnGroup {
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

/**
 * THREE PLACEMENT COLUMNS, and they are three different facts (root CLAUDE.md,
 * "Instrument grouping — THREE concepts"). Do not collapse them:
 *
 *   **Area**     — `Instrument.functionalLocation.name`, the AUTHORITATIVE
 *                  Block > Area grouping. It is what the dashboard drill-down
 *                  navigates, what instrument visibility scopes resolve through,
 *                  and what the Alarms page's own Location column shows.
 *   **Location** — the instrument's own `Location` ATTRIBUTE, free text somebody
 *                  administered ("Dissolution & UV Room"), and what
 *                  `scripts/draw-cwh-floorplan.ts` names each drawn room from.
 *   **Room**     — `FloorplanRoom`, geometry on a drawn plan.
 *
 * Room's heading was "Location / Room" until 2026-09-01 and was renamed to just
 * **Room** when the other two arrived — a column called "Location / Room" beside
 * a column called "Location" invites the reader to treat them as one fact.
 * Everything the old heading justified still holds: the SET POINT columns come
 * FROM the room, so it must stay visible or "18.0 - 27.0" has no source.
 *
 * Both new columns take `tv-h-loc`, the existing teal placement hue, so no CSS
 * was added. That matters here: the `.tv-*` rules at the end of app.css are
 * deliberately UNLAYERED (see the note there), so a new one is not a free edit.
 *
 * Widths are hand-balanced and MUST total 100 — a grouped column counts once per
 * sub-column, so temp and rh contribute 10 x 2 each. `columnWidthTotal()` below
 * computes it and a unit test asserts it, since the <colgroup> is generated from
 * this list and a drifting total silently squeezes the readings. (temp and rh
 * are 10 x 2 each since 2026-09-25.)
 */
const COLUMN_GROUPS: ColumnGroup[] = [
  { key: 'code', label: 'Instrument ID', align: 'left', width: '12%', head: 'tv-h-id' },
  { key: 'area', label: 'Area', align: 'left', width: '12%', head: 'tv-h-loc' },
  // The widest text on the row lands here — "Working standard & reference
  // Standard storage Room (or) stability Room" — so the Room column's 11% went
  // mostly to this one rather than being spread evenly.
  // 20 → 16 on 2026-09-25, with Instrument ID and Area 14 → 12 each: the
  // reading and set-point CHIPS took the 8 points (temp / rh 8 → 10).
  { key: 'location', label: 'Location', align: 'left', width: '16%', head: 'tv-h-loc' },
  /**
   * There is NO Room column (operator, 2026-09-01). It was removed as a literal
   * duplicate of Location, and the database says so rather than the eye:
   *
   *   - The cell's PRIMARY text was the instrument's `name`, and on this
   *     installation `name` is byte-identical to the `Location` attribute on
   *     100 of the 100 instruments that carry one. Two columns, one string.
   *   - Its secondary line was blank on 88 of 101 rows (`room.code` equals the
   *     instrument code, `label` NULL), and on the 12 traced QC rooms it printed
   *     the room LABEL — "DISSOLUTION ROOM-II" against a name of "QC-II
   *     (Dissolution lab-II)", the same room shouted. The room NUMBER
   *     (`CWH-I/218`) never rendered at all: `label` won whenever it existed.
   *   - The 101st instrument is the IOTGW01 gateway, whose name equals its code.
   *
   * The old justification — "the SET POINT columns come FROM the room, so
   * without it 18.0-27.0 has no visible source" — had ALREADY lapsed: set-point
   * provenance is the `setPointSource()` tooltip below, and limits now resolve
   * from the instrument's own attributes first, with `limitSource` naming which.
   * A column kept for a reason that has expired is the hardest kind to notice.
   *
   * The room stays SEARCHABLE. See the filter below.
   */
  { key: 'temp', label: 'Temperature (°C)', sub: ['Actual', 'Set Point'], width: '10%', head: 'tv-h-temp', subHead: 'tv-sub-temp' },
  { key: 'rh', label: 'Humidity (%)', sub: ['Actual', 'Set Point'], width: '10%', head: 'tv-h-rh', subHead: 'tv-sub-rh' },
  { key: 'status', label: 'Status', width: '9%', head: 'tv-h-status' },
  // Added 2026-08-28. The payload always carried the reading timestamps and this
  // table only ever showed them in a tooltip, so a value that stopped updating an
  // hour ago looked exactly like a live one.
  { key: 'asOf', label: 'As Of', width: '7%', head: 'tv-h-asof' },
  { key: 'trend', label: 'Trend', width: '4%', head: 'tv-h-trend' },
];

/**
 * The declared widths, summed the way the browser sees them — once per rendered
 * column, so a two-sub group counts twice.
 *
 * Exported for its test. The `<colgroup>` cannot drift from `COLUMN_GROUPS`
 * because it is generated from it, but the PERCENTAGES are hand-balanced and a
 * column added without rebalancing overflows silently: `table-fixed` just
 * scales everything down, so nothing looks broken while every reading column
 * gets narrower.
 */
export function columnWidthTotal(groups: ColumnGroup[] = COLUMN_GROUPS): number {
  const total = groups.reduce(
    (n, g) => n + parseFloat(g.width) * (g.sub ? g.sub.length : 1),
    0,
  );
  // Two decimals: the widths are percentages with one, and floating-point
  // addition of 8 + 12 + 13 … does not land on a whole number exactly.
  return Math.round(total * 100) / 100;
}

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
 * An actual reading, the failure word, or NA — never a dash, so the table reads
 * consistently.
 *
 * **Three states, not two.** `failed` means the sensor REPORTED something that
 * is not a number (`NA` off a broken RS485 probe); NA means nothing arrived at
 * all. They used to render identically, which made a dead probe look like an
 * instrument nobody had wired up — the distinction is the point of the word.
 * `failed` comes from the server's `sensorError`, never from inspecting the
 * value here.
 *
 * `decimals` is the ROW's instrument precision (`r.decimals.temperature`), not a
 * page-wide setting. Through `formatDecimals`, which cannot throw — a stray
 * attribute value must not take the whole table down with a RangeError.
 */
function actual(
  v: { value: number } | null | undefined,
  decimals: number,
  fault?: { failed?: boolean; outOfRange?: boolean },
  words?: { failure: string; outOfRange: string },
): string {
  // The precedence between the two faults is shared with the trend page's
  // latest-value card — one rule, so a dead probe cannot be called `OL` here
  // and `Error` there.
  const word = faultWord(fault, words);
  if (word) return word;
  if (!v) return NOT_AVAILABLE;
  return formatDecimals(v.value, decimals) ?? NOT_AVAILABLE;
}

/**
 * The set point as a RANGE BADGE (operator, 2026-09-25: "temperature humidiy
 * ranges highlight is not good, make best highlight ui for those"). The blue
 * pill it replaced printed the range as one string; this draws the two bounds
 * as two figures with a bar between them, on a plate in the COLUMN's own hue —
 * the same orange / green the sub-headers wear — with a 3px accent down the
 * leading edge, so a range reads as a band of its column, not as a third
 * colour on the row. One bound in force prints its keyword (NMT / NLT) small
 * beside the figure, the words `formatSetPoint` already uses. No bound in
 * force prints a bare NA and no badge.
 *
 * `aria-label` is `formatSetPoint`'s string, so what a screen reader hears —
 * and what a test asserts — is unchanged by the drawing.
 */
function RangeBadge({ min, max, decimals, hue }: {
  min: number | null | undefined;
  max: number | null | undefined;
  decimals: number;
  hue: 'temp' | 'rh';
}) {
  const text = formatSetPoint(min, max, decimals);
  if (text === NOT_AVAILABLE) return <>{text}</>;
  const dp = clampDecimals(decimals);
  const f = (n: number) => n.toFixed(dp);
  const hasMin = boundInForce(min);
  const hasMax = boundInForce(max);
  return (
    <span className={`tv-range tv-range-${hue}`} aria-label={text} role="img">
      {hasMin && hasMax ? (
        <>
          <span className="tv-range-v">{f(min)}</span>
          <span className="tv-range-sep" aria-hidden="true" />
          <span className="tv-range-v">{f(max)}</span>
        </>
      ) : (
        <>
          <span className="tv-range-k">{hasMax ? 'NMT' : 'NLT'}</span>
          <span className="tv-range-v">{f(hasMax ? (max as number) : (min as number))}</span>
        </>
      )}
    </span>
  );
}

/** Where a set point came from, as a tooltip. */
function setPointSource(source: OverviewRow['limitSource']): string | undefined {
  if (source === 'INSTRUMENT') return "This instrument's own limit attributes — the same limits alarms are raised against.";
  if (source === 'ROOM') return 'The room specification. This instrument declares no limit attributes of its own.';
  return 'No limits set — neither this instrument nor its room specifies a range.';
}

export function TelemetryTable({ functionalLocationId, directOnly }: { functionalLocationId?: string; directOnly?: boolean } = {}) {
  // The administered word for a failed sensor. One hook, so the table, the
  // tiles and the Alarms page cannot show three different words for one fault.
  const sensorWords = useSensorWords();
  const toolbarSlot = usePanelToolbarSlot();
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
    // Every VISIBLE text column is searchable — the reader can see the word on
    // screen, so typing it must return the row.
    //
    // The ROOM is matched although no column shows it any more (2026-09-01), the
    // same call the Alarms page made for the same reason: matching MORE than is
    // shown costs the caller nothing and can only return rows they could already
    // see, whereas dropping it would silently stop a plan code someone typed from
    // finding anything. `name` is likewise kept — it is the same string the
    // Location column prints on every instrument that carries the attribute, and
    // the fallback for the one that does not.
    let filtered = q
      ? rows.filter((r) =>
          r.code.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          (r.functionalLocationName?.toLowerCase().includes(q) ?? false) ||
          (r.locationAttribute?.toLowerCase().includes(q) ?? false) ||
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

  /**
   * The search and the Filters disclosure, lifted into the CARD HEADER beside the
   * title (operator, 2026-09-01: *"give titles and filters in same line … dont
   * give in seperate lines, for all widgets"*).
   *
   * The title belongs to `PanelCard` and the controls belong here, so they were
   * two components and therefore two rows. `usePanelToolbarSlot()` is a portal
   * into that header; when it returns null — this component rendered on its own,
   * as the tests do — the row draws inline exactly where it used to, so the
   * search box is never missing.
   *
   * The wrapper lost `justify-between` and `flex-wrap` on the way up: in the
   * header it is ONE group that the slot's own `ml-auto` pushes right, and a row
   * allowed to wrap there would put the card back on two lines, which is the
   * thing being fixed. The search box narrows from `max-w-sm` to `w-44` to fit.
   */
  const toolbarRow = (
        <div className="flex flex-nowrap items-center gap-2">
          {/* Search, with the magnifier inside the field as the reference has it. */}
          <div className="relative w-44">
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
              /* The placeholder names every VISIBLE COLUMN the box matches — which
                 is the direction the rule runs. It exists to catch a column the
                 reader can see and the search silently ignores; it is NOT a
                 requirement to list fields with no column. `name` and the drawn
                 room are still matched (see the predicate above) and are
                 deliberately unnamed here: `name` prints the SAME string the
                 Location column does on every instrument carrying the attribute,
                 so naming it would advertise three things for one column. Same
                 call the Alarms page makes — it matches the room code and says
                 "instrument ID, name or location". */
              placeholder="Filter by instrument, area or location&hellip;"
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
  );

  return (
    <div className="space-y-3">
      {toolbarSlot ? createPortal(toolbarRow, toolbarSlot) : toolbarRow}

      <div className="overflow-hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-elevated">
        <table className="tbl-grid min-w-full table-fixed border-collapse">
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
              // HIGHLIGHTED (operator, 2026-09-25: "temperature and humidity
              // values and ranges should be visible like highlighted"): the
              // reading sits in a `.tv-chip` — a pill tinted from the cell's own
              // ink, so an in-spec reading is a green chip, a breach a red one —
              // and a slot with NO reading prints a plain grey NA, never a green
              // chip around nothing (`tv-val-na`). The set point is a
              // `RangeBadge` (below the column list) in the column's own hue.
              const val = (bad: boolean, hue: 'temp' | 'rh', empty: boolean) =>
                `tv-group tv-cell ${CELL} tabular-nums ${bad ? 'tv-val-bad' : empty ? 'tv-val-na' : `tv-val-${hue}`}`;
              // No size utility: `.tv-spec` / `.tv-chip` are unlayered and set the
              // size themselves, so a Tailwind text-[...] here would be overridden
              // and read as if it applied.
              const spec = `tv-cell ${CELL} tabular-nums tv-spec`;
              const tempText = actual(r.temperature, r.decimals.temperature, { failed: r.sensorError?.temperature, outOfRange: r.rangeError?.temperature }, sensorWords);
              const rhText = actual(r.humidity, r.decimals.humidity, { failed: r.sensorError?.humidity, outOfRange: r.rangeError?.humidity }, sensorWords);
              const chip = (text: string, unit?: string) =>
                text === NOT_AVAILABLE
                  ? text
                  : <span className="tv-chip">{text}{unit && <span className="tv-unit">{unit}</span>}</span>;

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

                  {/* AREA — the FUNCTIONAL location. Resolved SERVER-side
                      (`telemetry-overview.ts` selects the relation); this cell
                      never walks the Block > Area tree itself, which is the same
                      rule the `limits` and `decimals` on this row follow.

                      "Unassigned" rather than a blank, and it is the SAME word
                      `locationText()` prints on the Alarms page for the same
                      absence — a blank reads as a rendering fault, and two words
                      for one state would read as two states. */}
                  <td className={`tv-cell ${CELL} text-left !whitespace-normal`}>
                    {r.functionalLocationName
                      ? (
                        <span className="line-clamp-2 font-semibold text-slate-800" title={r.functionalLocationName}>
                          {r.functionalLocationName}
                        </span>
                      )
                      : <span className="text-[0.6875rem] italic text-slate-400">Unassigned</span>}
                  </td>

                  {/* LOCATION — the instrument's own `Location` ATTRIBUTE, the
                      free-text placement. NOT `Instrument.location`, the
                      superseded column of the same name, and not the drawn Room
                      beside it. The server sends the resolved value; the row
                      carries no attribute list to re-derive it from, deliberately.

                      "Not set" rather than "Unassigned": an absent attribute is
                      somebody not having typed one, which is a different absence
                      from having no functional location. */}
                  <td className={`tv-cell ${CELL} text-left !whitespace-normal`}>
                    {r.locationAttribute
                      ? (
                        <span className="line-clamp-2 font-semibold text-slate-800" title={r.locationAttribute}>
                          {r.locationAttribute}
                        </span>
                      )
                      : <span className="text-[0.6875rem] italic text-slate-400">Not set</span>}
                  </td>

                  <td
                    /* A FAULT paints red too (operator, 2026-09-01). `tempBad` is
                       `outOfSpec`, which is false here because a fault NULLS the
                       slot — so without this the administered word rendered in the
                       ordinary temperature hue and read like a healthy value. */
                    className={val(tempBad || Boolean(r.sensorError?.temperature || r.rangeError?.temperature), 'temp', tempText === NOT_AVAILABLE)}
                    title={tempBad ? 'Outside the room specification' : undefined}
                  >
                    {chip(tempText, r.temperature ? '°C' : undefined)}
                  </td>
                  {/* `title` only — the source is a tooltip, not a visible column:
                      it answers "why do two probes in one room show different
                      bands" when asked, without another cell to read past. */}
                  <td className={spec} title={setPointSource(r.limitSource)}>
                    <RangeBadge min={r.limits?.tempMin} max={r.limits?.tempMax} decimals={r.decimals.temperature} hue="temp" />
                  </td>

                  <td
                    className={val(rhBad || Boolean(r.sensorError?.humidity || r.rangeError?.humidity), 'rh', rhText === NOT_AVAILABLE)}
                    title={rhBad ? 'Outside the room specification' : undefined}
                  >
                    {chip(rhText, r.humidity ? '%' : undefined)}
                  </td>
                  <td className={spec} title={setPointSource(r.limitSource)}>
                    <RangeBadge min={r.limits?.rhMin} max={r.limits?.rhMax} decimals={r.decimals.humidity} hue="rh" />
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
                      // Tells the trend page's breadcrumb where the reader
                      // actually came from; without it the trail claims a
                      // path through Instruments that was never taken.
                      state={{ from: 'dashboard' }}
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
