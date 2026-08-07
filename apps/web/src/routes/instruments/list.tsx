import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { useCan } from '@/hooks/use-can';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';
import { themeGradient, themeGradientBr } from '@/lib/theme-styles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';

/**
 * The instruments register, laid out around the question it is actually opened
 * to answer: WHICH DEVICES ARE TALKING?
 *
 * ── STATUS IS OBSERVED, NOT DECLARED (2026-08-07, operator request) ──
 * Active means telemetry is arriving: within the instrument's own expected
 * interval where it declares one, otherwise within the configurable window in
 * Configuration → Instrument Activity. It is NOT the admin enable/disable flag
 * — that is a separate fact, shown as its own "Disabled" badge, because
 * "nobody turned it off, it just stopped talking" and "we turned it off" call
 * for opposite responses.
 *
 * The previous table answered that with a raw "Last seen" datetime, leaving the
 * reader to subtract the current time and then compare against whatever
 * interval that particular instrument promised. Every row demanded arithmetic.
 * Now the signal state (see `./signal`) does it, the summary strip counts it,
 * and the strip's tiles are FILTERS — so noticing "3 silent" and acting on it
 * is one click, not a re-read of the table.
 *
 * Colour discipline: the brand gradient appears exactly twice (the header band
 * and the primary action). Everything else that is coloured is coloured because
 * it is a state, and those hues are fixed rather than themed — see `./signal`.
 */

interface InstrumentRow {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  tokenPrefix: string | null;
  lastSeenAt: string | null;
  lastSeenVia: string | null;
  expectedIntervalSec: number | null;
  isGateway: boolean;
  block: string | null;
  area: string | null;
  location: string | null;
}
interface ListResponse {
  data: InstrumentRow[];
  total: number; page: number; limit: number; totalPages: number;
}

/**
 * A tile in the summary strip. Clicking one applies its filter, and the active
 * one is ringed — the count and the filter are the same control, so a number
 * that surprises you is immediately explorable.
 */
function SummaryTile({
  label, value, tone, active, onClick,
}: {
  label: string;
  value: number | string;
  tone: 'active' | 'inactive' | 'brand';
  active: boolean;
  onClick: () => void;
}) {
  const bar = tone === 'active' ? 'bg-emerald-500' : tone === 'inactive' ? 'bg-slate-400' : '';
  const dot = tone === 'active' ? 'bg-emerald-500' : tone === 'inactive' ? 'bg-slate-400' : '';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group relative overflow-hidden rounded-2xl border bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
        active ? 'border-slate-400 shadow-md' : 'border-slate-200'
      }`}
    >
      {tone === 'brand'
        ? <span className="absolute inset-x-0 top-0 h-1" style={themeGradient} />
        : <span className={`absolute inset-x-0 top-0 h-1 ${bar}`} />}
      <div className="flex items-center gap-2">
        {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      </div>
      <p className="mt-1 text-3xl font-bold tabular-nums text-slate-800">{value}</p>
    </button>
  );
}

export function InstrumentListPage() {
  const can = useCan();
  const paginationOptions = usePaginationConfig();

  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [active, setActive] = useState('');
  /**
   * Reporting status is computed in the browser from `lastSeenAt` +
   * `expectedIntervalSec` + the configured window, so this filter applies to
   * the page in hand rather than being sent to the API. The tile counts say "on
   * this page" for the same reason — a count that silently described only 10 of
   * 240 rows would be a lie.
   */
  const [tileFilter, setTileFilter] = useState<'active' | 'inactive' | 'gateway' | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    debounceRef.current = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const params = new URLSearchParams({ page: String(page), limit: String(perPage) });
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (active) params.set('isActive', active);

  const { data, isLoading } = useSWR<ListResponse>(`/api/instruments?${params}`);
  // The fallback window for instruments that declare no expected interval.
  const { data: activityConfig } = useSWR<{ activeWindowMinutes?: number }>('/api/config/instrument-activity/current');
  const activeWindow = activityConfig?.activeWindowMinutes ?? INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN;
  const rows = data?.data ?? [];

  const withStatus = rows.map((r) => ({
    row: r,
    reporting: isInstrumentReporting(r.lastSeenAt, r.expectedIntervalSec, activeWindow),
  }));
  const counts = {
    active: withStatus.filter((r) => r.reporting).length,
    inactive: withStatus.filter((r) => !r.reporting).length,
    gateway: withStatus.filter((r) => r.row.isGateway).length,
  };
  const shown = tileFilter
    ? withStatus.filter((r) => (
        tileFilter === 'gateway' ? r.row.isGateway
        : tileFilter === 'active' ? r.reporting
        : !r.reporting))
    : withStatus;

  const toggle = (f: 'active' | 'inactive' | 'gateway') => setTileFilter((cur) => (cur === f ? null : f));
  const filtersActive = Boolean(debouncedSearch || active);

  return (
    <div className="space-y-6">
      {/* The one place the brand gradient is spent on this page. */}
      <div className="relative overflow-hidden rounded-2xl p-6 text-white shadow-lg" style={themeGradient}>
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">Register</p>
            <h1 className="mt-1 text-3xl font-bold">Instruments</h1>
            <p className="mt-1 text-sm text-white/80">
              Every device registered to report into this system — and whether it is reporting.
            </p>
          </div>
          {can('instruments.create') && (
            <div className="flex flex-wrap gap-2">
              <Link to="/instruments/bulk">
                <Button className="border border-white/30 bg-white/10 text-white hover:bg-white/20">
                  Bulk upload
                </Button>
              </Link>
              <Link to="/instruments/new">
                <Button className="bg-white text-slate-800 hover:bg-white/90">New instrument</Button>
              </Link>
            </div>
          )}
        </div>
        {/* Ambient mast motif — the page's own vocabulary, not generic blobs. */}
        <div aria-hidden="true" className="pointer-events-none absolute -right-4 bottom-0 flex items-end gap-2 opacity-15">
          {[24, 44, 68, 96, 120].map((h) => (
            <span key={h} className="w-4 rounded-t-md bg-white" style={{ height: h }} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryTile label="Active" value={counts.active} tone="active" active={tileFilter === 'active'} onClick={() => toggle('active')} />
        <SummaryTile label="Inactive" value={counts.inactive} tone="inactive" active={tileFilter === 'inactive'} onClick={() => toggle('inactive')} />
        <SummaryTile label="Gateways" value={counts.gateway} tone="brand" active={tileFilter === 'gateway'} onClick={() => toggle('gateway')} />
      </div>
      <p className="-mt-4 text-xs text-slate-400">
        Counts describe the {rows.length} instrument{rows.length === 1 ? '' : 's'} on this page.
        Active means telemetry arrived within the instrument’s expected interval, or within{' '}
        {activeWindow} minute{activeWindow === 1 ? '' : 's'} when it declares none.
      </p>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap gap-3">
          <Input
            className="w-64"
            placeholder="Search name, code or serial…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select className="w-40" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
          {tileFilter && (
            <button
              type="button"
              onClick={() => setTileFilter(null)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Clear {tileFilter} filter
            </button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80 text-left">
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Instrument</th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={3} className="py-10 text-center text-slate-400">Loading…</td></tr>
            )}

            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-14 text-center">
                  <div
                    className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-md"
                    style={themeGradientBr}
                  >
                    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                    </svg>
                  </div>
                  <p className="font-semibold text-slate-700">
                    {filtersActive ? 'No instruments match these filters' : 'No instruments registered yet'}
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    {filtersActive
                      ? 'Clear a filter to widen the search.'
                      : 'Register a device to give it a token and a topic to report on.'}
                  </p>
                  {!filtersActive && can('instruments.create') && (
                    <Link to="/instruments/new" className="mt-4 inline-block">
                      <Button>Register the first instrument</Button>
                    </Link>
                  )}
                </td>
              </tr>
            )}

            {!isLoading && rows.length > 0 && shown.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-12 text-center text-sm text-slate-500">
                  Nothing on this page is {tileFilter === 'gateway' ? 'a gateway' : tileFilter}.
                </td>
              </tr>
            )}

            {shown.map(({ row: r, reporting }) => (
              <tr key={r.id} className="group transition-colors hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <Link to={`/instruments/${r.id}`} className="flex flex-col leading-tight">
                    <span className="flex items-center gap-2 font-semibold text-slate-800 group-hover:text-slate-900">
                      {r.name}
                      {r.isGateway && (
                        <span
                          className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
                          style={themeGradient}
                        >
                          Gateway
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-xs text-slate-500">{r.code}</span>
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        reporting
                          ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                          : 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${reporting ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                      {reporting ? 'Active' : 'Inactive'}
                    </span>
                    {/* The ADMIN flag, which is a different fact: this device is
                        switched off, so it cannot report even if it wanted to.
                        Shown separately so a deliberate shutdown is never
                        mistaken for a dead device. */}
                    {!r.isActive && (
                      <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
                        Disabled
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to={`/instruments/${r.id}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50"
                  >
                    Open
                    <svg className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageSize={perPage}
        totalItems={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPerPage(n); setPage(1); }}
        pageSizeOptions={paginationOptions}
      />
    </div>
  );
}
