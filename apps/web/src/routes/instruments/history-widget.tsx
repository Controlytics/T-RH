import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { INTERVALS, coerceReading, formatDecimals, isOutOfRange, isSensorFailureValue } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { useSensorWords } from '@/hooks/use-failure-text';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import type { HistoryScope } from '@/routes/data-report/use-history-scope';
import { useTrendPeriod, TREND_PRESETS } from './use-trend-data';
import { pillTone, rowTone, ROW_ACCENT, PILL_CLASS, FAULT_PILL, type PillTone } from './timeseries-table-card';
import { toggleSelection } from './history-selection';

/**
 * The Instrument HISTORY widget (operator, 2026-09-05): *"same like
 * trends page time series … provide Block and Area and instrument selection
 * … Area wise instruments history report … and also multiple selection and
 * download report for only selected instruments"*. It is the body of the
 * `/data-report` page since 2026-09-07 (operator: *"in dashboard Instruments
 * history widget was there that widget removed there and add one side bar
 * option Data Report, in that it should come"*), after a day on the
 * Instruments page and two as the dashboard panel `dashboard_history`.
 *
 * Restyled 2026-09-16 (operator: *"Data Report View ui not looking good, and
 * make it more professional and as a pro developer update ui with more
 * colorful"*) to the Settings widget's language, which the operator had just
 * approved: a toolbar, a row of four SUMMARY TILES (each with its own accent
 * bar), the instruments as tick CHIPS, and the readings table with the
 * dashboard's quantity colours on its two value columns. Nothing about what is
 * fetched, judged or counted changed — only how it is drawn.
 *
 * Two parts, each with one job:
 *  - the SELECTION — Block, Area, and the chips of the instruments in scope.
 *    Everything in scope is selected until something is unticked
 *    (`history-selection.ts` holds the rules; the Block → Areas expansion is
 *    the SERVER's, through `/api/instruments?functionalLocationId=`). The
 *    selection STATE is the page's (`useHistoryScope`, passed in as `scope`),
 *    because the Generate Data Report card above this widget downloads the
 *    report for the same selection — one owner, or the two could disagree.
 *  - the READINGS table — the merged, paged, newest-first readings of the
 *    selection over the chosen period, from `/api/instruments/telemetry-history`
 *    (pivoted server-side so a page cannot split an instant). Each row is
 *    judged with ITS OWN instrument's limits, precision and span, read from
 *    `telemetry-overview` — never a site-wide guess, since two instruments in
 *    one Area can carry different specs.
 *
 * **The Readings tile prints the SERVER's `total`, never `rows.length`** —
 * that is one page, and a count taken from it would describe the page while
 * reading as the period (the 2026-08-31 alarms-count defect). There is
 * deliberately NO out-of-limit tile: only one page is in hand, and the server
 * offers no whole-period breach count for a multi-instrument selection.
 *
 * The DOWNLOAD is NOT here (2026-09-07): it is the card's, so the page has one
 * trigger. Period and interval share `useTrendPeriod`'s URL state with the
 * trend page — one vocabulary for "what period is this" across the two screens.
 *
 * The widget prints NO heading of its own: the page header names the screen,
 * and the page test asserts exactly one heading.
 */

interface HistoryRow { instrumentId: string; ts: string; values: Record<string, unknown> }

const th = 'px-4 py-3 text-left text-[0.6875rem] font-bold uppercase tracking-[0.08em]';

/**
 * Tile accents. The two QUANTITY colours are the dashboard's own
 * (`.tv-h-temp` burnt orange, `.tv-h-rh` green in app.css) and are reserved
 * for the value columns; the tiles describe the SELECTION, not a reading, so
 * they take the site theme and three neutral-of-meaning hues that no status
 * or quantity in this app already uses.
 */
const TILE = {
  theme: { bar: 'var(--theme-primary, #2a78d6)', wash: 'color-mix(in srgb, var(--theme-primary, #2a78d6) 8%, #ffffff)', ink: '#0f172a' },
  sky: { bar: '#0369a1', wash: '#f0f9ff', ink: '#0c4a6e' },
  violet: { bar: '#6d28d9', wash: '#f5f3ff', ink: '#4c1d95' },
  cyan: { bar: '#0e7490', wash: '#ecfeff', ink: '#155e75' },
} as const;

export function InstrumentHistoryWidget({ scope }: { scope: HistoryScope }) {
  const { tree, blockId, areaId, scopeId, setBlock, setArea, areas, selected, setSelected, inScope, chosen, overviewById } = scope;
  const { period, setPreset, setCustom, setInterval } = useTrendPeriod();
  const paginationOptions = usePaginationConfig();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(paginationOptions[0]);
  const sensorWords = useSensorWords();
  const { formatDateTime } = useDatetimeFormat();

  const chosenIds = chosen.map((i) => i.id);

  // A scope, selection or period change resets the page: page 3 of the old
  // selection is usually past the end of the new one. The SCOPE is in the list
  // because `selected` stays `null` from one Block to the next, and a reset
  // keyed on the selection alone left page 3's offset pointing into the new
  // scope (review, 2026-09-07).
  useEffect(() => { setPage(1); }, [period.from, period.to, selected, scopeId]);

  const histQs = new URLSearchParams({
    instrumentIds: chosenIds.join(','),
    from: period.from, to: period.to,
    limit: String(pageSize), offset: String((page - 1) * pageSize),
  });
  const { data: hist, isLoading: histLoading, error: histError } = useSWR<{ data: HistoryRow[]; total: number }>(
    chosenIds.length ? `/api/instruments/telemetry-history?${histQs}` : null,
  );
  const rows = hist?.data ?? [];
  const total = hist?.total ?? 0;
  const byId = useMemo(() => new Map(inScope.map((i) => [i.id, i])), [inScope]);

  const fromLocal = toLocalInput(period.from);
  const toLocal = toLocalInput(period.to);

  const subtitle = chosen.length === 0
    ? 'Choose a Block or Area, or tick instruments, to see their readings'
    : `${chosen.length} instrument${chosen.length === 1 ? '' : 's'} · ${period.label}`;

  const intervalLabel = INTERVALS.find((i) => (i.seconds === null ? null : i.seconds * 1000) === period.intervalMs)?.label
    ?? INTERVALS[0].label;
  const areaName = areas.find((a) => a.id === areaId)?.name;
  const blockName = tree.find((b) => b.id === blockId)?.name;
  const whereLabel = areaName ?? blockName ?? 'All instruments';

  const tile = (
    testId: string, label: string, value: string, hue: keyof typeof TILE, detail?: string,
  ) => {
    const c = TILE[hue];
    return (
      <div
        data-testid={testId}
        className="relative flex min-w-0 flex-col gap-0.5 overflow-hidden rounded-[var(--radius-card)] border border-slate-200/80 py-3 pl-5 pr-4"
        style={{ background: c.wash, boxShadow: `inset 4px 0 0 0 ${c.bar}` }}
      >
        <span className="text-[0.75rem] font-medium text-slate-500">{label}</span>
        <span className="font-display truncate text-2xl font-bold leading-tight tabular-nums" style={{ color: c.ink }}>{value}</span>
        {detail && <span className="truncate text-[0.75rem] text-slate-500">{detail}</span>}
      </div>
    );
  };

  return (
    <section
      data-testid="history-widget"
      className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-2)]"
    >
      {/* Toolbar: where, when, how often. One tinted band so the controls read
          as one instrument panel rather than loose fields. */}
      <header
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
        style={{ background: 'color-mix(in srgb, var(--theme-primary, #2a78d6) 6%, #ffffff)' }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Select selectSize="sm" value={blockId} aria-label="Block" onChange={(e) => setBlock(e.target.value)}>
            <option value="">All blocks</option>
            {tree.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Select selectSize="sm" value={areaId} aria-label="Area" disabled={!blockId} onChange={(e) => setArea(e.target.value)}>
            <option value="">{blockId ? 'All areas' : 'Choose a block first'}</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <select
            value={period.intervalMs ?? ''}
            onChange={(e) => setInterval(e.target.value === '' ? null : Number(e.target.value))}
            className="ctl ctl-sm"
            aria-label="History interval"
          >
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.seconds === null ? '' : i.seconds * 1000}>{i.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-[var(--elev-1)]" role="group" aria-label="Period">
            {TREND_PRESETS.map((p) => (
              <Button
                key={p.label}
                size="sm"
                variant={period.label === p.label ? 'default' : 'ghost'}
                className="h-7 px-2.5"
                onClick={() => setPreset(p.ms)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            From
            <input
              type="datetime-local"
              value={fromLocal}
              onChange={(e) => e.target.value && setCustom(new Date(e.target.value).toISOString(), period.to)}
              className="ctl ctl-sm font-mono tabular-nums [color-scheme:light]"
              aria-label="History from"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            To
            <input
              type="datetime-local"
              value={toLocal}
              onChange={(e) => e.target.value && setCustom(period.from, new Date(e.target.value).toISOString())}
              className="ctl ctl-sm font-mono tabular-nums [color-scheme:light]"
              aria-label="History to"
            />
          </label>
        </div>
      </header>

      {/* Summary tiles. The Readings figure is the SERVER's whole-period
          total, never the page's row count. */}
      <div className="grid grid-cols-2 gap-3 border-t border-slate-100 px-5 py-4 lg:grid-cols-4">
        {tile('history-tile-instruments', 'Instruments', `${chosen.length} of ${inScope.length}`, 'theme', whereLabel)}
        {tile('history-tile-period', 'Period', period.label, 'sky', `${formatDateTime(period.from)} – ${formatDateTime(period.to)}`)}
        {tile('history-tile-readings', 'Readings in period', chosenIds.length === 0 ? '—' : histLoading ? '…' : total.toLocaleString(), 'violet', 'across the selection')}
        {tile('history-tile-interval', 'Interval', intervalLabel, 'cyan', 'first reading per slot')}
      </div>

      {/* The chips. Everything in scope is selected until something is
          unticked; the count says what a download would cover. */}
      <div className="border-t border-slate-100 px-5 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="font-semibold text-slate-700">Instruments</span>
          <span data-testid="history-selection-count">
            {chosen.length} of {inScope.length} selected
          </span>
          <span className="sr-only" data-testid="history-subtitle">{subtitle}</span>
          {selected !== null && (
            <button type="button" className="font-medium text-[var(--theme-primary,#4f46e5)] hover:underline" onClick={() => setSelected(null)}>
              Select all
            </button>
          )}
          {selected === null && inScope.length > 0 && (
            <button type="button" className="font-medium text-[var(--theme-primary,#4f46e5)] hover:underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
        {inScope.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-500">
            No instruments in this scope.
          </p>
        ) : (
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {inScope.map((i) => {
              const on = selected === null || selected.has(i.id);
              return (
                <label
                  key={i.id}
                  data-testid="history-chip"
                  data-checked={on ? 'true' : 'false'}
                  className={`inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-3 py-1 text-[0.8125rem] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--theme-primary,#2a78d6)] ${
                    on
                      ? 'border-transparent text-white shadow-[var(--elev-1)]'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                  style={on ? { background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' } : undefined}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => setSelected(toggleSelection(inScope, selected, i.id))}
                  />
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-white' : 'bg-slate-300'}`} />
                  {i.code}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* The merged readings. */}
      {chosenIds.length === 0 ? (
        <p className="border-t border-slate-100 px-6 py-6 text-center text-sm text-slate-500">Select at least one instrument.</p>
      ) : histError ? (
        <p className="border-t border-slate-100 px-6 py-6 text-center text-sm text-red-700">The readings could not be loaded. Try again.</p>
      ) : !histLoading && rows.length === 0 ? (
        <p className="border-t border-slate-100 px-6 py-6 text-center text-sm text-slate-500">No readings in this period.</p>
      ) : (
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary, #4f46e5) 10%, #ffffff)' }}>
                <th scope="col" className={`${th} pl-6 text-slate-600`}>Instrument</th>
                <th scope="col" className={`${th} text-slate-600`}>Timestamp</th>
                {/* The two quantity colours are the dashboard's own. */}
                <th scope="col" className={`${th} !text-center`} style={{ color: '#9a3412' }}>Temperature (°C)</th>
                <th scope="col" className={`${th} !text-center`} style={{ color: '#166534' }}>Humidity (%RH)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const ov = overviewById.get(row.instrumentId);
                const inst = byId.get(row.instrumentId);
                const temp = judge(row.values, ov?.temperature?.key ?? null, ov?.limits?.tempMin, ov?.limits?.tempMax,
                  ov?.rangeBounds?.temperatureLow ?? null, ov?.rangeBounds?.temperatureHigh ?? null);
                const rh = judge(row.values, ov?.humidity?.key ?? null, ov?.limits?.rhMin, ov?.limits?.rhMax,
                  ov?.rangeBounds?.humidityLow ?? null, ov?.rangeBounds?.humidityHigh ?? null);
                const tone = rowTone([temp.tone, rh.tone], temp.fault !== null || rh.fault !== null);
                return (
                  <tr key={`${row.instrumentId}|${row.ts}`} data-testid="history-row" data-tone={tone}
                    className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/70">
                    <td className="relative py-3.5 pl-6 pr-4">
                      <span className={`absolute bottom-1 left-0 top-1 w-1 rounded-r-sm ${ROW_ACCENT[tone]}`} aria-hidden="true" />
                      <span className="flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ROW_ACCENT[tone]}`} aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-slate-800">{inst?.code ?? ov?.code ?? row.instrumentId}</span>
                          {ov?.locationAttribute && (
                            <span className="block truncate text-xs text-slate-500">{ov.locationAttribute}</span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-sm tabular-nums text-slate-700">{formatDateTime(row.ts)}</td>
                    <HistoryValueCell judged={temp} decimals={ov?.decimals.temperature ?? 1} words={sensorWords} />
                    <HistoryValueCell judged={rh} decimals={ov?.decimals.humidity ?? 0} words={sensorWords} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {chosenIds.length > 0 && total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          totalItems={total}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          pageSizeOptions={paginationOptions}
        />
      )}

    </section>
  );
}

/** One slot of one row, judged with ITS instrument's own bounds. */
interface Judged {
  value: number | null;
  tone: PillTone;
  /** `'failure'` for a non-numeric reading, `'range'` for one outside the span. */
  fault: 'failure' | 'range' | null;
}

/**
 * The same precedence as the trend page's `ValueCell`: out of span first (it IS
 * a number, it is not a measurement), then a non-numeric reading, then the
 * number judged against the spec. A slot the instrument has no key for is
 * "no reading".
 */
export function judge(
  values: Record<string, unknown>,
  key: string | null,
  min: number | null | undefined,
  max: number | null | undefined,
  rangeLow: number | null,
  rangeHigh: number | null,
): Judged {
  if (!key || !(key in values)) return { value: null, tone: 'unjudged', fault: null };
  const raw = values[key];
  const n = coerceReading(raw);
  if (n === null) {
    return { value: null, tone: 'unjudged', fault: isSensorFailureValue(raw) ? 'failure' : null };
  }
  if (isOutOfRange(n, rangeLow, rangeHigh)) return { value: n, tone: 'unjudged', fault: 'range' };
  return { value: n, tone: pillTone(n, min, max), fault: null };
}

function HistoryValueCell({ judged, decimals, words }: {
  judged: Judged; decimals: number; words: { failure: string; outOfRange: string };
}) {
  if (judged.fault) {
    return (
      <td className="px-4 py-3.5 text-center">
        <span data-testid="history-value" data-tone="fault" className={FAULT_PILL}>
          {judged.fault === 'range' ? words.outOfRange : words.failure}
        </span>
      </td>
    );
  }
  if (judged.value === null) {
    return (
      <td className="px-4 py-3.5 text-center">
        <span data-testid="history-value" data-tone="none" className="text-sm text-slate-400">—</span>
      </td>
    );
  }
  return (
    <td className="px-4 py-3.5 text-center">
      <span data-testid="history-value" data-tone={judged.tone}
        className={`inline-flex rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums ${PILL_CLASS[judged.tone]}`}>
        {formatDecimals(judged.value, decimals)}
      </span>
    </td>
  );
}

/** ISO → the value a `datetime-local` input needs (local time, no seconds). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
