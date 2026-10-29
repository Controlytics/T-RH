/**
 * Add / Edit a built dashboard widget (SUPER_ADMIN, in Arrange mode).
 *
 * Four sections — type, instruments, keys, display — and a live preview drawn by
 * the real renderer from the real routes. The widget it submits is validated by
 * the SAME `customWidgetSchema` the layout routes enforce, so what the dialog
 * accepts is what the server will store; the first problem is shown instead of
 * a silent no-op.
 */
import { useState } from 'react';
import {
  PERIOD_PRESETS, WIDGET_INSTRUMENTS_MAX, WIDGET_PAGE_SIZES, customWidgetSchema,
  type CustomWidget, type WidgetKey, type WidgetType,
} from '@digilog/shared';
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useHistoryScope } from '@/routes/data-report/use-history-scope';
import { SERIES_COLORS } from '../time-series-chart';
import { KeyPicker } from './key-picker';
import { useKeyCatalogue, type CatalogueSelector, type WidgetSelection } from './use-widget-data';
import { WidgetBody } from './widget-panel';

const TYPES: { type: WidgetType; label: string; blurb: string }[] = [
  { type: 'value_cards', label: 'Value cards', blurb: 'The latest value of each key, one card per instrument' },
  { type: 'latest_table', label: 'Latest values table', blurb: 'A row per instrument, a column per key' },
  { type: 'trend_chart', label: 'Trend chart', blurb: 'Each key plotted over a period' },
  { type: 'timeseries_table', label: 'Time series table', blurb: 'Every stored reading, newest first' },
];

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)));

export function WidgetDialog({
  open, initial, selection, onCancel, onSubmit,
}: {
  open: boolean;
  initial?: CustomWidget;
  selection: WidgetSelection;
  onCancel: () => void;
  onSubmit: (w: CustomWidget) => void;
}) {
  const [id] = useState(() => initial?.id ?? newId());
  const [type, setType] = useState<WidgetType>(initial?.type ?? 'value_cards');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [mode, setMode] = useState<'selection' | 'instruments'>(initial?.source.mode ?? 'selection');
  const [picked, setPicked] = useState<string[]>(initial?.source.mode === 'instruments' ? initial.source.ids : []);
  const [keys, setKeys] = useState<WidgetKey[]>(initial?.keys ?? []);
  const [period, setPeriod] = useState<string | undefined>(initial?.options.period);
  const [pageSize, setPageSize] = useState<number | undefined>(initial?.options.pageSize);
  const [problem, setProblem] = useState<string | null>(null);
  const scope = useHistoryScope();

  const selector: CatalogueSelector = mode === 'instruments'
    ? (picked.length > 0 ? { instrumentIds: picked } : null)
    : selection.functionalLocationId
      ? { functionalLocationId: selection.functionalLocationId, directOnly: selection.directOnly }
      : { all: true };
  const { keys: catalogue, loading: catalogueLoading } = useKeyCatalogue(selector);
  const measured = (k: WidgetKey) =>
    catalogue.some((e) => e.source === k.source && e.key === k.key && e.measurement !== null);

  const history = type === 'trend_chart' || type === 'timeseries_table';
  const table = type === 'latest_table' || type === 'timeseries_table';
  const draft = {
    id,
    type,
    title,
    source: mode === 'selection' ? { mode: 'selection' as const } : { mode: 'instruments' as const, ids: picked },
    keys,
    options: {
      ...(history && period ? { period } : {}),
      ...(table && pageSize ? { pageSize } : {}),
    },
  };
  const parsed = customWidgetSchema.safeParse(draft);

  const setKey = (index: number, patch: Partial<WidgetKey>) => {
    setKeys(keys.map((k, n) => {
      if (n !== index) return k;
      const next = { ...k, ...patch };
      for (const f of ['label', 'unit', 'decimals', 'color'] as const) {
        if (next[f] === undefined || next[f] === '') delete next[f];
      }
      return next;
    }));
  };

  const submit = () => {
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'This widget is not complete.');
      return;
    }
    onSubmit(parsed.data);
  };

  const togglePicked = (iid: string) => setPicked((p) => (p.includes(iid)
    ? p.filter((x) => x !== iid)
    : p.length >= WIDGET_INSTRUMENTS_MAX ? p : [...p, iid]));

  return (
    <Dialog open={open} onClose={onCancel} className="max-w-5xl">
      <DialogHeader>
        <DialogTitle>{initial ? 'Edit widget' : 'Add widget'}</DialogTitle>
      </DialogHeader>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        <section aria-label="Type" className="space-y-2">
          <h3 className="text-sm font-bold text-slate-800">1. Type</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                aria-pressed={type === t.type}
                onClick={() => setType(t.type)}
                className={`rounded-[var(--radius-card)] border p-3 text-left ${type === t.type ? 'border-[var(--theme-primary)] bg-slate-50 ring-1 ring-[var(--theme-primary)]' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <span className="block text-sm font-bold text-slate-800">{t.label}</span>
                <span className="block text-xs text-slate-500">{t.blurb}</span>
              </button>
            ))}
          </div>
        </section>

        <section aria-label="Instruments" className="space-y-2">
          <h3 className="text-sm font-bold text-slate-800">2. Instruments</h3>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" className="ctl-radio" name={`widget-source-${id}`} checked={mode === 'selection'} onChange={() => setMode('selection')} />
              Follow the dashboard selection
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" className="ctl-radio" name={`widget-source-${id}`} checked={mode === 'instruments'} onChange={() => setMode('instruments')} />
              Pick instruments
            </label>
          </div>
          {mode === 'instruments' && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <div className="flex flex-wrap gap-2">
                <select aria-label="Block" className="ctl ctl-sm" value={scope.blockId} onChange={(e) => scope.setBlock(e.target.value)}>
                  <option value="">All blocks</option>
                  {scope.tree.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <select aria-label="Area" className="ctl ctl-sm" value={scope.areaId} disabled={!scope.blockId} onChange={(e) => scope.setArea(e.target.value)}>
                  <option value="">All areas</option>
                  {scope.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <span className="self-center text-xs text-slate-500">
                  {picked.length} picked (at most {WIDGET_INSTRUMENTS_MAX})
                </span>
              </div>
              <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                {scope.inScope.map((i) => (
                  <label key={i.id} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      className="ctl-check"
                      checked={picked.includes(i.id)}
                      onChange={() => togglePicked(i.id)}
                      aria-label={i.code}
                    />
                    {i.code}
                  </label>
                ))}
              </div>
            </div>
          )}
        </section>

        <section aria-label="Keys" className="space-y-2">
          <h3 className="text-sm font-bold text-slate-800">3. Keys</h3>
          {selector === null ? (
            <p className="text-xs text-slate-500">Pick at least one instrument to see its keys.</p>
          ) : catalogueLoading && catalogue.length === 0 ? (
            <p className="text-xs text-slate-500">Loading keys…</p>
          ) : (
            <KeyPicker catalogue={catalogue} chosen={keys} onChange={setKeys} type={type} />
          )}
        </section>

        <section aria-label="Display" className="space-y-3">
          <h3 className="text-sm font-bold text-slate-800">4. Display</h3>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Title</span>
            <input className="ctl w-full max-w-md" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-4">
            {history && (
              <label className="text-sm">
                <span className="mb-1 block font-medium text-slate-700">Default period</span>
                <select aria-label="Default period" className="ctl ctl-sm" value={period ?? ''} onChange={(e) => setPeriod(e.target.value || undefined)}>
                  <option value="">Site default</option>
                  {PERIOD_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
            )}
            {table && (
              <label className="text-sm">
                <span className="mb-1 block font-medium text-slate-700">Rows per page</span>
                <select aria-label="Rows per page" className="ctl ctl-sm" value={pageSize ?? ''} onChange={(e) => setPageSize(e.target.value ? Number(e.target.value) : undefined)}>
                  <option value="">25</option>
                  {WIDGET_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
          </div>
          {keys.length > 0 && (
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
                      {SERIES_COLORS.map((c, ci) => (
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
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section aria-label="Preview" className="space-y-2">
          <h3 className="text-sm font-bold text-slate-800">Preview</h3>
          <div className="rounded-[var(--radius-card)] border border-dashed border-slate-300 p-3">
            {parsed.success
              ? <WidgetBody widget={parsed.data} selection={selection} />
              : <p className="text-xs text-slate-500">Choose a type, instruments, at least one key and a title to see a preview.</p>}
          </div>
        </section>
      </div>
      {problem && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{problem}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={submit}>{initial ? 'Save widget' : 'Add widget'}</Button>
      </DialogFooter>
    </Dialog>
  );
}
