/**
 * An EXTRA key on the trend page — one of the profile's display keys (widget
 * data keys phase 3, spec §7).
 *
 * Judged by the same rules as the dashboard's built widgets, through Phase 2's
 * `keyCell` / `formatKeyValue`: a measured key (the server sent `judged`) wears
 * the server's unit, decimals and verdict; a raw key is shown as received and
 * NEVER takes a status colour. There is no arc here — a raw key has no band, and
 * a measured extra key's band belongs to the gauges above.
 */
import { coerceReading, type LatestKeyValue, type WidgetKey } from '@digilog/shared';
import type { SensorWords } from '@/hooks/use-failure-text';
import { formatKeyValue, keyCell } from '@/routes/dashboard/widgets/key-value';
import { pillTone, type PillTone } from './timeseries-table-card';

export function ExtraKeyCard({
  widgetKey, value, reporting, words, formatTs,
}: {
  widgetKey: WidgetKey;
  /** This instrument's latest value for the key; undefined when it never sent it. */
  value: LatestKeyValue | undefined;
  reporting: boolean;
  words: SensorWords;
  formatTs: (ts: string) => string;
}) {
  const cell = keyCell(value, reporting, widgetKey, words);
  return (
    <div
      data-testid="extra-key-card"
      data-judged={cell.judged ? 'true' : 'false'}
      className={`relative overflow-hidden rounded-[var(--radius-card)] border ${cell.classes.border} bg-white py-4 pl-5 pr-4 shadow-[var(--elev-1)]`}
    >
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${cell.classes.dot}`} />
      <p className="truncate text-xs font-bold uppercase tracking-[0.08em] text-slate-500" title={widgetKey.label ?? widgetKey.key}>
        {widgetKey.label ?? widgetKey.key}
      </p>
      <p className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-3xl font-bold tabular-nums text-slate-900">{cell.text}</span>
        {cell.unit && <span className="text-sm font-semibold text-slate-500">{cell.unit}</span>}
      </p>
      <p className={`mt-1.5 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.04em] ${cell.classes.text}`}>
        <span aria-hidden className={`h-2 w-2 rounded-full ${cell.classes.dot}`} />
        {cell.label}
      </p>
      <p className="mt-2 text-xs text-slate-500">{value?.ts ? formatTs(value.ts) : '—'}</p>
    </div>
  );
}

/**
 * How an extra key's Time Series column prints one stored reading.
 *
 * Measured: judged against the server's bounds (the latest value's `judged`),
 * at the server's decimals. Raw: as received, always `unjudged`. Never the
 * sensor-failure word — whether a raw key's text is a fault is not something
 * this page knows (ruling P3-5).
 */
export function extraColumnCell(
  v: LatestKeyValue | undefined,
  widgetKey: WidgetKey,
): (raw: unknown) => { text: string; tone: PillTone } {
  return (raw) => {
    const reading: LatestKeyValue = v
      ? { ...v, value: raw ?? null }
      : { source: 'telemetry', key: widgetKey.key, value: raw ?? null, ts: null, unit: null, decimals: null, display: null, judged: null };
    const text = formatKeyValue(reading, widgetKey);
    const tone: PillTone = v?.judged ? pillTone(coerceReading(raw), v.judged.limitMin, v.judged.limitMax) : 'unjudged';
    return { text, tone };
  };
}
