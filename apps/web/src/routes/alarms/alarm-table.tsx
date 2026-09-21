import type { CSSProperties, ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  quadrantTone, statusText, breachDirection, triggeredText, clearedText, screenLimitText,
  alarmTypeText, alarmDurationText, instrumentLabel, locationText, areaText,
  type AlarmRow, type AlarmSortKey, type AlarmStatusTexts, type AlarmDisplayTexts,
  type QuadrantTone, type BreachDirection,
} from './alarm-display';

/**
 * The alarm table, as a vocabulary of cells rather than a component.
 *
 * ONE definition, shared by the Alarms page (`routes/alarms/index.tsx`) and the
 * trend page's "Alarms in this period" widget
 * (`routes/instruments/alarms-widget.tsx`). Those two screens describe the same
 * regulated records, and until 2026-09-01 they did it with two hand-written
 * tables — the widget keyed its status pill off SEVERITY, which is the exact
 * defect the Alarms page had fixed a day earlier, so on this installation
 * (where every alarm is CRITICAL) every pill in the widget rendered red.
 *
 * **This module is presentation only.** It holds no fetch, no filter, no sort
 * state and no acknowledge mutation — the two pages get their rows in
 * completely different ways (the Alarms page filters, counts, sorts and pages
 * SERVER-side; the widget takes one instrument's alarms and windows them on
 * `raisedAt` in the browser) and folding those into one configurable table
 * component would have meant reshaping a data flow that is correct.
 *
 * A vocabulary of cells rather than a `<AlarmTable columns={...}>`: the two
 * screens genuinely show different columns (the widget is scoped to ONE
 * instrument in ONE period, so Instrument ID and Location say the same thing on
 * every row), and a column-config prop would encode that difference as data
 * while still forcing both callers through one render path.
 */

/**
 * The row's left edge marker, in the same four tones the count cards use.
 * `StatusBadge`'s own token palette is designed for a tinted pill, which is too
 * pale to read as a 4px rule, so these are the solid counterparts.
 */
export const ACCENT: Record<QuadrantTone, string> = {
  danger: 'bg-rose-500',
  info: 'bg-sky-500',
  warn: 'bg-amber-500',
  ok: 'bg-emerald-500',
};

/**
 * The value's ink says which WAY the reading broke — warm for a high breach,
 * cold for a low one. Direction comes from what the evaluator recorded, never
 * from comparing the number to the limit here.
 */
export const VALUE_INK: Record<BreachDirection, string> = {
  high: 'text-rose-600',
  low: 'text-sky-600',
  none: 'text-slate-900',
};

/**
 * The dark banner, painted from the site theme rather than a hardcoded indigo,
 * so every alarm table follows all ten colour presets instead of being the one
 * surface with a palette of its own.
 *
 * Exported as a style object as well as a component because the sticky action
 * column needs the SOLID theme colour behind it — a gradient repeated on one
 * cell would not line up with the band it sits in.
 */
/**
 * UI v3 (2026-09-21): the banner is `--band-gradient`, the same band every
 * shared table header wears, so the three alarm tables and the rest of the
 * product cannot drift apart by a shade.
 */
export const ALARM_BANNER_GRADIENT: CSSProperties = { background: 'var(--band-gradient)' };

/** The band's END colour, solid — the sticky action column sits at the right edge of the band. */
export const ALARM_BANNER_SOLID: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--theme-gradient-to, #1e3a5f) 78%, black)',
};

/** The banner header band. Give it a single `<tr>` of {@link Th}. */
export function AlarmTableHead({ children }: { children: ReactNode }) {
  return (
    <thead
      className="text-left text-xs font-semibold uppercase tracking-wider text-white"
      style={ALARM_BANNER_GRADIENT}
    >
      {children}
    </thead>
  );
}

/**
 * The bracketed legend under a column name rather than beside it (operator,
 * 2026-08-29). `block` is what puts it on its own line; keeping it inside the
 * same `<th>` means the two lines stay one sortable, one-cell heading rather
 * than becoming a second header row that every colSpan would have to know
 * about.
 */
export function UnitLine({ children }: { children: ReactNode }) {
  return <span className="block font-normal normal-case tracking-normal opacity-70">{children}</span>;
}

/** One word of a heading, on its own line. */
export function Stack({ children }: { children: ReactNode }) {
  return <span className="block">{children}</span>;
}

/**
 * A header cell. Sortable when given a `sortKey` — and only for the columns the
 * SERVER can order on, since sorting one page of a paged result would rearrange
 * twelve rows and call it a sort of five hundred. The widget passes none: it
 * shows one instrument's alarms for one period and has no server sort behind
 * it, so every one of its headings is plain.
 */
export function Th({
  children, sortKey, sort, dir, onSort, title, className, style,
}: {
  children?: ReactNode;
  sortKey?: AlarmSortKey;
  sort?: AlarmSortKey;
  dir?: 'asc' | 'desc';
  onSort?: (k: AlarmSortKey) => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const base = `whitespace-nowrap px-4 py-3.5 align-top ${className ?? ''}`;
  if (!sortKey || !onSort) {
    return <th className={base} title={title} style={style}>{children}</th>;
  }
  const active = sort === sortKey;
  return (
    <th className={base} title={title} style={style} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1.5 uppercase tracking-wider hover:text-white/80"
      >
        <span>{children}</span>
        <svg className={`h-3 w-3 shrink-0 transition-opacity ${active ? 'opacity-100' : 'opacity-40'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          {active
            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={dir === 'asc' ? 'M4.5 15.75l7.5-7.5 7.5 7.5' : 'M19.5 8.25l-7.5 7.5-7.5-7.5'} />
            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.25 15L12 18.75 15.75 15M8.25 9L12 5.25 15.75 9" />}
        </svg>
      </button>
    </th>
  );
}

/** The class every alarm row carries — `group` is what lets the sticky action
 *  cell follow the row's hover instead of staying white over a tinted row. */
export const ALARM_ROW_CLASS = 'group hover:bg-slate-50/70';

/**
 * The state marker. A wide table puts the status pill off to the right, and
 * this is what lets an operator find the unanswered rows without scrolling to
 * it. Drop it inside whichever cell LEADS the table — the Instrument ID column
 * on the Alarms page, the Type column in the widget, which drops Instrument ID
 * as redundant for a single-instrument view. Pair it with
 * {@link ALARM_LEAD_CELL}, which supplies the `relative` it positions against.
 */
export function StateMarker({ tone }: { tone: QuadrantTone }) {
  return <span className={`absolute inset-y-0 left-0 w-1 ${ACCENT[tone]}`} aria-hidden />;
}

/** Padding for the cell that carries the {@link StateMarker}. */
export const ALARM_LEAD_CELL = 'relative py-3 pl-5 pr-4';

/** Padding for every other cell. */
export const ALARM_CELL = 'px-4 py-3';

/** The instrument the alarm is about. */
export function AlarmInstrumentCell({ a, marker }: { a: AlarmRow; marker?: QuadrantTone }) {
  return (
    <td className={`${marker ? ALARM_LEAD_CELL : ALARM_CELL} font-semibold text-slate-900`}>
      {marker && <StateMarker tone={marker} />}
      {instrumentLabel(a)}
    </td>
  );
}

/**
 * What kind of alarm this is.
 *
 * Wraps to two lines, as the mockup draws it — "High Temperature" on one line is
 * a wide column for two words. No metric glyph: it repeated the word beside it
 * on every row and bought a column of width for nothing (operator, 2026-08-31).
 * The status pill keeps ITS dot — that one is carrying colour, which must never
 * travel alone.
 */
export function AlarmTypeCell({
  a, texts, marker,
}: { a: AlarmRow; texts?: AlarmDisplayTexts; marker?: QuadrantTone }) {
  return (
    <td className={`${marker ? ALARM_LEAD_CELL : ALARM_CELL} text-slate-700`}>
      {marker && <StateMarker tone={marker} />}
      {alarmTypeText(a, texts)}
    </td>
  );
}

/**
 * The instrument's own `Location` ATTRIBUTE — the space it names, never the drawn
 * room and never the Block > Area grouping.
 *
 * `areaShown` must be true wherever {@link AlarmAreaCell} is rendered on the same
 * row: without it this cell falls back to the functional location and the two
 * columns print the same string on every instrument with no typed Location.
 */
export function AlarmLocationCell({ a, areaShown = false }: { a: AlarmRow; areaShown?: boolean }) {
  return <td className={`${ALARM_CELL} text-slate-700`}>{locationText(a, { areaShown })}</td>;
}

/** The FUNCTIONAL location — the authoritative Block > Area grouping, and the
 *  same fact the dashboard readings table's Area column shows. */
export function AlarmAreaCell({ a }: { a: AlarmRow }) {
  return <td className={`${ALARM_CELL} text-slate-700`}>{areaText(a)}</td>;
}

/**
 * A timestamp, date over time.
 *
 * The formatters are PASSED IN rather than read from `useDatetimeFormat()` here:
 * that hook is an SWR subscription, and calling it once per cell would open one
 * subscription per timestamp per row — five hundred rows of four time columns is
 * two thousand subscriptions for one configuration value. The caller holds the
 * hook once. Format, clock and TIMEZONE are all administered, so never
 * `toLocaleString` in this file.
 */
export function AlarmTimeCell({
  value, formatDate, formatTime, emptyTitle,
}: {
  value: string | null;
  formatDate: (v: string) => string;
  formatTime: (v: string) => string;
  /** What the dash means when there is no timestamp. Omitted = a plain dash. */
  emptyTitle?: string;
}) {
  return (
    <td className={`whitespace-nowrap ${ALARM_CELL} text-slate-600`}>
      {value ? (
        <>
          <span className="block">{formatDate(value)}</span>
          <span className="block text-xs text-slate-400">{formatTime(value)}</span>
        </>
      ) : (
        <span className="font-medium text-amber-700" title={emptyTitle}>—</span>
      )}
    </td>
  );
}

/**
 * The reading that tripped it.
 *
 * Bare number. The unit is in the column head and the row's metric is already
 * named in the Type column, so repeating it per cell says the same thing twice
 * and widens the column (operator, 2026-08-29 and again 2026-08-31).
 */
export function AlarmValueCell({ a, texts }: { a: AlarmRow; texts?: AlarmDisplayTexts }) {
  return (
    <td className={`whitespace-nowrap ${ALARM_CELL} font-semibold tabular-nums ${VALUE_INK[breachDirection(a)]}`}>
      {triggeredText(a, texts)}
    </td>
  );
}

/** The bound it fired against, from the FROZEN snapshot. */
export function AlarmLimitCell({ a, texts, limits }: {
  a: AlarmRow;
  texts?: AlarmDisplayTexts;
  /**
   * The instrument's CURRENT bounds, for the sources that carry no bound of
   * their own. Optional because the Alarms page spans many instruments and has
   * no single set to pass — there the cell falls back to a dash, which is what
   * it showed for those rows before the alarm's own thresholds were suppressed.
   */
  limits?: { tempMin?: number | null; tempMax?: number | null; rhMin?: number | null; rhMax?: number | null } | null;
}) {
  return <td className={`whitespace-nowrap ${ALARM_CELL} tabular-nums text-slate-500`}>{screenLimitText(a, texts, limits)}</td>;
}

/** The reading that brought it back in limit. */
export function AlarmClearedValueCell({ a, texts }: { a: AlarmRow; texts?: AlarmDisplayTexts }) {
  return <td className={`whitespace-nowrap ${ALARM_CELL} tabular-nums text-slate-600`}>{clearedText(a, texts)}</td>;
}

/**
 * The status pill.
 *
 * **Keyed off the four-state tone, NEVER off severity.** The Alarms page carried
 * exactly that bug until 2026-08-31: `severityTone(a.severity)` painted every
 * pill red on an installation where every alarm is CRITICAL, so the one column
 * that distinguishes an answered alarm from an unanswered one said nothing. The
 * widget carried the same bug until this component replaced its hand-written
 * copy. This is the single reason the pill is a component and not two lines of
 * JSX in each caller.
 *
 * `pulse` for a live, unanswered condition only — a steady state that pulses
 * forever stops meaning "look at me".
 */
export function AlarmStatusCell({
  a, texts,
}: { a: AlarmRow; texts?: Partial<AlarmStatusTexts> }) {
  return (
    <td className={ALARM_CELL}>
      <StatusBadge
        tone={quadrantTone(a)}
        label={statusText(a, texts)}
        pulse={a.state === 'ACTIVE' && !a.acknowledgedAt}
      />
    </td>
  );
}

/** How long it lasted, raised → cleared. Blank while it is still open. */
export function AlarmDurationCell({ a }: { a: AlarmRow }) {
  return (
    <td
      className={`whitespace-nowrap ${ALARM_CELL} tabular-nums text-slate-700`}
      title={a.clearedAt ? undefined : 'Still active — no cleared time yet'}
    >
      {alarmDurationText(a)}
    </td>
  );
}

/**
 * Who signed for it, and when.
 *
 * "Awaiting" in rose rather than an empty cell: an unanswered alarm is the thing
 * this column exists to surface, and a blank reads as a rendering fault.
 */
export function AlarmAckByCell({
  a, formatDateTime,
}: { a: AlarmRow; formatDateTime: (v: string) => string }) {
  return (
    <td className={ALARM_CELL}>
      {a.acknowledgedAt ? (
        <span title={a.acknowledgeReason ?? undefined} className="text-slate-700">
          <span className="block font-medium">{a.acknowledgedBy}</span>
          <span className="block text-xs text-slate-400">{formatDateTime(a.acknowledgedAt)}</span>
        </span>
      ) : (
        <span className="font-medium text-rose-600">Awaiting</span>
      )}
    </td>
  );
}

/**
 * A whole-width message inside the table — loading, an error, or an empty
 * result. Takes the caller's own column count, because the two tables show
 * different numbers of columns and a colSpan that is one short leaves a
 * hairline of unpainted table beside the message.
 */
export function AlarmTableMessage({
  colSpan, children, className,
}: { colSpan: number; children: ReactNode; className?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className={className ?? 'px-4 py-12 text-center text-slate-500'}>
        {children}
      </td>
    </tr>
  );
}
