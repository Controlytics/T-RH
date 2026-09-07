import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { INTERVALS, coerceReading, formatDecimals, isOutOfRange, isSensorFailureValue } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
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
 * Two parts, each with one job:
 *  - the SELECTION row — Block, Area, and a tick list of the instruments in
 *    scope. Everything in scope is selected until something is unticked
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
 * The DOWNLOAD is NOT here (2026-09-07): it is the card's, so the page has one
 * trigger. It was this widget's from 2026-09-05, with a cover block the
 * operator then asked to drop.
 *
 * Period and interval share `useTrendPeriod`'s URL state with the trend page,
 * so the same presets, the same custom range and the same interval keys apply
 * — one vocabulary for "what period is this" across the two screens.
 */

interface HistoryRow { instrumentId: string; ts: string; values: Record<string, unknown> }

const th = 'px-4 py-3 text-left text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-slate-600';

/**
 * The widget prints NO title of its own: the page header names the screen, and
 * two headings for one screen is what the dashboard-era `embedded` flag existed
 * to prevent (there the PanelCard owned the title and the controls rode in its
 * header through a portal). Both went with the panel — a prop with one caller
 * that no longer exists is dead code, not an option. Its header row is the
 * selection summary on the left and the Block / Area / Interval controls with
 * the download on the right; the period presets and the custom range sit on a
 * second row, since seven buttons and two date inputs do not fit beside them.
 */
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

  // Block, Area and Interval — one group, `flex-nowrap`, so the header row
  // stays one row.
  const compactToolbar = (
    <div className="flex flex-nowrap items-center gap-2">
      <Select
        selectSize="sm"
        value={blockId}
        aria-label="Block"
        onChange={(e) => setBlock(e.target.value)}
      >
        <option value="">All blocks</option>
        {tree.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </Select>
      <Select
        selectSize="sm"
        value={areaId}
        aria-label="Area"
        disabled={!blockId}
        onChange={(e) => setArea(e.target.value)}
      >
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
  );
  return (
    <section
      data-testid="history-widget"
      className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="min-w-0 truncate text-[0.8125rem] text-slate-500" data-testid="history-subtitle">{subtitle}</p>
        <div className="flex shrink-0 items-center gap-2">{compactToolbar}</div>
      </header>

      {/* The period row: presets and the custom range. */}
      <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          {TREND_PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant={period.label === p.label ? 'default' : 'secondary'} onClick={() => setPreset(p.ms)}>
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

      {/* The tick list. Everything in scope is selected until something is
          unticked; the count says what a download would cover. */}
      <div className="border-t border-slate-100 px-5 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="font-semibold uppercase tracking-[0.08em]">Instruments</span>
          <span data-testid="history-selection-count">
            {chosen.length} of {inScope.length} selected
          </span>
          {selected !== null && (
            <button type="button" className="text-[var(--theme-primary,#4f46e5)] hover:underline" onClick={() => setSelected(null)}>
              Select all
            </button>
          )}
          {selected === null && inScope.length > 0 && (
            <button type="button" className="text-[var(--theme-primary,#4f46e5)] hover:underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
        {inScope.length === 0 ? (
          <p className="text-sm text-slate-500">No instruments in this scope.</p>
        ) : (
          <div className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto sm:grid-cols-3 lg:grid-cols-5">
            {inScope.map((i) => (
              <Checkbox
                key={i.id}
                label={i.code}
                checked={selected === null || selected.has(i.id)}
                onChange={() => setSelected(toggleSelection(inScope, selected, i.id))}
              />
            ))}
          </div>
        )}
      </div>

      {/* The merged readings. */}
      {chosenIds.length === 0 ? (
        <p className="border-t border-slate-100 px-6 py-4 text-sm text-slate-500">Select at least one instrument.</p>
      ) : histError ? (
        <p className="border-t border-slate-100 px-6 py-4 text-sm text-red-700">The readings could not be loaded. Try again.</p>
      ) : !histLoading && rows.length === 0 ? (
        <p className="border-t border-slate-100 px-6 py-4 text-sm text-slate-500">No readings in this period.</p>
      ) : (
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary, #4f46e5) 8%, #ffffff)' }}>
                <th scope="col" className={`${th} pl-6`}>Instrument</th>
                <th scope="col" className={th}>Timestamp</th>
                <th scope="col" className={`${th} !text-center`}>Temperature (°C)</th>
                <th scope="col" className={`${th} !text-center`}>Humidity (%RH)</th>
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
                    <td className="px-4 py-3.5 text-sm text-slate-700">{formatDateTime(row.ts)}</td>
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
