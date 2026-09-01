import { useEffect, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Pencil } from 'lucide-react';
import {
  TREND_WIDGET_FIELDS, TREND_WIDGET_LABEL_DEFAULT, TREND_WIDGET_LABEL_MAX,
  TREND_WIDGET_FIELD_LABEL,
  TREND_WIDGET_DATE_FORMATS, TREND_WIDGET_TIME_FORMATS, TREND_WIDGET_FORMAT_INHERIT,
  trendWidgetDateFormatKey, trendWidgetTimeFormatKey,
  type TrendWidgetId, type TrendWidgetLabelKey,
} from '@digilog/shared';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { TREND_WIDGETS_KEY, TREND_WIDGETS_RAW_KEY } from '@/hooks/use-trend-widgets';

/**
 * The pencil in a trend-page widget's header — rename its title and its column
 * headings, and choose how it prints a date and a time.
 *
 * **SUPER_ADMIN only, and it renders NOTHING for anyone else.** The check is
 * `user?.role === 'SUPER_ADMIN'`, the same one `routes/config/index.tsx` makes,
 * not a new one and not `useCan` — this is not a permission-tree node, it is the
 * same role gate the def itself carries (`requiredRole: 'SUPER_ADMIN'`), so the
 * button and the route it writes to are gated by one rule rather than two that
 * can drift. Hiding it is presentation; the SERVER refusing a non-admin's PUT is
 * the actual control.
 *
 * **The dialog edits the RAW stored row, not the resolved one.** It prefills from
 * `GET /api/config/dynamic/trend-widgets` (SUPER_ADMIN-only, which is fine — only
 * a SUPER_ADMIN can see the button) so an empty field stays empty and keeps
 * meaning "use the shipped wording". Prefilling from the RESOLVED payload would
 * write the defaults into the row the first time anyone pressed Save, and the
 * blank-falls-back rule would quietly stop being reachable.
 *
 * **It PUTs the WHOLE row, merged.** The dynamic config route REPLACES
 * `configValue` with the request body — it does not patch it — so a PUT of one
 * widget's fields alone would erase the other five. The merge is the reason this
 * component reads before it writes.
 *
 * **No re-auth**, matching the def and every other display-wording def
 * (`alarm-type-names`, `rs485-alarms`, `sensor-range-alarms`): the dynamic PUT
 * route demands a signature only when the def sets `requiresReauth` or a
 * `reauthAction`, and this one sets neither. `apiClient.put` is therefore correct
 * here and `putWithReauth` would be a signature the server never asked for.
 */
export function WidgetSettingsButton({ widget }: { widget: TrendWidgetId }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  // Rendered for nobody else. The dialog and its SWR read are inside the
  // component that follows, so a non-admin does not even request the raw row.
  if (user?.role !== 'SUPER_ADMIN') return null;

  const name = TREND_WIDGET_FIELDS[widget].name;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Edit ${name} labels`}
        title={`Edit ${name} labels`}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && <WidgetSettingsDialog widget={widget} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The form itself, mounted only while open so it fetches the raw row on demand
 * rather than on every trend page load.
 */
function WidgetSettingsDialog({ widget, onClose }: { widget: TrendWidgetId; onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const { toast } = useToast();
  const field = TREND_WIDGET_FIELDS[widget];

  const { data: stored, isLoading } = useSWR<Record<string, unknown>>(TREND_WIDGETS_RAW_KEY, {
    revalidateOnFocus: false,
  });

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const dateKey = trendWidgetDateFormatKey(widget);
  const timeKey = trendWidgetTimeFormatKey(widget);

  // Fill the form once the row arrives. A field absent from the row stays an
  // EMPTY STRING, never the shipped wording — the placeholder shows that, and
  // saving an untouched dialog must not turn "unset" into "explicitly set to the
  // default".
  useEffect(() => {
    if (!stored) return;
    const next: Record<string, string> = {};
    for (const key of field.labelKeys) next[key] = asString(stored[key]);
    next[dateKey] = asFormat(stored[dateKey]);
    next[timeKey] = asFormat(stored[timeKey]);
    setDraft(next);
  }, [stored, widget]);

  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    if (!stored) return;
    setSaving(true);
    setError('');
    try {
      // MERGE. The route replaces the whole row, so the other five widgets'
      // fields have to travel with this one's.
      await apiClient.put(TREND_WIDGETS_RAW_KEY, { ...stored, ...draft });
      // BOTH keys. The first is what the page renders from; the second is what
      // this dialog prefills from, and leaving it stale would reopen the form
      // showing the values that were just replaced.
      await Promise.all([mutate(TREND_WIDGETS_KEY), mutate(TREND_WIDGETS_RAW_KEY)]);
      toast.success('Saved', `${field.name} labels updated.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save these labels.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{field.name}</DialogTitle>
        <p className="mt-1.5 text-sm text-slate-500">
          What this widget is called, and how it prints dates and times. Leave a field blank to use
          the wording the product ships with.
        </p>
      </DialogHeader>

      {isLoading && !stored ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          {field.labelKeys.map((key) => (
            <LabelField
              key={key}
              labelKey={key}
              value={draft[key] ?? ''}
              onChange={(v) => set(key, v)}
            />
          ))}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormatField
              id={`trend-widget-${widget}-date`}
              label="Date format"
              value={draft[dateKey] ?? TREND_WIDGET_FORMAT_INHERIT}
              options={TREND_WIDGET_DATE_FORMATS}
              onChange={(v) => set(dateKey, v)}
            />
            <FormatField
              id={`trend-widget-${widget}-time`}
              label="Time format"
              value={draft[timeKey] ?? TREND_WIDGET_FORMAT_INHERIT}
              options={TREND_WIDGET_TIME_FORMATS}
              onChange={(v) => set(timeKey, v)}
            />
          </div>
          {/* Said once, under both controls: the timezone is not on offer here
              and this is where somebody looks for it. */}
          <p className="text-xs text-slate-500">
            Inherit uses the site-wide Date/Time Format setting. The timezone is always the
            site-wide one and is not set per widget.
          </p>

          {error && <p className="text-sm font-medium text-rose-600">{error}</p>}
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving || !stored}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * One renameable piece of wording.
 *
 * The LABEL names the field ("Alarm state column heading"); the PLACEHOLDER is
 * the shipped value, so a blank box visibly says what leaving it blank produces.
 * Both come from `@digilog/shared`, the same two maps the config page's def is
 * built from — this dialog and `/config/dynamic/trend-widgets` edit the same
 * fields and must not name them differently.
 */
function LabelField({
  labelKey, value, onChange,
}: { labelKey: TrendWidgetLabelKey; value: string; onChange: (v: string) => void }) {
  const shipped = TREND_WIDGET_LABEL_DEFAULT[labelKey];
  const id = `trend-widget-${labelKey}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {TREND_WIDGET_FIELD_LABEL[labelKey]}
      </label>
      <Input
        id={id}
        value={value}
        placeholder={shipped}
        maxLength={TREND_WIDGET_LABEL_MAX}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FormatField({
  id, label, value, options, onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={TREND_WIDGET_FORMAT_INHERIT}>Inherit</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    </div>
  );
}

const asString = (v: unknown) => (typeof v === 'string' ? v : '');

/** A stored format, or the inherit sentinel — so the select always has a
 *  matching option and never falls back to its first entry silently. */
const asFormat = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim() : TREND_WIDGET_FORMAT_INHERIT;
