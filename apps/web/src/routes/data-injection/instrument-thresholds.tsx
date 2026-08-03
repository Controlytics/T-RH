import { useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import {
  OPERATOR_LABELS, SEVERITY_LABELS, SEVERITY_ORDER, describeThreshold, formatNumber,
  type AlarmSeverity, type ThresholdOperator, type ThresholdRow,
} from './alarm-shared';

const OPERATORS: ThresholdOperator[] = ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ', 'OUT_OF_RANGE'];

interface FormState {
  key: string;
  operator: ThresholdOperator;
  limit: string;
  limitLow: string;
  limitHigh: string;
  hysteresis: string;
  severity: AlarmSeverity;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  key: '', operator: 'GT', limit: '', limitLow: '', limitHigh: '',
  hysteresis: '0', severity: 'MAJOR', isActive: true,
};

function toForm(t: ThresholdRow): FormState {
  return {
    key: t.key,
    operator: t.operator,
    limit: t.limit === null ? '' : String(t.limit),
    limitLow: t.limitLow === null ? '' : String(t.limitLow),
    limitHigh: t.limitHigh === null ? '' : String(t.limitHigh),
    hysteresis: String(t.hysteresis),
    severity: t.severity,
    isActive: t.isActive,
  };
}

/** Parses a numeric field; '' means "not supplied". */
function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mirrors validateThreshold() in apps/api/src/modules/alarms/routes.ts. The
 * server is still the authority — this only turns a round-trip 400 into an
 * inline message. Any rule added there must be added here too, or the operator
 * gets a bare toast instead of a field-level explanation.
 */
function validate(f: FormState): string | null {
  if (f.key.trim() === '') return 'A measurement key is required.';
  const h = num(f.hysteresis) ?? 0;
  if (h < 0) return 'Hysteresis cannot be negative.';
  if (f.operator === 'OUT_OF_RANGE') {
    const lo = num(f.limitLow);
    const hi = num(f.limitHigh);
    if (lo === null || hi === null) return 'Outside range requires both a low and a high limit.';
    if (lo >= hi) return 'The low limit must be less than the high limit.';
    if (2 * h >= hi - lo) {
      return 'Hysteresis is too wide for this range — the alarm could never recover. '
        + 'Require 2 × hysteresis < (high − low).';
    }
  } else if (num(f.limit) === null) {
    return `Operator "${OPERATOR_LABELS[f.operator]}" requires a limit.`;
  }
  return null;
}

function toPayload(f: FormState) {
  const outOfRange = f.operator === 'OUT_OF_RANGE';
  return {
    key: f.key.trim(),
    operator: f.operator,
    // Send the fields the chosen operator does NOT use as explicit nulls, so
    // editing GT→OUT_OF_RANGE (or back) clears the stale limit rather than
    // leaving a value that no longer means anything.
    limit: outOfRange ? null : num(f.limit),
    limitLow: outOfRange ? num(f.limitLow) : null,
    limitHigh: outOfRange ? num(f.limitHigh) : null,
    hysteresis: num(f.hysteresis) ?? 0,
    severity: f.severity,
    isActive: f.isActive,
  };
}

export function InstrumentThresholds({ instrumentId }: { instrumentId: string }) {
  const can = useCan();
  const reauth = useReauth();
  const canManage = can('alarms.thresholds');

  const { data, isLoading, mutate } = useSWR<ThresholdRow[]>(
    instrumentId ? `/api/instruments/${instrumentId}/thresholds` : null,
  );

  // null = form closed; '' = creating; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = data ?? [];
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  const openCreate = () => { setForm(EMPTY_FORM); setEditing(''); setFormError(null); };
  const openEdit = (t: ThresholdRow) => { setForm(toForm(t)); setEditing(t.id); setFormError(null); };
  const closeForm = () => { setEditing(null); setFormError(null); };

  const save = () => {
    const problem = validate(form);
    if (problem) { setFormError(problem); return; }
    setFormError(null);
    setBusy(true);

    const isCreate = editing === '';
    const payload = toPayload(form);

    reauth.execute(
      'MANAGE_ALARM_THRESHOLD',
      async (password?: string) => {
        if (isCreate) {
          const body = { instrumentId, ...payload };
          if (password) await apiClient.postWithReauth('/api/alarm-thresholds', body, password);
          else await apiClient.post('/api/alarm-thresholds', body);
        } else {
          const url = `/api/alarm-thresholds/${editing}`;
          if (password) await apiClient.putWithReauth(url, payload, password);
          else await apiClient.put(url, payload);
        }
      },
      {
        onSuccess: () => { setBusy(false); closeForm(); void mutate(); },
        onError: (err: unknown) => {
          setBusy(false);
          setFormError(err instanceof Error ? err.message : 'Could not save the threshold.');
        },
        // A cancelled password prompt is not an error, but the busy flag still
        // has to clear or the form stays locked with no way out.
        onCancel: () => setBusy(false),
      },
    );
  };

  const remove = (t: ThresholdRow) => {
    setBusy(true);
    reauth.execute(
      'MANAGE_ALARM_THRESHOLD',
      async (password?: string) => {
        const url = `/api/alarm-thresholds/${t.id}`;
        if (password) await apiClient.deleteWithReauth(url, password);
        else await apiClient.delete(url);
      },
      {
        onSuccess: () => { setBusy(false); void mutate(); },
        onError: (err: unknown) => {
          setBusy(false);
          // The commonest failure is the Restrict FK: a threshold that has
          // raised alarms cannot be deleted. The server's message says exactly
          // that, so surface it rather than a generic one.
          setFormError(err instanceof Error ? err.message : 'Could not delete the threshold.');
        },
        onCancel: () => setBusy(false),
      },
    );
  };

  const outOfRange = form.operator === 'OUT_OF_RANGE';

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium text-slate-900">Alarm thresholds</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Limits evaluated against each incoming reading for this instrument.
          </p>
        </div>
        {canManage && editing === null && (
          <Button size="sm" onClick={openCreate}>Add threshold</Button>
        )}
      </div>

      {/* Delete errors have no form open to render into. */}
      {editing === null && formError && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {formError}
        </div>
      )}

      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="p-3">Key</th>
              <th className="p-3">Condition</th>
              <th className="p-3">Hysteresis</th>
              <th className="p-3">Severity</th>
              <th className="p-3">Status</th>
              {canManage && <th className="p-3" />}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">Loading thresholds…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">
                <div className="font-medium text-slate-700">No thresholds configured</div>
                <div className="mt-1 text-xs">
                  Readings from this instrument are recorded but never raise an alarm
                  until a threshold exists.
                </div>
              </td></tr>
            )}
            {rows.map(t => (
              <tr key={t.id} className="border-b border-slate-100 last:border-0">
                <td className="p-3 font-mono text-xs">{t.key}</td>
                <td className="p-3 text-slate-700">{describeThreshold(t)}</td>
                <td className="p-3 tabular-nums text-slate-500">{formatNumber(t.hysteresis)}</td>
                <td className="p-3 text-slate-700">{SEVERITY_LABELS[t.severity]}</td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${
                    t.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {t.isActive ? 'Active' : 'Retired'}
                  </span>
                </td>
                {canManage && (
                  <td className="p-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => openEdit(t)}
                        disabled={busy}
                        className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                      >Edit</button>
                      <button
                        onClick={() => remove(t)}
                        disabled={busy}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
                      >Delete</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && editing !== null && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-medium text-slate-900">
            {editing === '' ? 'New threshold' : 'Edit threshold'}
          </h3>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs text-slate-600">
              Measurement key
              <input
                value={form.key}
                onChange={e => set('key', e.target.value)}
                placeholder="temp"
                className="mt-1 block w-full rounded border border-slate-200 px-2 py-1 text-sm"
              />
            </label>

            <label className="text-xs text-slate-600">
              Condition
              <select
                value={form.operator}
                onChange={e => set('operator', e.target.value as ThresholdOperator)}
                className="mt-1 block w-full rounded border border-slate-200 bg-white px-2 py-1 text-sm"
              >
                {OPERATORS.map(o => (
                  <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>
                ))}
              </select>
            </label>

            {/* Only the fields the chosen operator actually uses are shown —
                an inert `limit` box next to a range operator invites entering
                a number that would silently be discarded. */}
            {outOfRange ? (
              <>
                <label className="text-xs text-slate-600">
                  Low limit
                  <input
                    type="number" value={form.limitLow}
                    onChange={e => set('limitLow', e.target.value)}
                    className="mt-1 block w-full rounded border border-slate-200 px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-slate-600">
                  High limit
                  <input
                    type="number" value={form.limitHigh}
                    onChange={e => set('limitHigh', e.target.value)}
                    className="mt-1 block w-full rounded border border-slate-200 px-2 py-1 text-sm"
                  />
                </label>
              </>
            ) : (
              <label className="text-xs text-slate-600">
                Limit
                <input
                  type="number" value={form.limit}
                  onChange={e => set('limit', e.target.value)}
                  className="mt-1 block w-full rounded border border-slate-200 px-2 py-1 text-sm"
                />
              </label>
            )}

            <label className="text-xs text-slate-600">
              Hysteresis
              <input
                type="number" min={0} value={form.hysteresis}
                onChange={e => set('hysteresis', e.target.value)}
                className="mt-1 block w-full rounded border border-slate-200 px-2 py-1 text-sm"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                Dead band the reading must clear before the alarm recovers — stops a
                value hovering on the limit from flapping.
              </span>
            </label>

            <label className="text-xs text-slate-600">
              Severity
              <select
                value={form.severity}
                onChange={e => set('severity', e.target.value as AlarmSeverity)}
                className="mt-1 block w-full rounded border border-slate-200 bg-white px-2 py-1 text-sm"
              >
                {SEVERITY_ORDER.map(s => (
                  <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-600 sm:col-span-2">
              <input
                type="checkbox" checked={form.isActive}
                onChange={e => set('isActive', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Active — evaluate this threshold against incoming readings
            </label>
          </div>

          {formError && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {formError}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={closeForm} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save threshold'}
            </Button>
          </div>
        </div>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setBusy(false); }}
        actionLabel="Manage Alarm Threshold"
      />
    </section>
  );
}
