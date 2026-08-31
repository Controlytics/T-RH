import { useMemo } from 'react';
import useSWR from 'swr';
import { ALARM_QUADRANTS, ALARM_TYPE_OPTIONS, type AlarmQuadrant } from './alarm-display';

/**
 * The alarm list's filter bar.
 *
 * Everything here is a REAL query parameter on `GET /api/alarms`, so a filter
 * narrows every alarm on record rather than the page already in the browser. That
 * matters most for the date range: a client-side range could only ever reach as
 * far back as the rows currently fetched, and would return nothing for an older
 * window while looking like it had searched.
 *
 * The Status select and the four count cards are ONE control on two surfaces —
 * they read and write the same value, so they cannot drift apart and claim
 * different things about what is being shown.
 */

export interface AlarmFilterState {
  search: string;
  /** `datetime-local` wall-clock text; converted to an instant before it is sent. */
  from: string;
  to: string;
  type: string;
  status: AlarmQuadrant | null;
  severity: string;
  functionalLocationId: string;
}

export const EMPTY_FILTERS: AlarmFilterState = {
  search: '', from: '', to: '', type: '', status: null, severity: '', functionalLocationId: '',
};

/** Which filters the "Filters" button reveals — used for its active-count badge. */
export function advancedCount(f: AlarmFilterState): number {
  return (f.functionalLocationId ? 1 : 0) + (f.severity ? 1 : 0);
}

export function hasAnyFilter(f: AlarmFilterState): boolean {
  return Boolean(f.search || f.from || f.to || f.type || f.status || advancedCount(f));
}

interface FlNode { id: string; name: string; children?: FlNode[] }

export function AlarmFilters({
  value, onChange, advancedOpen, onToggleAdvanced,
}: {
  value: AlarmFilterState;
  onChange: (next: AlarmFilterState) => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
}) {
  const { data: flData } = useSWR<{ data: FlNode[] }>('/api/functional-locations');

  // Blocks AND their Areas, flattened with a path. Choosing a Block covers its
  // Areas — the server expands it through resolveLocationIds().
  const locations = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    for (const b of flData?.data ?? []) {
      out.push({ id: b.id, label: b.name });
      for (const a of b.children ?? []) out.push({ id: a.id, label: `${b.name} › ${a.name}` });
    }
    return out;
  }, [flData]);

  const set = <K extends keyof AlarmFilterState>(k: K, v: AlarmFilterState[K]) =>
    onChange({ ...value, [k]: v });

  const advanced = advancedCount(value);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[var(--elev-1)]">
      <div className="flex flex-wrap items-center gap-3">
        {/* Search. The placeholder names what this actually reads — Type is an enum
            pair rendered into words at display time, so there is no text to match
            and it has its own dropdown instead. */}
        <div className="relative min-w-[16rem] flex-1">
          <svg className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="search"
            value={value.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Search by instrument ID, name or location…"
            aria-label="Search alarms by instrument ID, name or location"
            className="ctl w-full pl-10"
            /* Belt and braces against the browser's credential heuristics. The
               real cause of the username landing here was the acknowledge
               dialog's unguarded password field (see SignaturePasswordInput),
               but an unnamed text box with no autocomplete hint is exactly what
               Chrome reaches for when it goes looking for a username to fill. */
            name="alarm-search"
            autoComplete="off"
          />
        </div>

        {/* Raised-between. Labelled for the column it filters, so there is no
            question whether it means raised, cleared or overlapping. */}
        <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-slate-200 bg-white px-3 py-1.5">
          <svg className="h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
          </svg>
          <span className="whitespace-nowrap text-xs font-medium text-slate-500">Raised</span>
          <input
            type="datetime-local"
            value={value.from}
            onChange={(e) => set('from', e.target.value)}
            aria-label="Raised from"
            className="border-0 bg-transparent p-0 text-[0.8125rem] text-slate-700 focus:outline-none focus:ring-0 [color-scheme:light]"
          />
          <span aria-hidden className="text-slate-300">→</span>
          <input
            type="datetime-local"
            value={value.to}
            onChange={(e) => set('to', e.target.value)}
            aria-label="Raised to"
            className="border-0 bg-transparent p-0 text-[0.8125rem] text-slate-700 focus:outline-none focus:ring-0 [color-scheme:light]"
          />
        </div>

        <select
          value={value.type}
          onChange={(e) => set('type', e.target.value)}
          aria-label="Alarm type"
          className="ctl min-w-[10rem]"
        >
          <option value="">All types</option>
          {ALARM_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        {/* The same value the four cards write. One filter, two surfaces. */}
        <select
          value={value.status ?? ''}
          onChange={(e) => set('status', (e.target.value || null) as AlarmQuadrant | null)}
          aria-label="Alarm status"
          className="ctl min-w-[12rem]"
        >
          <option value="">All statuses</option>
          {ALARM_QUADRANTS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
        </select>

        <button
          type="button"
          onClick={onToggleAdvanced}
          aria-expanded={advancedOpen}
          className="inline-flex items-center gap-2 rounded-[var(--radius-control)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--elev-1)] transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--theme-primary, #2a78d6)' }}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filters
          {advanced > 0 && (
            <span className="rounded-full bg-white/25 px-1.5 text-xs font-bold tabular-nums">{advanced}</span>
          )}
        </button>

        {hasAnyFilter(value) && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="rounded-[var(--radius-control)] border border-slate-200 px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
          >
            Clear all
          </button>
        )}
      </div>

      {advancedOpen && (
        <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-slate-100 pt-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-slate-600">Location</span>
            <select
              value={value.functionalLocationId}
              onChange={(e) => set('functionalLocationId', e.target.value)}
              className="ctl min-w-[16rem]"
            >
              {/* Choosing a Block covers every Area inside it. */}
              <option value="">Anywhere</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-slate-600">Severity</span>
            <select
              value={value.severity}
              onChange={(e) => set('severity', e.target.value)}
              className="ctl min-w-[10rem]"
            >
              <option value="">Any severity</option>
              <option value="CRITICAL">Critical</option>
              <option value="MAJOR">Major</option>
              <option value="MINOR">Minor</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
