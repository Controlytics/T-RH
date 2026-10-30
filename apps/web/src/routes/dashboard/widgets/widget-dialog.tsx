/**
 * Add / Edit a built dashboard widget (SUPER_ADMIN, in Arrange mode).
 *
 * Four sections — type, instruments, keys, display — and a live preview drawn by
 * the real renderer from the real routes. The widget it submits is validated by
 * the SAME `customWidgetSchema` the layout routes enforce, so what the dialog
 * accepts is what the server will store; the first problem is shown instead of
 * a silent no-op.
 *
 * What each type takes is the shared registry's (`WIDGET_TYPE_SPECS`): the key
 * step shows only for a type that takes keys, capped at its `keysMax`; the
 * instruments step hides for the text card; the default period shows for a type
 * that follows the window. Switching type DROPS the keys and options the new
 * type refuses (`type-switch.ts`), so a save cannot 400 on a leftover. A type's
 * own options are edited by its section in `WIDGET_OPTION_SECTIONS`.
 */
import { useState, type ComponentType } from 'react';
import {
  PERIOD_PRESETS, WIDGET_ALARM_STATUSES, WIDGET_INSTRUMENTS_MAX, WIDGET_PAGE_SIZES, WIDGET_TYPE_SPECS, customWidgetSchema,
  type CustomWidget, type WidgetKey, type WidgetType,
} from '@digilog/shared';
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useHistoryScope } from '@/routes/data-report/use-history-scope';
import { KeyDisplayRows } from './key-display-rows';
import { KeyPicker } from './key-picker';
import { WIDGET_PAGE_SIZE_DEFAULT, keysForType, offeredOptions, optionsForType, type WidgetOptions } from './type-switch';
import { useKeyCatalogue, type CatalogueSelector, type WidgetSelection } from './use-widget-data';
import { WidgetBody } from './widget-panel';

/** In `WIDGET_TYPES` order: the picker lists every type the registry has. */
const TYPES: { type: WidgetType; label: string; blurb: string }[] = [
  { type: 'value_cards', label: 'Value cards', blurb: 'The latest value of each key, one card per instrument' },
  { type: 'latest_table', label: 'Latest values table', blurb: 'A row per instrument, a column per key' },
  { type: 'trend_chart', label: 'Trend chart', blurb: 'Each key plotted over a period' },
  { type: 'timeseries_table', label: 'Time series table', blurb: 'Every stored reading, newest first' },
  { type: 'alarm_table', label: 'Alarm table', blurb: 'Open and recent alarms of these instruments, with acknowledge' },
  { type: 'gauge', label: 'Gauge', blurb: 'The latest value of each key on a dial' },
  { type: 'bar_chart', label: 'Bar chart', blurb: 'Each key per hour, day or week over a period' },
  { type: 'comparison_bar', label: 'Comparison bars', blurb: 'The latest value of each key, instrument beside instrument' },
  { type: 'pie_chart', label: 'Pie chart', blurb: 'Instruments by status, or active alarms by type' },
  { type: 'alarm_counts', label: 'Alarm counts', blurb: 'How many alarms are active and unacknowledged, by type' },
  { type: 'status_grid', label: 'Status grid', blurb: 'One tile per instrument, in its status colour' },
  { type: 'instrument_list', label: 'Instrument list', blurb: 'Each instrument with its area, location, status and last report' },
  { type: 'text_card', label: 'Text card', blurb: 'A note in your own words' },
  { type: 'floorplan', label: 'Floor plan', blurb: 'A drawn floor plan with its live readings' },
];

/** What a type's option section is given. */
export interface WidgetOptionSectionProps {
  /** The widget's id: every text input's `name` carries it, so each is distinct. */
  widgetId: string;
  /** Every option the dialog holds; the section reads its own. */
  options: WidgetOptions;
  /** Merge these into the options; an `undefined` value removes that option. */
  onChange: (patch: Partial<WidgetOptions>) => void;
}

/**
 * The words the SHARED schema says about a gauge's scale, per end — asked of
 * `customWidgetSchema` itself on a gauge holding only this scale, so the dialog
 * repeats the server's own wording and never a second copy of its rule.
 */
function gaugeScaleProblems(widgetId: string, min: number | undefined, max: number | undefined): { min?: string; max?: string } {
  const parsed = customWidgetSchema.safeParse({
    id: widgetId, type: 'gauge', title: 'Scale', source: { mode: 'selection' },
    keys: [{ source: 'telemetry', key: 'scale' }], options: { min, max },
  });
  const out: { min?: string; max?: string } = {};
  if (parsed.success) return out;
  for (const issue of parsed.error.issues) {
    const end = issue.path[1];
    if (issue.path[0] === 'options' && (end === 'min' || end === 'max') && out[end] === undefined) out[end] = issue.message;
  }
  return out;
}

/**
 * The gauge's scale for a key the server does not judge (a measured key draws its
 * own limits). Both or neither, the minimum below the maximum — said under the
 * field at fault, in the schema's words, as it is typed.
 */
function GaugeScaleSection({ widgetId, options, onChange }: WidgetOptionSectionProps) {
  // The typed TEXT is kept here: a number input mid-entry ("-", "0.") is not yet
  // a number, and round-tripping it through the option would wipe it.
  const [typed, setTyped] = useState({ min: options.min?.toString() ?? '', max: options.max?.toString() ?? '' });
  const problems = gaugeScaleProblems(widgetId, options.min, options.max);
  const field = (end: 'min' | 'max', label: string) => {
    const id = `widget-gauge-${end}-${widgetId}`;
    const problem = problems[end];
    return (
      <div className="text-sm">
        <label htmlFor={id} className="mb-1 block font-medium text-slate-700">{label}</label>
        <input
          id={id}
          name={id}
          type="number"
          step="any"
          inputMode="decimal"
          className="ctl ctl-sm w-36"
          value={typed[end]}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => {
            const text = e.target.value;
            setTyped((t) => ({ ...t, [end]: text }));
            onChange({ [end]: text.trim() === '' ? undefined : Number(text) });
          }}
        />
        {problem && <p id={`${id}-problem`} className="mt-1 text-xs font-medium text-red-700">{problem}</p>}
      </div>
    );
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-slate-800">Scale for keys the server does not judge</legend>
      <div className="flex flex-wrap items-start gap-4">
        {field('min', 'Scale minimum')}
        {field('max', 'Scale maximum')}
      </div>
    </fieldset>
  );
}

/**
 * A type's own option controls, drawn in the Display step. Each widget type's
 * task registers its section here (gauge scale; later bar bucket / value /
 * grouping, pie subject, text, floor plan). Only the options the type is offered
 * are saved, whatever a section sets.
 */
export const WIDGET_OPTION_SECTIONS: Partial<Record<WidgetType, ComponentType<WidgetOptionSectionProps>>> = {
  gauge: GaugeScaleSection,
};

/** Options with every `undefined` left out, so a cleared option is gone, not present-and-empty. */
const prune = (o: WidgetOptions): WidgetOptions =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as WidgetOptions;

const STATUS_LABEL: Record<(typeof WIDGET_ALARM_STATUSES)[number], string> = {
  'active-unack': 'Active Unacknowledged',
  'active-ack': 'Active Acknowledged',
  'cleared-unack': 'Cleared Unacknowledged',
  'cleared-ack': 'Cleared Acknowledged',
};

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)));

export function WidgetDialog({
  open, initial, selection, onCancel, onSubmit, followLabel = 'Follow the dashboard selection',
  periodFollowLabel = 'Site default',
}: {
  open: boolean;
  initial?: CustomWidget;
  selection: WidgetSelection;
  onCancel: () => void;
  onSubmit: (w: CustomWidget) => void;
  /** What the follow radio says; a dashboard page says what it follows. */
  followLabel?: string;
  /** What "no default period" means here: the site's period on `/`, the dashboard's window on a built one. */
  periodFollowLabel?: string;
}) {
  const [id] = useState(() => initial?.id ?? newId());
  const [type, setType] = useState<WidgetType>(initial?.type ?? 'value_cards');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [mode, setMode] = useState<'selection' | 'instruments'>(initial?.source.mode ?? 'selection');
  const [picked, setPicked] = useState<string[]>(initial?.source.mode === 'instruments' ? initial.source.ids : []);
  const [keys, setKeys] = useState<WidgetKey[]>(initial?.keys ?? []);
  // ONE options state for every type: the phase 1 selects and the registered
  // sections all read and write it, and only the type's offered options are saved.
  const [options, setOptions] = useState<WidgetOptions>(initial?.options ?? {});
  const [problem, setProblem] = useState<string | null>(null);
  const scope = useHistoryScope();

  const spec = WIDGET_TYPE_SPECS[type];
  const takesKeys = spec.keys !== 'none';
  // A text card shows no instruments: it is stored following the selection.
  const takesSource = type !== 'text_card';
  const offered = offeredOptions(type);
  const OptionSection = WIDGET_OPTION_SECTIONS[type];

  const patchOptions = (patch: Partial<WidgetOptions>) => setOptions((o) => prune({ ...o, ...patch }));
  // On a CLICK, never in an effect: an effect on `type` would also run when an
  // existing widget opens and strip what it was saved with.
  const changeType = (next: WidgetType) => {
    setType(next);
    setKeys((ks) => keysForType(next, ks));
    setOptions((o) => optionsForType(next, o));
  };

  const selector: CatalogueSelector = mode === 'instruments'
    ? (picked.length > 0 ? { instrumentIds: picked } : null)
    : selection.instrumentIds
      ? (selection.instrumentIds.length > 0 ? { instrumentIds: selection.instrumentIds } : null)
      : selection.profileId
        ? { profileId: selection.profileId }
        : selection.functionalLocationId
          ? { functionalLocationId: selection.functionalLocationId, directOnly: selection.directOnly }
          : { all: true };
  // A type that takes no keys asks for no catalogue.
  const { keys: catalogue, loading: catalogueLoading } = useKeyCatalogue(takesKeys ? selector : null);
  const measured = (k: WidgetKey) =>
    catalogue.some((e) => e.source === k.source && e.key === k.key && e.measurement !== null);

  const draft = {
    id,
    type,
    title,
    source: !takesSource || mode === 'selection'
      ? { mode: 'selection' as const }
      : { mode: 'instruments' as const, ids: picked },
    keys: keysForType(type, keys),
    options: optionsForType(type, options),
  };
  const parsed = customWidgetSchema.safeParse(draft);

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
                onClick={() => changeType(t.type)}
                className={`rounded-[var(--radius-card)] border p-3 text-left ${type === t.type ? 'border-[var(--theme-primary)] bg-slate-50 ring-1 ring-[var(--theme-primary)]' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <span className="block text-sm font-bold text-slate-800">{t.label}</span>
                <span className="block text-xs text-slate-500">{t.blurb}</span>
              </button>
            ))}
          </div>
        </section>

        {takesSource && (
        <section aria-label="Instruments" className="space-y-2">
          <h3 className="text-sm font-bold text-slate-800">2. Instruments</h3>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" className="ctl-radio" name={`widget-source-${id}`} checked={mode === 'selection'} onChange={() => setMode('selection')} />
              {followLabel}
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
        )}

        {takesKeys && (
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
        )}

        <section aria-label="Display" className="space-y-3">
          <h3 className="text-sm font-bold text-slate-800">4. Display</h3>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Title</span>
            <input className="ctl w-full max-w-md" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-4">
            {offered.includes('status') && (
              <label className="text-sm">
                <span className="mb-1 block font-medium text-slate-700">Status</span>
                <select
                  aria-label="Status"
                  className="ctl ctl-sm"
                  value={options.status ?? ''}
                  onChange={(e) => patchOptions({ status: (e.target.value || undefined) as WidgetOptions['status'] })}
                >
                  <option value="">All statuses</option>
                  {WIDGET_ALARM_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </label>
            )}
            {offered.includes('period') && (
              <label className="text-sm">
                <span className="mb-1 block font-medium text-slate-700">Default period</span>
                <select aria-label="Default period" className="ctl ctl-sm" value={options.period ?? ''} onChange={(e) => patchOptions({ period: e.target.value || undefined })}>
                  <option value="">{periodFollowLabel}</option>
                  {PERIOD_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
            )}
            {offered.includes('pageSize') && (
              <label className="text-sm">
                <span className="mb-1 block font-medium text-slate-700">Rows per page</span>
                <select
                  aria-label="Rows per page"
                  className="ctl ctl-sm"
                  value={options.pageSize ?? ''}
                  onChange={(e) => patchOptions({ pageSize: e.target.value ? Number(e.target.value) as WidgetOptions['pageSize'] : undefined })}
                >
                  <option value="">{WIDGET_PAGE_SIZE_DEFAULT[type]}</option>
                  {WIDGET_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
          </div>
          {OptionSection && <OptionSection widgetId={id} options={options} onChange={patchOptions} />}
          {takesKeys && <KeyDisplayRows keys={keys} measured={measured} onChange={setKeys} />}
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
