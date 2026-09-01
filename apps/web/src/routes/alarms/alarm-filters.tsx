import { useMemo } from 'react';
import useSWR from 'swr';
import { ALARM_QUADRANTS, alarmTypeOptions, type AlarmQuadrant } from './alarm-display';
import { useAlarmTypeNames } from '@/hooks/use-failure-text';

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
  /**
   * BLOCK, AREA and INSTRUMENT, three controls (operator, 2026-09-01).
   *
   * Block and Area are ONE axis at two granularities and collapse to a single
   * `functionalLocationId` on the wire — see {@link locationFilterId}. They are
   * separate CONTROLS because that is how the plant is read; they are not
   * separate query parameters, and making them so would need the server to
   * intersect two nodes of one tree.
   */
  blockId: string;
  areaId: string;
  instrumentId: string;
}

export const EMPTY_FILTERS: AlarmFilterState = {
  search: '', from: '', to: '', type: '', status: null,
  blockId: '', areaId: '', instrumentId: '',
};

/**
 * The one functional location to send: the AREA when one is chosen, else the
 * Block.
 *
 * The Area is always inside the selected Block (the picker only offers its own),
 * so the narrower of the two is the whole filter — sending both would be sending
 * a node and its ancestor, which is just the node.
 */
export function locationFilterId(f: Pick<AlarmFilterState, 'blockId' | 'areaId'>): string {
  return f.areaId || f.blockId;
}

/** Which filters the "Filters" button reveals — used for its active-count badge. */
export function advancedCount(f: AlarmFilterState): number {
  // Block and Area count ONCE between them: they are one axis, and a badge
  // reading "2" for one narrowing would overstate what is applied.
  return (locationFilterId(f) ? 1 : 0) + (f.instrumentId ? 1 : 0);
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
  // Labelled from the administered names, so renaming a type on the config
  // page renames it in the filter as well as in the table.
  const typeOptions = alarmTypeOptions(useAlarmTypeNames());
  const { data: flData } = useSWR<{ data: FlNode[] }>('/api/functional-locations');

  const blocks = flData?.data ?? [];

  /**
   * The Areas offered: those of the selected Block, or ALL of them (prefixed with
   * their Block) while no Block is chosen — filtering straight to an Area without
   * naming its Block first is a normal thing to want.
   */
  const areas = useMemo(() => {
    const src = value.blockId ? blocks.filter((b) => b.id === value.blockId) : blocks;
    return src.flatMap((b) => (b.children ?? []).map((a) => ({
      id: a.id,
      label: value.blockId ? a.name : `${b.name} › ${a.name}`,
    })));
  }, [blocks, value.blockId]);

  /**
   * The instruments offered, NARROWED BY THE SERVER.
   *
   * `functionalLocationId` goes to the API and `resolveLocationIds()` expands a
   * Block to its Areas there. Doing that here would re-derive a server-side
   * grouping rule in the browser — the thing this codebase has a standing rule
   * against — and it would be wrong in the same way a bare equality is: a Block's
   * instruments are its own PLUS its Areas'.
   *
   * The list is visibility-scoped by the same endpoint, so an operator cannot
   * filter by an instrument they are not allowed to see.
   */
  const instrumentQs = new URLSearchParams({ limit: '500' });
  const scopeId = locationFilterId(value);
  if (scopeId) instrumentQs.set('functionalLocationId', scopeId);
  const { data: instData } = useSWR<{ data: { id: string; code: string; name: string }[] }>(
    `/api/instruments?${instrumentQs.toString()}`,
  );
  const instruments = instData?.data ?? [];

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
          {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
          {/*
            BLOCK -> AREA -> INSTRUMENT (operator, 2026-09-01), and each one CLEARS
            the narrower choices below it.

            That is not tidiness. An Area belongs to one Block and an instrument to
            one Area, so a stale narrower selection would AND with the new wider
            one and return an empty table — a filter that looks applied and matches
            nothing, which reads as "there are no alarms here".
          */}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-slate-600">Block</span>
            <select
              value={value.blockId}
              onChange={(e) => onChange({
                ...value, blockId: e.target.value, areaId: '', instrumentId: '',
              })}
              className="ctl min-w-[12rem]"
            >
              {/* A Block covers every Area inside it — expanded on the server. */}
              <option value="">All blocks</option>
              {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-slate-600">Area</span>
            <select
              value={value.areaId}
              onChange={(e) => onChange({ ...value, areaId: e.target.value, instrumentId: '' })}
              className="ctl min-w-[12rem]"
            >
              <option value="">{value.blockId ? 'All areas in this block' : 'All areas'}</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-slate-600">Instrument</span>
            <select
              value={value.instrumentId}
              onChange={(e) => set('instrumentId', e.target.value)}
              className="ctl min-w-[14rem]"
            >
              <option value="">All instruments</option>
              {instruments.map((i) => (
                <option key={i.id} value={i.id}>{i.code}{i.name ? ` — ${i.name}` : ''}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * The Block / Area / Instrument names for the PDF report's parameter block.
 *
 * The filters carry IDs; the paper must carry NAMES. This resolves them from the
 * SAME two SWR keys the pickers above use, so SWR dedupes and no second request
 * is made — and, more importantly, the report cannot name a Block differently
 * from the control the operator chose it in.
 */
export function useFilterScopeLabels(value: AlarmFilterState) {
  const { data: flData } = useSWR<{ data: FlNode[] }>('/api/functional-locations');
  const scopeId = locationFilterId(value);
  const qs = new URLSearchParams({ limit: '500' });
  if (scopeId) qs.set('functionalLocationId', scopeId);
  const { data: instData } = useSWR<{
    data: { id: string; code: string; name: string; functionalLocationId?: string | null }[];
  }>(`/api/instruments?${qs.toString()}`);

  const blocks = flData?.data ?? [];
  const inst = (instData?.data ?? []).find((i) => i.id === value.instrumentId);

  /**
   * Which Area the report is about: the one PICKED, or — when only an instrument
   * was chosen — the one that instrument actually sits in.
   *
   * Operator, 2026-09-01: downloading a single instrument left Block and Area
   * blank, because nothing had been selected in those two controls. But the
   * instrument HAS a functional location, and the report's own rule is that a
   * field belongs in the header when it is constant across the rows — which for a
   * single instrument all three are. Blank was the one answer that was simply
   * wrong.
   *
   * Resolved by ID through the tree, never by matching the Area's NAME: two
   * Blocks may hold Areas with the same name, and a name match would then print
   * the wrong Block with no way to notice.
   */
  const areaId = value.areaId || (value.instrumentId ? (inst?.functionalLocationId ?? '') : '');

  // Looked up across ALL blocks: an Area can be chosen with no Block, and an
  // instrument's own Area is not confined to whichever Block is selected either.
  let areaName = '';
  let areaBlockName = '';
  for (const b of blocks) {
    if (b.id === areaId) { areaBlockName = b.name; break; }   // pinned to the Block itself
    const hit = (b.children ?? []).find((a) => a.id === areaId);
    if (hit) { areaName = hit.name; areaBlockName = b.name; break; }
  }
  const block = blocks.find((b) => b.id === value.blockId);

  return {
    // An Area names its Block even when no Block was picked: "Area: QC 3" alone
    // does not say where in the building that is.
    blockName: block?.name ?? areaBlockName,
    areaName,
    instrumentLabel: inst ? inst.code : '',
  };
}
