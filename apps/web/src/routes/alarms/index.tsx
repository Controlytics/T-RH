import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import { Button } from '@/components/ui/button';
import { AcknowledgeDialog } from './acknowledge-dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { AlarmStatCards } from './alarm-stat-cards';
import { AlarmFilters, EMPTY_FILTERS, hasAnyFilter, type AlarmFilterState } from './alarm-filters';
import {
  needsAcknowledgement, instrumentLabel, statusText, alarmTypeText, limitText,
  mapStatusTextsResponse, triggeredText, clearedText, alarmDurationText,
  locationText, breachDirection, quadrantTone, localInputToIso,
  type AlarmRow, type AlarmQuadrant, type AlarmStatusTextsResponse, type AlarmSortKey,
} from './alarm-display';

/**
 * Alarms — what the evaluator has raised, and who has answered for it.
 *
 * There is no create, edit or delete here by design: alarms are RAISED by the worker
 * and are regulated records. Rules are authored on Configuration → Alarm Rules.
 *
 * Filtering, sorting, counting and paging all happen ON THE SERVER
 * (`modules/alarms/list-query.ts`). They used to happen in this component over the
 * newest 500 rows, which meant the count boxes described a window rather than the
 * plant, and a date range could not reach past the oldest row fetched. The four
 * boxes and "showing N of M" now come from the same response and cannot disagree.
 */
export default function AlarmsPage() {
  const can = useCan();
  const { toast } = useToast();
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const { defaultLimit } = usePaginationDefaults();

  const [filters, setFilters] = useState<AlarmFilterState>(EMPTY_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sort, setSort] = useState<AlarmSortKey>('raisedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultLimit);
  const [target, setTarget] = useState<AlarmRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  // Typing must not fire a request per keystroke; every other filter is a
  // deliberate single act and is applied immediately.
  const search = useDebounced(filters.search, 300);

  // Any change to WHICH rows match invalidates the page number — page 4 of a
  // narrowed result is usually empty, and an empty table is read as "no alarms".
  useEffect(() => {
    setPage(1);
  }, [search, filters.from, filters.to, filters.type, filters.status, filters.severity, filters.functionalLocationId, pageSize]);

  const query = useMemo(() => {
    const qs = new URLSearchParams({
      page: String(page), pageSize: String(pageSize), sort, dir,
    });
    if (search) qs.set('search', search);
    if (filters.type) qs.set('type', filters.type);
    if (filters.status) qs.set('status', filters.status);
    if (filters.severity) qs.set('severity', filters.severity);
    if (filters.functionalLocationId) qs.set('functionalLocationId', filters.functionalLocationId);
    // Resolved to an instant here, where the operator's clock is — see
    // localInputToIso. An unreadable value is simply not sent, so a half-typed
    // date does not 400 the page while the operator is still typing it.
    const from = localInputToIso(filters.from);
    const to = localInputToIso(filters.to);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return qs.toString();
  }, [page, pageSize, sort, dir, search, filters.type, filters.status, filters.severity, filters.functionalLocationId, filters.from, filters.to]);

  const { data, isLoading, error, mutate } = useSWR<{
    data: AlarmRow[];
    total: number;
    counts: Record<AlarmQuadrant, number>;
  }>(`/api/alarms?${query}`, { keepPreviousData: true });

  const { data: summary, mutate: mutateSummary } = useSWR<{
    active: number; unacknowledged: number; critical: number;
    instrumentsWithoutLimits?: number; instrumentsWithoutLimitsCodes?: string[];
    limitAlarmsEnabled?: boolean;
  }>('/api/alarms/summary');

  // Narrow, all-authenticated-users read — the `alarm-limits` config itself
  // (`/api/config/dynamic/alarm-limits`) is SUPER_ADMIN-only because most of it is
  // sensitive (attribute-key mapping, severity). `/status-texts` exposes only the
  // four wording strings, already defaulted server-side, so every operator sees the
  // configured wording instead of every non-SUPER_ADMIN 403ing into the fallback.
  //
  // The API payload uses `status*`-prefixed keys (mirroring the stored config
  // keys in alarm-limits.def.ts); `AlarmStatusTexts` (alarm-display.ts) uses the
  // unprefixed display-contract names `statusText()` reads. The two vocabularies
  // are deliberately different — `mapStatusTextsResponse()` is the one place
  // that reconciles them, and is unit-tested directly.
  const { data: statusTextsResponse } = useSWR<AlarmStatusTextsResponse>(
    '/api/config/alarm-limits/status-texts',
  );
  const statusTexts = statusTextsResponse ? mapStatusTextsResponse(statusTextsResponse) : undefined;

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts ?? { 'active-unack': 0, 'active-ack': 0, 'cleared-unack': 0, 'cleared-ack': 0 };

  const acknowledge = async (reason: string, password: string) => {
    if (!target) return;
    setSubmitting(true);
    setDialogError('');
    try {
      await apiClient.postWithReauth(`/api/alarms/${target.id}/acknowledge`, { reason }, password);
      toast.success('Alarm acknowledged', `Signed for ${instrumentLabel(target)}.`);
      setTarget(null);
      await Promise.all([mutate(), mutateSummary()]);
    } catch (e) {
      // Kept in the dialog rather than a toast: the password is still on screen and the
      // operator needs to correct it in place. A 409 here means someone else signed first.
      setDialogError(e instanceof Error ? e.message : 'Could not acknowledge this alarm.');
    } finally {
      setSubmitting(false);
    }
  };

  /** Clicking a header sorts by it; clicking the sorted one reverses it. */
  const toggleSort = (key: AlarmSortKey) => {
    if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir(key === 'raisedAt' || key === 'clearedAt' ? 'desc' : 'asc'); }
    setPage(1);
  };

  return (
    // NO padding here. `<main>` in app-layout already applies `p-3 sm:p-4 lg:p-6`,
    // so this page's own `p-6` was DOUBLE-padding it — ~48px of dead margin down
    // each side, which is why the table appeared not to reach the page edges while
    // the dashboard (which adds none) did. Removed 2026-08-29.
    <div>
      <PageHeader
        className="mb-6"
        title="Alarms"
        description="Monitor and manage all active alarms across the system"
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Alarms' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        }
      />

      <div className="mb-5">
        <AlarmStatCards
          counts={counts}
          selected={filters.status}
          onSelect={(q) => setFilters((f) => ({ ...f, status: q }))}
        />
      </div>

      <div className="mb-5">
        <AlarmFilters
          value={filters}
          onChange={setFilters}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((o) => !o)}
        />
      </div>

      {summary?.limitAlarmsEnabled === false && (
        <div className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Limit alarms are turned off, so no instrument limits are being checked.
          Turn them on in Configuration → Instrument Limit Alarms.
        </div>
      )}

      {/* Two DIFFERENT failures, worded differently on purpose.
          `keepPreviousData` means a failed REVALIDATION leaves the last good rows
          on screen with `error` set — reachable on every refocus. Calling that
          "could not be loaded" over a table full of rows is plainly false, and it
          trains the reader to ignore the banner. The rows are real; only their
          age is in doubt. A first load with no data is the other case, and there
          the table says nothing about the record at all. */}
      {error && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data
            ? 'Showing the last result that loaded — the alarm list could not be refreshed, so it may be out of date.'
            : `Could not load alarms. ${error instanceof Error ? error.message : ''}`}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[var(--elev-1)]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead
              // The mock's dark banner, painted from the site theme rather than a
              // hardcoded indigo, so this table follows all ten colour presets
              // instead of being the one screen with a palette of its own.
              className="text-left text-xs font-semibold uppercase tracking-wider text-white"
              style={{
                backgroundImage:
                  'linear-gradient(to right, color-mix(in srgb, var(--theme-primary, #2a78d6) 85%, black), var(--theme-primary, #2a78d6))',
              }}
            >
              <tr>
                <Th sortKey="instrumentCode" sort={sort} dir={dir} onSort={toggleSort}>Instrument ID</Th>
                <Th sortKey="type" sort={sort} dir={dir} onSort={toggleSort}>Type</Th>
                <Th>Location</Th>
                <Th sortKey="raisedAt" sort={sort} dir={dir} onSort={toggleSort}>Raised</Th>
                <Th>Generated Value<UnitLine>(°C / %RH)</UnitLine></Th>
                <Th>Limit</Th>
                <Th sortKey="clearedAt" sort={sort} dir={dir} onSort={toggleSort}>Cleared</Th>
                <Th>Cleared value<UnitLine>(°C / %RH)</UnitLine></Th>
                <Th sortKey="status" sort={sort} dir={dir} onSort={toggleSort}>Status</Th>
                {/* H = hours, m = minutes. Abbreviated because the spelled-out
                    legend was the widest header on the page and pushed the table
                    past the viewport. */}
                <Th title="H = hours, m = minutes">Duration<UnitLine>(H/m)</UnitLine></Th>
                <Th>Acknowledged by</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading && !data && (
                <tr><td colSpan={12} className="px-4 py-4"><SkeletonRows rows={5} columns={6} /></td></tr>
              )}
              {/* `!error` is load-bearing. Without it a failed request renders
                  "No alarms have been raised." — a statement about the record —
                  underneath a banner saying the record could not be read. On a
                  monitoring screen that reads as "nothing is wrong". */}
              {error && rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-slate-500">
                    The alarm list could not be loaded, so this table is not showing the current state.
                  </td>
                </tr>
              )}
              {!isLoading && !error && rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-slate-500">
                    {hasAnyFilter(filters)
                      ? 'No alarms match these filters.'
                      : 'No alarms have been raised.'}
                  </td>
                </tr>
              )}
              {rows.map((a) => {
                const tone = quadrantTone(a);
                return (
                  <tr key={a.id} className="group hover:bg-slate-50/70">
                    {/* The state marker. A wide table puts the status pill off to
                        the right, and this is what lets an operator find the
                        unanswered rows without scrolling to it. */}
                    <td className="relative py-3 pl-5 pr-4 font-semibold text-slate-900">
                      <span className={`absolute inset-y-0 left-0 w-1 ${ACCENT[tone]}`} aria-hidden />
                      {instrumentLabel(a)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 text-slate-700">
                        <MetricGlyph metric={a.metric} />
                        {alarmTypeText(a)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{locationText(a)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      <span className="block">{formatDate(a.raisedAt)}</span>
                      <span className="block text-xs text-slate-400">{formatTime(a.raisedAt)}</span>
                    </td>
                    {/* Bare number. The unit is in the column head and the row's
                        metric is already named in the Type column, so repeating
                        it per cell says the same thing twice and widens the
                        column (operator, 2026-08-29 and again 2026-08-31). */}
                    <td className={`whitespace-nowrap px-4 py-3 font-semibold tabular-nums ${VALUE_INK[breachDirection(a)]}`}>
                      {triggeredText(a)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-500">{limitText(a)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      {a.clearedAt ? (
                        <>
                          <span className="block">{formatDate(a.clearedAt)}</span>
                          <span className="block text-xs text-slate-400">{formatTime(a.clearedAt)}</span>
                        </>
                      ) : (
                        <span className="font-medium text-amber-700" title="Still breaching — not cleared">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">
                      {clearedText(a)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        tone={tone}
                        label={statusText(a, statusTexts)}
                        pulse={a.state === 'ACTIVE' && !a.acknowledgedAt}
                      />
                    </td>
                    <td
                      className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-700"
                      title={a.clearedAt ? undefined : 'Still active — no cleared time yet'}
                    >
                      {alarmDurationText(a)}
                    </td>
                    <td className="px-4 py-3">
                      {a.acknowledgedAt ? (
                        <span title={a.acknowledgeReason ?? undefined} className="text-slate-700">
                          <span className="block font-medium">{a.acknowledgedBy}</span>
                          <span className="block text-xs text-slate-400">{formatDateTime(a.acknowledgedAt)}</span>
                        </span>
                      ) : (
                        <span className="font-medium text-rose-600">Awaiting</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {needsAcknowledgement(a) && can('alarms.acknowledge') && (
                        <Button size="sm" variant="outline" onClick={() => { setDialogError(''); setTarget(a); }}>
                          Acknowledge
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border-t border-slate-100">
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      </div>

      <AcknowledgeDialog
        alarm={target}
        open={target !== null}
        submitting={submitting}
        error={dialogError}
        onSubmit={acknowledge}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}

/**
 * The row's left edge marker, in the same four tones the cards use.
 * `StatusBadge`'s own token palette is designed for a tinted pill, which is too
 * pale to read as a 4px rule, so these are the solid counterparts.
 */
const ACCENT: Record<'danger' | 'info' | 'warn' | 'ok', string> = {
  danger: 'bg-rose-500',
  info: 'bg-sky-500',
  warn: 'bg-amber-500',
  ok: 'bg-emerald-500',
};

/**
 * The value's ink says which WAY the reading broke — warm for a high breach, cold
 * for a low one. Direction comes from what the evaluator recorded, never from
 * comparing the number to the limit here.
 */
const VALUE_INK: Record<'high' | 'low' | 'none', string> = {
  high: 'text-rose-600',
  low: 'text-sky-600',
  none: 'text-slate-900',
};

function MetricGlyph({ metric }: { metric: string }) {
  const path = metric === 'HUMIDITY'
    ? 'M12 21a6.75 6.75 0 006.75-6.75c0-3.75-4.5-9.75-6.75-11.25C9.75 4.5 5.25 10.5 5.25 14.25A6.75 6.75 0 0012 21z'
    : 'M9.75 3.75a2.25 2.25 0 014.5 0v9.026a4.5 4.5 0 11-4.5 0V3.75z';
  return (
    <svg className="h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={path} />
    </svg>
  );
}

/**
 * The bracketed legend under a column name rather than beside it (operator,
 * 2026-08-29). `block` is what puts it on its own line; keeping it inside the
 * same <th> means the two lines stay one sortable, one-cell heading rather than
 * becoming a second header row that every colSpan would then have to know about.
 */
function UnitLine({ children }: { children: React.ReactNode }) {
  return <span className="block font-normal normal-case tracking-normal opacity-70">{children}</span>;
}

/**
 * A header cell. Sortable when given a `sortKey` — and only for the columns the
 * SERVER can order on, since sorting one page of a paged result would rearrange
 * twelve rows and call it a sort of five hundred.
 */
function Th({
  children, sortKey, sort, dir, onSort, title,
}: {
  children?: React.ReactNode;
  sortKey?: AlarmSortKey;
  sort?: AlarmSortKey;
  dir?: 'asc' | 'desc';
  onSort?: (k: AlarmSortKey) => void;
  title?: string;
}) {
  if (!sortKey || !onSort) {
    return <th className="whitespace-nowrap px-4 py-3.5 align-top" title={title}>{children}</th>;
  }
  const active = sort === sortKey;
  return (
    <th className="whitespace-nowrap px-4 py-3.5 align-top" title={title} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
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

/**
 * Hold a value still until typing stops.
 *
 * Local to this page rather than a shared hook: the only thing on the screen that
 * fires per keystroke is the search box, and a filter that queried the server on
 * every letter would put a request behind each one and let a slower response
 * overwrite a newer result.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}
