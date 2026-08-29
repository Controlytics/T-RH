import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';

export interface RuleDraft {
  id?: string;
  name: string;
  targetKind: 'instrument' | 'location';
  targetId: string;
  metric: string;
  comparison: string;
  thresholdLow: number | null;
  thresholdHigh: number | null;
  delaySeconds: number;
  isActive: boolean;
}

interface InstrumentRow { id: string; code: string; name: string }
interface FlNode { id: string; name: string; type: string; children?: FlNode[] }

const METRICS = [
  { value: 'TEMPERATURE', label: 'Temperature' },
  { value: 'HUMIDITY', label: 'Humidity' },
  { value: 'OFFLINE', label: 'Stopped reporting' },
];

const COMPARISONS = [
  { value: 'ABOVE', label: 'Above' },
  { value: 'BELOW', label: 'Below' },
  { value: 'OUTSIDE_RANGE', label: 'Outside range' },
];

export const emptyDraft: RuleDraft = {
  name: '', targetKind: 'instrument', targetId: '',
  metric: 'TEMPERATURE', comparison: 'ABOVE',
  thresholdLow: null, thresholdHigh: null, delaySeconds: 0, isActive: true,
};

/**
 * Mirrors the server's validateRuleDraft so the operator is told what is wrong before
 * a round trip. The SERVER remains authoritative — this exists for the message, not
 * for the guarantee, and deliberately checks the same four things in the same order.
 */
export function draftError(d: RuleDraft): { field: string; message: string } | null {
  if (!d.name.trim()) return { field: 'name', message: 'Name is required.' };
  if (!d.targetId) return { field: 'targetId', message: 'Choose an instrument or a functional location.' };
  if (!Number.isInteger(d.delaySeconds) || d.delaySeconds < 0) {
    return { field: 'delaySeconds', message: 'Delay must be zero or a whole number of seconds.' };
  }
  if (d.metric === 'OFFLINE') {
    // A stopped-reporting rule has no value to compare, so a threshold would be stored
    // and then silently ignored.
    if (d.thresholdLow !== null || d.thresholdHigh !== null) {
      return { field: 'thresholdHigh', message: 'A stopped-reporting rule has no threshold.' };
    }
    return null;
  }
  const finite = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);
  if (d.comparison === 'ABOVE' && !finite(d.thresholdHigh)) {
    return { field: 'thresholdHigh', message: 'An "above" rule needs an upper threshold.' };
  }
  if (d.comparison === 'BELOW' && !finite(d.thresholdLow)) {
    return { field: 'thresholdLow', message: 'A "below" rule needs a lower threshold.' };
  }
  if (d.comparison === 'OUTSIDE_RANGE') {
    if (!finite(d.thresholdLow) || !finite(d.thresholdHigh)) {
      return { field: 'thresholdLow', message: 'An "outside range" rule needs both thresholds.' };
    }
    if (d.thresholdLow >= d.thresholdHigh) {
      return { field: 'thresholdLow', message: 'The lower threshold must be below the upper one.' };
    }
  }
  return null;
}

/** '' means "not set" — but 0 is a real threshold, so it must survive this. */
export function parseThreshold(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function RuleDialog({
  open, initial, onSubmit, onClose,
}: {
  open: boolean;
  initial?: RuleDraft;
  onSubmit: (draft: RuleDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(initial ?? emptyDraft);
  const [touched, setTouched] = useState(false);

  const { data: instrumentData } = useSWR<{ data: InstrumentRow[] }>(open ? '/api/instruments?limit=500' : null);
  const { data: flData } = useSWR<{ data: FlNode[] }>(open ? '/api/functional-locations' : null);

  useEffect(() => {
    if (open) { setDraft(initial ?? emptyDraft); setTouched(false); }
  }, [open, initial]);

  const instruments = useMemo(
    () => [...(instrumentData?.data ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [instrumentData],
  );

  // Blocks AND their Areas, flattened with a path, because a rule may target either.
  const locations = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    for (const b of flData?.data ?? []) {
      out.push({ id: b.id, label: b.name });
      for (const a of b.children ?? []) out.push({ id: a.id, label: `${b.name} > ${a.name}` });
    }
    return out;
  }, [flData]);

  if (!open) return null;

  const err = draftError(draft);
  const showErr = (field: string) => touched && err?.field === field;
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const needsLow = draft.metric !== 'OFFLINE' && (draft.comparison === 'BELOW' || draft.comparison === 'OUTSIDE_RANGE');
  const needsHigh = draft.metric !== 'OFFLINE' && (draft.comparison === 'ABOVE' || draft.comparison === 'OUTSIDE_RANGE');

  const field = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white shadow-[var(--elev-2)]">
        <div className="rounded-t-lg bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-3">
          <h2 className="text-base font-semibold text-white">{draft.id ? 'Edit Alarm Rule' : 'New Alarm Rule'}</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label htmlFor="rule-name" className="mb-1 block text-sm font-medium text-slate-700">Name</label>
            <input id="rule-name" className={field} value={draft.name} onChange={(e) => set('name', e.target.value)} />
            {showErr('name') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Applies to</span>
            <div className="seg mb-2">
              {(['instrument', 'location'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, targetKind: k, targetId: '' }))}
                  aria-pressed={draft.targetKind === k}
                  className="seg-btn"
                >
                  {k === 'instrument' ? 'One instrument' : 'A functional location'}
                </button>
              ))}
            </div>
            <select
              className={field}
              value={draft.targetId}
              onChange={(e) => set('targetId', e.target.value)}
            >
              <option value="">Select…</option>
              {draft.targetKind === 'instrument'
                ? instruments.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)
                : locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            {draft.targetKind === 'location' && (
              <p className="mt-1 text-xs text-slate-500">
                A Block covers its own instruments and those of its Areas.
              </p>
            )}
            {showErr('targetId') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rule-metric" className="mb-1 block text-sm font-medium text-slate-700">Metric</label>
              <select
                id="rule-metric"
                className={field}
                value={draft.metric}
                onChange={(e) => setDraft((d) => ({
                  ...d,
                  metric: e.target.value,
                  // Switching to OFFLINE clears thresholds, so a hidden field cannot
                  // submit a value the server would reject.
                  ...(e.target.value === 'OFFLINE' ? { thresholdLow: null, thresholdHigh: null } : {}),
                }))}
              >
                {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {draft.metric !== 'OFFLINE' && (
              <div>
                <label htmlFor="rule-comparison" className="mb-1 block text-sm font-medium text-slate-700">Condition</label>
                <select
                  id="rule-comparison"
                  className={field}
                  value={draft.comparison}
                  onChange={(e) => set('comparison', e.target.value)}
                >
                  {COMPARISONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            )}
          </div>

          {(needsLow || needsHigh) && (
            <div className="grid grid-cols-2 gap-3">
              {needsLow && (
                <div>
                  <label htmlFor="rule-low" className="mb-1 block text-sm font-medium text-slate-700">Lower threshold</label>
                  <input
                    id="rule-low" type="number" step="any" className={field}
                    value={draft.thresholdLow ?? ''}
                    onChange={(e) => set('thresholdLow', parseThreshold(e.target.value))}
                  />
                </div>
              )}
              {needsHigh && (
                <div>
                  <label htmlFor="rule-high" className="mb-1 block text-sm font-medium text-slate-700">Upper threshold</label>
                  <input
                    id="rule-high" type="number" step="any" className={field}
                    value={draft.thresholdHigh ?? ''}
                    onChange={(e) => set('thresholdHigh', parseThreshold(e.target.value))}
                  />
                </div>
              )}
            </div>
          )}
          {(showErr('thresholdLow') || showErr('thresholdHigh')) && (
            <p className="text-xs text-red-600">{err!.message}</p>
          )}

          <div>
            <label htmlFor="rule-delay" className="mb-1 block text-sm font-medium text-slate-700">
              Delay before raising (seconds)
            </label>
            <input
              id="rule-delay" type="number" min={0} step={1} className={field}
              value={draft.delaySeconds}
              onChange={(e) => set('delaySeconds', Math.trunc(Number(e.target.value) || 0))}
            />
            <p className="mt-1 text-xs text-slate-500">
              0 raises on the first breaching reading. A delay ignores brief excursions such as a door opening.
            </p>
            {showErr('delaySeconds') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
          </div>

          {draft.id && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => set('isActive', e.target.checked)}
                className="ctl-check"
              />
              Active
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setTouched(true); if (!err) onSubmit({ ...draft, name: draft.name.trim() }); }}>
            {draft.id ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}
