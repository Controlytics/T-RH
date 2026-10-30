/**
 * What the four widget renderers share: their instruments and latest values in
 * display order, the three states every widget can be in, and the period
 * control of the two history widgets.
 */
import { useMemo, useState } from 'react';
import {
  DEFAULT_PERIOD, PERIOD_PRESETS,
  type CustomWidget, type DashboardTimeWindow, type LatestKeyValue, type LatestValuesRow, type WidgetKey,
} from '@digilog/shared';
import { useLatestValues, useWidgetInstrumentIds, type WidgetRange, type WidgetSelection } from './use-widget-data';

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
 * is simply not drawn; `empty` is the case where NONE of them is in view.
 */
export function useWidgetRows(widget: CustomWidget, selection: WidgetSelection) {
  const { ids, loading: idsLoading } = useWidgetInstrumentIds(widget.source, selection);
  const { rows, loading, error } = useLatestValues(ids, widget.keys);
  const ordered = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.instrumentId, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is LatestValuesRow => r !== undefined);
  }, [rows, ids]);
  const settled = !idsLoading && !loading;
  return {
    ids,
    rows: ordered,
    loading: !settled && ordered.length === 0,
    error: error && ordered.length === 0 ? error : undefined,
    empty: settled && !error && ordered.length === 0,
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

/** "Showing X of Y <things>" — every cap says what it did not draw. */
export function CapNote({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (shown >= total) return null;
  return (
    <p className="text-xs font-medium text-amber-700" data-testid="widget-cap-note">
      Showing {shown} of {total} {noun}
    </p>
  );
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
