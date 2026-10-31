/**
 * What the four widget renderers share: their instruments and latest values in
 * display order, the three states every widget can be in, and the period
 * control of the two history widgets.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_PERIOD, PERIOD_PRESETS, WIDGET_COLOR_COUNT,
  type CustomWidget, type DashboardTimeWindow, type LatestKeyValue, type LatestValuesRow, type WidgetKey,
} from '@digilog/shared';
import { isRefusal } from '@/lib/refusal';
import {
  THIS_REQUEST_ONLY, useLatestValues, useWidgetInstrumentIds, type WidgetRange, type WidgetSelection,
} from './use-widget-data';

export const NO_INSTRUMENTS = 'No instruments in your view';
export const LOAD_FAILED = 'Could not load this widget.';
/** In view, but none of them has sent the widget's keys — distinct from out of view. */
export const NO_KEY_YET = 'No instrument here has sent these keys yet.';

/** The value a row holds for one widget key. */
export function valueOf(row: LatestValuesRow, key: WidgetKey): LatestKeyValue | undefined {
  return row.values.find((v) => v.source === key.source && v.key === key.key);
}

/**
 * A widget's instruments and their latest values, in the widget's order.
 *
 * An instrument the viewer may not see is absent from the server's answer and so
 * is simply not drawn; `empty` is the case where NONE of them is in view — said
 * only when both requests SUCCEEDED.
 *
 * On THE held-answer rule (`answerState`, F-I1 / F-I2): both requests are this
 * request's only (`THIS_REQUEST_ONLY`), so the rows held always answer the
 * widget as it stands. A first load or a drill-down that failed is `error`
 * ("Could not load this widget."); a failed REFRESH keeps the rows, drawn, and
 * `refreshFailed` says so (`WidgetNotes`) — no gauge keeps a silent "In limit".
 */
export function useWidgetRows(widget: CustomWidget, selection: WidgetSelection) {
  const { ids, loading: idsLoading, error: idsError } = useWidgetInstrumentIds(widget.source, selection);
  const { rows, loading, error: valuesError } = useLatestValues(ids, widget.keys, THIS_REQUEST_ONLY);
  const ordered = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.instrumentId, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is LatestValuesRow => r !== undefined);
  }, [rows, ids]);
  const settled = !idsLoading && !loading;
  const error = idsError ?? valuesError;
  const answer = answerState(ordered.length > 0, error);
  return {
    ids,
    rows: ordered,
    loading: answer === 'none' && !settled,
    error: answer === 'failed' ? error : undefined,
    empty: answer === 'none' && settled,
    /** Rows held through a failed refresh: drawn, and the widget says so. */
    refreshFailed: answer === 'stale',
  };
}

export function WidgetMessage({ children, tone = 'muted' }: { children: string; tone?: 'muted' | 'error' }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`py-6 text-center text-sm ${tone === 'error' ? 'text-red-700' : 'text-slate-500'}`}
    >
      {children}
    </p>
  );
}

/**
 * The widget keys none of these instruments has SENT — said by the widget
 * (`NoReadingsNote`) rather than drawn as nothing, or silently left out.
 */
export function keysNotSent(rows: readonly LatestValuesRow[], keys: readonly WidgetKey[]): WidgetKey[] {
  return keys.filter((key) => !rows.some((row) => valueOf(row, key)?.ts != null));
}

/**
 * "No readings for Voltage, Power" — the ONE wording for keys nobody has sent,
 * labels in the widget's key order (the gauge, the comparison bars and the bar
 * chart all say it this way). Null when there is nothing to say.
 */
export function noReadingsFor(labels: readonly string[]): string | null {
  return labels.length === 0 ? null : `No readings for ${labels.join(', ')}`;
}

export function NoReadingsNote({ labels }: { labels: readonly string[] }) {
  const text = noReadingsFor(labels);
  if (text === null) return null;
  return (
    <p className="text-xs font-medium text-amber-700" data-testid="widget-no-readings">
      {text}
    </p>
  );
}

/**
 * The element's width in whole px, followed as the panel is resized; null until
 * measured. A chart widget wraps its `LazyEChart` in the measured box, so how its
 * category labels stand (`codeAxis`) is decided by the width it really has.
 */
export function useBoxWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}

/**
 * A count as the widgets print one: grouped in the browser's locale ("1,380"),
 * a whole number. ONE formatter for every count on the widgets (the bar chart's
 * tooltip and axis, the pie, the alarm counts, "N more not shown").
 */
export const groupDigits = (n: number): string => Math.round(n).toLocaleString();

/** "Showing X of Y <things>" — every cap says what it did not draw. */
export function CapNote({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (shown >= total) return null;
  return (
    <p className="text-xs font-medium text-amber-700" data-testid="widget-cap-note">
      Showing {shown} of {total} {noun}
    </p>
  );
}

/** What a failed refresh could not refresh: readings, or — on the alarm widgets — alarms (one word, one meaning). */
export type RefreshNoun = 'readings' | 'alarms';

/** A widget still drawing what it last loaded after a refresh failed, in the words for what it draws. */
export function refreshFailedText(noun: RefreshNoun): string {
  return `These ${noun} could not be refreshed. Showing the last ones that loaded.`;
}

/**
 * The readings widgets' wording, and the trend page's own (`trend.tsx`'s chart
 * panel imports this), so the app says it one way.
 */
export const REFRESH_FAILED = refreshFailedText('readings');

/**
 * The notes a widget prints above what it draws — the cap, the tiles beyond a
 * cap ("N more not shown", the status grid), the keys with no readings, a failed
 * refresh — on ONE wrapping row, so each widget says them the same way and the
 * drawing keeps its room (fix round 1, m-6). Nothing to say → nothing rendered.
 */
export function WidgetNotes({ cap, more = 0, unsent = [], refreshFailed = false, refreshNoun = 'readings' }: {
  cap?: { shown: number; total: number; noun: string };
  /** How many the widget did not draw, said as "N more not shown". */
  more?: number;
  unsent?: readonly string[];
  refreshFailed?: boolean;
  /** What the widget draws, for the failed-refresh note (M-2): the alarm widgets say "alarms". */
  refreshNoun?: RefreshNoun;
}) {
  const capped = cap !== undefined && cap.shown < cap.total;
  if (!capped && more <= 0 && unsent.length === 0 && !refreshFailed) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1" data-testid="widget-notes">
      {capped && <CapNote shown={cap.shown} total={cap.total} noun={cap.noun} />}
      {more > 0 && (
        <p className="text-xs font-medium text-amber-700" data-testid="widget-more-note">{groupDigits(more)} more not shown</p>
      )}
      <NoReadingsNote labels={unsent} />
      {refreshFailed && (
        <p className="text-xs font-medium text-amber-700" data-testid="widget-refresh-failed">{refreshFailedText(refreshNoun)}</p>
      )}
    </div>
  );
}

/**
 * THE held-answer rule of the widgets (Task 7 fix round 1, I-1): whether a
 * widget draws the answer it holds.
 *
 * `answersCurrent` is true only when the held answer ANSWERS THE REQUEST THE
 * WIDGET MAKES NOW — never a previous scope's: SWR's `keepPreviousData` hands a
 * key with nothing cached the previous key's data, and a drill-down whose request
 * failed drew Block A's alarm counts as Block B's. Each widget says it its way:
 * - the present-state widgets (alarm counts, both pies, the status grid) and
 *   every KEY widget's instruments and latest values (`useWidgetRows`, F-I1 —
 *   gauges, comparison bars, value cards and the latest table among them) read
 *   hooks that return ONLY the current request's answer (`THIS_REQUEST_ONLY`
 *   in `use-widget-data.ts`), so "an answer is held" IS "it answers";
 * - the bar chart, whose rolling window is a NEW request every minute, compares
 *   the request its answer came from with the one it makes now (`heldAnswers`).
 *
 * - `fresh`: a current answer, no failure;
 * - `stale`: a current answer held through a failed REFRESH — drawn, and said
 *   (`WidgetNotes refreshFailed`). Every hook behind them keeps retrying at its
 *   cadence (`widgetPolling`, the dashboards' one policy — the overview too);
 * - `failed`: a REFUSAL (a 403 for a viewer without ALARM_READ) never keeps what
 *   it holds, and a failure with no current answer is a failure — "Could not
 *   load this widget.", as the readings table says on the same key;
 * - `none`: no current answer yet, nothing failed — the widget's loading state.
 */
export function answerState(answersCurrent: boolean, error: unknown): 'fresh' | 'stale' | 'failed' | 'none' {
  const failed = error !== undefined && error !== null;
  if (failed) return isRefusal(error) || !answersCurrent ? 'failed' : 'stale';
  return answersCurrent ? 'fresh' : 'none';
}

/**
 * Which palette slot each key draws in, where a key's colour is its own (fix
 * round 1, m-7): a key with a chosen `color` keeps it; the keys without one
 * take the slots NOT chosen by any key, in key order — so a default never lands
 * on a slot another key chose (`key.color ?? index` drew `[{}, {color: 0}]` both
 * in slot 0). Two keys given the same colour keep it: that is a choice. More
 * keys than free slots wrap round the palette rather than leave it.
 */
export function keyColorSlots(keys: readonly { color?: number }[], slots: number = WIDGET_COLOR_COUNT): number[] {
  const chosen = new Set(keys.flatMap((k) => (typeof k.color === 'number' ? [k.color] : [])));
  const free = Array.from({ length: slots }, (_, n) => n).filter((n) => !chosen.has(n));
  let next = 0;
  return keys.map((k, n) => {
    if (typeof k.color === 'number') return k.color;
    const slot = next < free.length ? free[next] : n % slots;
    next += 1;
    return slot;
  });
}

/**
 * The period a history widget shows. The stored option is only the DEFAULT; a
 * viewer's choice (and a chart zoom) is session state.
 *
 * `to` is rounded UP to the next minute, so the window moves once a minute and
 * the polls in between re-ask the same range — which still includes every
 * reading up to now — instead of minting a new cache key on every render.
 */
export const DASHBOARD_PRESET = 'dashboard';

export function useWidgetRange(defaultPeriod: string | undefined, window?: DashboardTimeWindow) {
  const [preset, setPreset] = useState(defaultPeriod ?? (window ? DASHBOARD_PRESET : DEFAULT_PERIOD));
  const [zoom, setZoom] = useState<WidgetRange | null>(null);
  // Following the dashboard: the window's own period (relative) or its stored
  // from / to (fixed). Any other preset is the widget's own choice.
  const following = preset === DASHBOARD_PRESET && window !== undefined;
  const fixed = following && window.mode === 'fixed' ? window : null;
  const effective = following && window.mode === 'relative' ? window.period : preset;
  const ms = (PERIOD_PRESETS.find((p) => p.value === effective) ?? PERIOD_PRESETS.find((p) => p.value === DEFAULT_PERIOD)!).ms;
  const toMs = Math.ceil(Date.now() / 60_000) * 60_000;
  const fixedFrom = fixed?.from;
  const fixedTo = fixed?.to;
  const live = useMemo(
    () => (fixedFrom !== undefined && fixedTo !== undefined
      ? { from: fixedFrom, to: fixedTo }
      : { from: new Date(toMs - ms).toISOString(), to: new Date(toMs).toISOString() }),
    [toMs, ms, fixedFrom, fixedTo],
  );
  const range = zoom ?? live;
  return {
    preset,
    setPreset: (p: string) => { setZoom(null); setPreset(p); },
    range,
    /**
     * The range moves with the clock (a period, its `to` the next minute) rather
     * than being fixed (a fixed dashboard window, or a zoom): an answer held from
     * a minute ago still answers a rolling range of the same span.
     */
    rolling: zoom === null && fixed === null,
    zoomed: zoom !== null,
    zoomTo: (from: Date, to: Date) => setZoom({ from: from.toISOString(), to: to.toISOString() }),
    resetZoom: () => setZoom(null),
  };
}

export function PeriodSelect({ value, onChange, name, withDashboard }: {
  value: string; onChange: (v: string) => void; name: string; withDashboard?: boolean;
}) {
  return (
    <select
      aria-label="Period"
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="ctl ctl-sm"
    >
      {withDashboard && <option value={DASHBOARD_PRESET}>Dashboard window</option>}
      {PERIOD_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
    </select>
  );
}
