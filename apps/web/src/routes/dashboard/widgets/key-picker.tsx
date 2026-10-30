/**
 * The ONE key picker (spec G1): every key the chosen instruments have SENT (time
 * series) or CARRY (attributes), straight from `GET /api/instruments/data-keys`.
 * A key a device starts sending tomorrow appears here with its first reading —
 * nothing to configure.
 *
 * `numeric` is a HINT, never a gate (spec §4, ruling P2-1): a probe currently
 * sending `NA` stays choosable for a chart, flagged. Only an ATTRIBUTE — which
 * has no history at all — is refused for a widget whose keys must be telemetry
 * (`WIDGET_TYPE_SPECS[type].keys`), with the reason beside it (the same rule the
 * shared schema enforces). The type's `keysMax` is the cap.
 */
import { useState } from 'react';
import { WIDGET_TYPE_SPECS, type DataKeyInfo, type WidgetKey, type WidgetType } from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';

const NO_HISTORY: Partial<Record<WidgetType, string>> = {
  trend_chart: 'Attributes have no history to plot',
  timeseries_table: 'Attributes have no history to list',
  bar_chart: 'Attributes have no history to plot',
};
/** Widgets that DRAW a number: a key with no numeric reading lately is flagged (never refused). */
const PLOTS_NUMBERS: readonly WidgetType[] = ['trend_chart', 'bar_chart', 'gauge', 'comparison_bar'];

/** Why an attribute cannot go on this type, or undefined when it can. */
function attributeRefusal(type: WidgetType): string | undefined {
  return WIDGET_TYPE_SPECS[type].keys === 'telemetry' ? NO_HISTORY[type] ?? 'Attributes have no history' : undefined;
}

const sameKey = (a: { source: string; key: string }, b: { source: string; key: string }) =>
  a.source === b.source && a.key === b.key;

export function KeyPicker({
  catalogue, chosen, onChange, type, refuse,
}: {
  catalogue: DataKeyInfo[];
  chosen: WidgetKey[];
  onChange: (keys: WidgetKey[]) => void;
  type: WidgetType;
  /** A caller's own reason to refuse an entry (the trend page: a key it already draws). */
  refuse?: (e: DataKeyInfo) => string | undefined;
}) {
  const [search, setSearch] = useState('');
  const { formatDateTime } = useDatetimeFormat();
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? catalogue.filter((e) => `${e.label} ${e.key} ${e.measurement?.name ?? ''}`.toLowerCase().includes(needle))
    : catalogue;
  const keysMax = WIDGET_TYPE_SPECS[type].keysMax;
  const full = chosen.length >= keysMax;

  const toggle = (e: DataKeyInfo) => {
    if (chosen.some((k) => sameKey(k, e))) onChange(chosen.filter((k) => !sameKey(k, e)));
    // The catalogue's label is stored with the key, so the widget keeps its
    // heading even if the administered name changes later; it stays editable.
    else onChange([...chosen, { source: e.source, key: e.key, label: e.label }]);
  };

  const group = (title: string, source: DataKeyInfo['source']) => {
    const entries = visible.filter((e) => e.source === source);
    return (
      <fieldset role="group" aria-label={title} className="space-y-1">
        <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</legend>
        {entries.length === 0 && <p className="text-xs text-slate-400">None</p>}
        {entries.map((e) => {
          const checked = chosen.some((k) => sameKey(k, e));
          const refusal = (source === 'attribute' ? attributeRefusal(type) : undefined) ?? refuse?.(e);
          const hint = source === 'telemetry' && !e.numeric && PLOTS_NUMBERS.includes(type) ? 'No numeric reading lately' : undefined;
          const disabled = (refusal !== undefined && !checked) || (full && !checked);
          return (
            <label
              key={`${e.source}:${e.key}`}
              className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm ${checked ? 'border-[var(--theme-primary)] bg-slate-50' : 'border-slate-200'} ${disabled ? 'opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                className="ctl-check mt-0.5"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(e)}
                aria-label={`${e.label} (${e.key})`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="font-semibold text-slate-800">{e.label}</span>
                  <code className="text-xs text-slate-500">{e.key}</code>
                  {e.measurement && (
                    <span className="rounded bg-sky-50 px-1.5 text-[0.6875rem] font-semibold text-sky-800">
                      Measured · {e.measurement.name}
                    </span>
                  )}
                </span>
                <span className="block text-xs text-slate-500">
                  {source === 'attribute' ? 'attribute' : e.numeric ? 'number' : 'text'}
                  {' · '}{e.instruments} instrument{e.instruments === 1 ? '' : 's'}
                  {e.lastSeen && <> · last seen {formatDateTime(e.lastSeen)}</>}
                </span>
                {refusal && <span className="block text-xs font-medium text-slate-600">{refusal}</span>}
                {hint && <span className="block text-xs font-medium text-amber-700">{hint}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
    );
  };

  return (
    <div className="space-y-3">
      <input
        type="search"
        name="widget-key-search"
        aria-label="Search keys"
        placeholder="Search keys"
        value={search}
        onChange={(ev) => setSearch(ev.target.value)}
        className="ctl ctl-sm w-full"
      />
      {full && <p className="text-xs text-amber-700">At most {keysMax} keys on one widget.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {group('Time series', 'telemetry')}
        {group('Attributes', 'attribute')}
      </div>
    </div>
  );
}
