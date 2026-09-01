import type { ReactNode } from 'react';
import { ALARM_QUADRANTS, alarmTypeOptions, type AlarmQuadrant } from './alarm-display';

/**
 * The compact search / type / status toolbar shared by the two alarm WIDGETS —
 * the trend page's "Alarms in this period" and the dashboard's "Active alarms in
 * this selection" (operator, 2026-09-01: *"whatever filters are in Alarms in this
 * period widget those filters should also come in active alarms in this
 * selection"*).
 *
 * **Not `alarm-filters.tsx`.** That is the Alarms PAGE's bar — a date range, a
 * functional-location tree and an advanced disclosure — which is a page-sized
 * control set and would swamp a dashboard panel. This is the three controls that
 * fit in a card header.
 *
 * Extracted rather than copied for the reason `alarm-table.tsx` was: this
 * codebase has already watched three hand-written alarm tables drift apart, and
 * the trend widget's copy was the one that drifted. A second copy of a filter bar
 * would do the same — one surface would gain the administered type names and the
 * other would keep a hardcoded list.
 *
 * Every control here is a REAL query parameter on `GET /api/alarms`. Nothing in
 * it narrows rows already in the browser, which on a paged widget would filter
 * one page while reading as a filter of the record.
 */

export interface AlarmWidgetFilterValue {
  search: string;
  type: string;
  status: AlarmQuadrant | '';
}

export const EMPTY_WIDGET_FILTERS: AlarmWidgetFilterValue = { search: '', type: '', status: '' };

/**
 * The two quadrants that can occur while a query is pinned to `state=ACTIVE`.
 *
 * The dashboard panel passes these. Offering all four there would put two options
 * in the list that can only ever return an empty table: `quadrantWhere` emits
 * `{ state: 'CLEARED' }` and the panel's own scope ANDs `{ state: 'ACTIVE' }`, so
 * `state = ACTIVE AND state = CLEARED` matches nothing, always. Same rule as the
 * Card height control hidden on an auto-height panel — a control that cannot
 * change the result is a decoy, and this one would look like a filter that found
 * nothing rather than one that could not.
 */
export const ACTIVE_QUADRANTS = ALARM_QUADRANTS.filter((q) => q.id.startsWith('active-'));

export function AlarmWidgetFilters({
  value, onChange, typeNames, statusOptions = ALARM_QUADRANTS,
  searchLabel, searchName, trailing,
}: {
  value: AlarmWidgetFilterValue;
  onChange: (next: AlarmWidgetFilterValue) => void;
  /** Administered type names, so a rename reaches this control and the Type
   *  column together. Undefined until the config has loaded — `alarmTypeOptions`
   *  then yields the shipped wording, never a blank list. */
  typeNames?: Record<string, string>;
  /** Defaults to all four. Pass {@link ACTIVE_QUADRANTS} on a surface scoped to
   *  active alarms. */
  statusOptions?: readonly { id: AlarmQuadrant; label: string }[];
  /** Distinguishes the two boxes for a screen reader; both can be on screen at
   *  once is not the case today, but "Search" alone names nothing. */
  searchLabel: string;
  /**
   * A DISTINCT `name` per surface, and never absent. An unnamed text input beside
   * a password field is what Chrome reaches for when it hunts for a username to
   * fill — that is not hypothetical here: it typed the logged-in username into
   * the Alarms search box on 2026-08-31, which looked like a bug in the search
   * box and was not.
   */
  searchName: string;
  /** Rendered after the three controls — the trend page's export icon and
   *  settings pencil. The panel passes nothing. */
  trailing?: ReactNode;
}) {
  const typeOptions = alarmTypeOptions(typeNames);
  const set = (patch: Partial<AlarmWidgetFilterValue>) => onChange({ ...value, ...patch });

  return (
    // One row, never wrapping (operator, 2026-09-01). A search box that has
    // dropped onto its own line reads as a second section rather than as this
    // card's toolbar.
    <div className="flex flex-nowrap items-center gap-2">
      {/* The placeholder names what the SERVER matches. Type is an enum rendered
          into words at display time, so there is no text to match and it has its
          own control. */}
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="search"
          value={value.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Search…"
          aria-label={searchLabel}
          className="ctl w-36 pl-9 text-[0.8125rem]"
          name={searchName}
          autoComplete="off"
        />
      </div>

      <select
        value={value.type}
        onChange={(e) => set({ type: e.target.value })}
        aria-label="Filter by alarm type"
        className="ctl max-w-[8.5rem] text-[0.8125rem]"
      >
        <option value="">All types</option>
        {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <select
        value={value.status}
        onChange={(e) => set({ status: e.target.value as AlarmQuadrant | '' })}
        aria-label="Filter by status"
        className="ctl max-w-[9rem] text-[0.8125rem]"
      >
        <option value="">All statuses</option>
        {statusOptions.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
      </select>

      {trailing}
    </div>
  );
}

/** The three controls as query parameters. Empty strings are OMITTED rather than
 *  sent, so an untouched control cannot become a filter. */
export function applyWidgetFilters(qs: URLSearchParams, f: AlarmWidgetFilterValue): URLSearchParams {
  if (f.search.trim()) qs.set('search', f.search.trim());
  if (f.type) qs.set('type', f.type);
  if (f.status) qs.set('status', f.status);
  return qs;
}
