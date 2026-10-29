import { useEffect, useState } from 'react';
import {
  DEFAULT_PERIOD, PERIOD_PRESETS, dashboardTimeWindowSchema, type DashboardTimeWindow,
} from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { isoToZonedInput, zonedInputToIso } from '@/lib/zoned-input';
import { cn } from '@/lib/cn';

/**
 * A built dashboard's time window, as ONE row of chips (concept C, ruling R6):
 * the `PERIOD_PRESETS` by their short value (`15m` … `30d`, each titled with
 * its label, "Last 15 minutes"), then Custom, which opens a from / to editor.
 *
 * Drawn for the dashboard header's band (white ink on the theme gradient).
 *
 * The custom range is typed in the CONFIGURED timezone and sent as instants —
 * the `localInputToIso` rule of the Alarms page, whose one conversion is
 * `zonedInputToIso`. It is checked by the SAME shared schema the server
 * applies, so an end before (or at) its start is refused here, in place, with
 * the schema's own words, and nothing is changed.
 */
export function TimeWindowPicker({ value, onChange, tone = 'band' }: {
  value: DashboardTimeWindow;
  onChange: (v: DashboardTimeWindow) => void;
  /** `band` (default) is white ink on the theme band; `light` is for a white dialog body. */
  tone?: 'band' | 'light';
}) {
  const { formatDateTime, config } = useDatetimeFormat();
  const tz = config?.timezone;
  const [editor, setEditor] = useState<{ from: string; to: string; problem: string | null } | null>(null);

  const light = tone === 'light';
  // Escape closes the custom editor, as it closes a dialog. Not in a dialog's
  // own body: there Escape belongs to the dialog.
  useEffect(() => {
    if (!editor || light) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditor(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, light]);

  const openCustom = () => {
    if (editor) { setEditor(null); return; }
    // Seed with the window on screen: a fixed one as stored, a relative one as
    // the range it covers right now.
    if (value.mode === 'fixed') {
      setEditor({ from: isoToZonedInput(value.from, tz), to: isoToZonedInput(value.to, tz), problem: null });
      return;
    }
    const ms = (PERIOD_PRESETS.find((p) => p.value === value.period)
      ?? PERIOD_PRESETS.find((p) => p.value === DEFAULT_PERIOD)!).ms;
    const now = Date.now();
    setEditor({
      from: isoToZonedInput(new Date(now - ms).toISOString(), tz),
      to: isoToZonedInput(new Date(now).toISOString(), tz),
      problem: null,
    });
  };

  const apply = () => {
    if (!editor) return;
    const from = zonedInputToIso(editor.from, tz);
    const to = zonedInputToIso(editor.to, tz);
    if (!from || !to) {
      setEditor({ ...editor, problem: 'Enter both a start and an end.' });
      return;
    }
    const parsed = dashboardTimeWindowSchema.safeParse({ mode: 'fixed', from, to });
    if (!parsed.success) {
      setEditor({ ...editor, problem: parsed.error.issues[0]?.message ?? 'This is not a time window.' });
      return;
    }
    onChange(parsed.data);
    setEditor(null);
  };

  const chip = (pressed: boolean) => cn(
    'rounded-[5px] px-2.5 py-1 text-[0.75rem] transition-colors duration-150',
    light
      ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-primary,#2a78d6)]'
      : 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80',
    light
      ? (pressed
        ? 'bg-[var(--theme-primary,#2a78d6)] font-bold text-white shadow-[var(--elev-1)]'
        : 'font-semibold text-slate-700 hover:bg-white')
      : (pressed
        ? 'bg-white font-bold text-[var(--theme-primary-dark,#1e3a5f)] shadow-[var(--elev-1)]'
        : 'font-semibold text-white/85 hover:bg-white/15 hover:text-white'),
  );
  const fixed = value.mode === 'fixed';

  return (
    <div className={light ? undefined : 'relative'}>
      <div
        role="group"
        aria-label="Time window"
        className={cn(
          'inline-flex flex-wrap items-center rounded-[var(--radius-control)] p-0.5 ring-1 ring-inset',
          light ? 'bg-slate-100 ring-slate-200' : 'bg-white/12 ring-white/25',
        )}
      >
        {PERIOD_PRESETS.map((p) => {
          const pressed = value.mode === 'relative' && value.period === p.value;
          return (
            <button
              key={p.value}
              type="button"
              title={p.label}
              aria-pressed={pressed}
              onClick={() => { setEditor(null); onChange({ mode: 'relative', period: p.value }); }}
              className={chip(pressed)}
            >
              {p.value}
            </button>
          );
        })}
        <button
          type="button"
          title={fixed ? `${formatDateTime(value.from)} – ${formatDateTime(value.to)}` : 'Custom range…'}
          aria-pressed={fixed}
          aria-expanded={editor !== null}
          onClick={openCustom}
          className={cn(chip(fixed), 'whitespace-nowrap')}
        >
          {fixed ? `${formatDateTime(value.from)} – ${formatDateTime(value.to)}` : 'Custom'}
        </button>
      </div>

      {editor && (
        <div
          role="group"
          aria-label="Custom range"
          className={cn(
            'mt-2 w-[20rem] max-w-full space-y-3 rounded-[var(--radius-card)] bg-white p-4 text-left text-slate-700 ring-1 ring-slate-200',
            // On the band it is a popup; in a dialog body it is IN FLOW, because
            // a form section clips whatever floats out of it.
            light ? 'border border-slate-200' : 'absolute right-0 top-full z-30 shadow-[var(--elev-3)]',
          )}
        >
          <label className="block text-[0.8125rem] font-semibold text-slate-700">
            From
            <input
              type="datetime-local"
              name="dashboard-window-from"
              value={editor.from}
              onChange={(e) => setEditor({ ...editor, from: e.target.value, problem: null })}
              className="ctl mt-1 w-full"
            />
          </label>
          <label className="block text-[0.8125rem] font-semibold text-slate-700">
            To
            <input
              type="datetime-local"
              name="dashboard-window-to"
              value={editor.to}
              onChange={(e) => setEditor({ ...editor, to: e.target.value, problem: null })}
              className="ctl mt-1 w-full"
            />
          </label>
          {editor.problem && (
            <p role="alert" className="text-[0.8125rem] font-medium text-red-700">{editor.problem}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditor(null)}>Cancel</Button>
            <Button type="button" size="sm" onClick={apply}>Apply</Button>
          </div>
        </div>
      )}
    </div>
  );
}
