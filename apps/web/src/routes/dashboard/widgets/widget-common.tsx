/**
 * What the four widget renderers share: their instruments and latest values in
 * display order, the three states every widget can be in, and the period
 * control of the two history widgets.
 */
import { useMemo, useState } from 'react';
import {
  DEFAULT_PERIOD, PERIOD_PRESETS,
  type CustomWidget, type LatestKeyValue, type LatestValuesRow, type WidgetKey,
} from '@digilog/shared';
import { useLatestValues, useWidgetInstrumentIds, type WidgetRange, type WidgetSelection } from './use-widget-data';

export const NO_INSTRUMENTS = 'No instruments in your view';
export const LOAD_FAILED = 'Could not load this widget.';

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
export function useWidgetRange(defaultPeriod: string | undefined) {
  const [preset, setPreset] = useState(defaultPeriod ?? DEFAULT_PERIOD);
  const [zoom, setZoom] = useState<WidgetRange | null>(null);
  const ms = (PERIOD_PRESETS.find((p) => p.value === preset) ?? PERIOD_PRESETS.find((p) => p.value === DEFAULT_PERIOD)!).ms;
  const toMs = Math.ceil(Date.now() / 60_000) * 60_000;
  const live = useMemo(
    () => ({ from: new Date(toMs - ms).toISOString(), to: new Date(toMs).toISOString() }),
    [toMs, ms],
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

export function PeriodSelect({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  return (
    <select
      aria-label="Period"
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="ctl ctl-sm"
    >
      {PERIOD_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
    </select>
  );
}
