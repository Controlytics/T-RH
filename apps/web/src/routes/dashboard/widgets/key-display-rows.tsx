/**
 * Per-key display settings — label, colour, and for a RAW key its unit and
 * decimals. Shared by the dashboard's Add widget dialog and the trend page's
 * Keys dialog (phase 3), so the two cannot offer different settings for one
 * key. A measured key's unit and decimals are the server's and are not offered.
 */
import type { WidgetKey } from '@digilog/shared';
import { SERIES_COLORS } from '../time-series-chart';

/** Set one key's fields; an empty value removes the field rather than storing ''. */
export function patchKeys(keys: WidgetKey[], index: number, patch: Partial<WidgetKey>): WidgetKey[] {
  return keys.map((k, n) => {
    if (n !== index) return k;
    const next = { ...k, ...patch };
    for (const f of ['label', 'unit', 'decimals', 'color'] as const) {
      if (next[f] === undefined || next[f] === '') delete next[f];
    }
    return next;
  });
}

export function KeyDisplayRows({
  keys, measured, onChange, palette = SERIES_COLORS,
}: {
  keys: WidgetKey[];
  /** Whether the SERVER measures this key (the catalogue said so). */
  measured: (k: WidgetKey) => boolean;
  onChange: (keys: WidgetKey[]) => void;
  /**
   * The colours the swatches SHOW — what the widget will draw each slot in
   * (`keyPaletteFor`, ruling F-I6: a dashboard bar chart's slot 3 is not the
   * trend page's green). The trend page's Keys dialog passes nothing.
   */
  palette?: readonly string[];
}) {
  if (keys.length === 0) return null;
  const setKey = (index: number, patch: Partial<WidgetKey>) => onChange(patchKeys(keys, index, patch));
  return (
    <div className="space-y-2">
      {keys.map((k, n) => {
        const raw = !measured(k);
        return (
          <div key={`${k.source}:${k.key}`} className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 p-2 text-sm">
            <code className="self-center text-xs text-slate-500">{k.key}</code>
            <input
              aria-label={`Label for ${k.key}`}
              className="ctl ctl-sm"
              value={k.label ?? ''}
              maxLength={60}
              placeholder="Label"
              onChange={(e) => setKey(n, { label: e.target.value })}
            />
            {raw && (
              <input
                aria-label={`Unit for ${k.key}`}
                className="ctl ctl-sm w-24"
                value={k.unit ?? ''}
                maxLength={16}
                placeholder="Unit"
                onChange={(e) => setKey(n, { unit: e.target.value })}
              />
            )}
            {raw && k.source === 'telemetry' && (
              <input
                aria-label={`Decimals for ${k.key}`}
                type="number"
                min={0}
                max={6}
                className="ctl ctl-sm w-24"
                value={k.decimals ?? ''}
                placeholder="As sent"
                onChange={(e) => setKey(n, { decimals: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            )}
            {!raw && <span className="self-center text-xs text-slate-500">Unit and decimals are the instrument&apos;s</span>}
            <span className="flex items-center gap-1" role="group" aria-label={`Colour for ${k.key}`}>
              {palette.map((c, ci) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${ci + 1} for ${k.key}`}
                  aria-pressed={k.color === ci}
                  onClick={() => setKey(n, { color: k.color === ci ? undefined : ci })}
                  className={`h-5 w-5 rounded-full border ${k.color === ci ? 'ring-2 ring-slate-700 ring-offset-1' : 'border-slate-300'}`}
                  style={{ background: c }}
                />
              ))}
            </span>
            {/* The picker lists only the keys the chosen instruments sent; a chosen key
                nobody sends any more is still here, and this is its only way out. */}
            <button
              type="button"
              aria-label={`Remove ${k.key}`}
              title="Remove"
              onClick={() => onChange(keys.filter((_, i) => i !== n))}
              className="ml-auto self-center rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-red-600"
            >
              Remove
            </button>
          </div>
        );
      })}
    </div>
  );
}
