import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Button } from '@/components/ui/button';
import { AcknowledgeDialog } from './acknowledge-dialog';
import {
  filterByTab, needsAcknowledgement, severityTone, triggeredText,
  instrumentLabel, statusText, alarmTypeText, limitText, clearedText,
  mapStatusTextsResponse,
  type AlarmRow, type AlarmTab, type AlarmStatusTextsResponse,
} from './alarm-display';

/**
 * Alarms — what the evaluator has raised, and who has answered for it.
 *
 * There is no create, edit or delete here by design: alarms are RAISED by the worker
 * and are regulated records. Rules are authored on Configuration → Alarm Rules.
 *
 * The tabs split on the CONDITION (still breaching vs ended). Acknowledgement is a
 * separate axis shown in its own column, because a cleared-but-unacknowledged alarm —
 * the overnight excursion nobody saw — is exactly the one that must not look finished.
 */
export default function AlarmsPage() {
  const can = useCan();
  const { toast } = useToast();
  const { formatDateTime } = useDatetimeFormat();

  const [tab, setTab] = useState<AlarmTab>('active');
  const [unacknowledgedOnly, setUnacknowledgedOnly] = useState(false);
  const [target, setTarget] = useState<AlarmRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const { data, isLoading, mutate } = useSWR<{ data: AlarmRow[] }>('/api/alarms?limit=500');
  const { data: summary, mutate: mutateSummary } = useSWR<{
    active: number; unacknowledged: number; critical: number;
    instrumentsWithoutLimits?: number; instrumentsWithoutLimitsCodes?: string[];
    limitAlarmsEnabled?: boolean;
  }>('/api/alarms/summary');

  // Narrow, all-authenticated-users read — the `alarm-limits` config itself
  // (`/api/config/dynamic/alarm-limits`) is SUPER_ADMIN-only because most of it is
  // sensitive (attribute-key mapping, severity). `/status-texts` exposes only the
  // four wording strings, already defaulted server-side, so every operator sees the
  // configured wording instead of every non-SUPER_ADMIN 403ing into the fallback.
  //
  // The API payload uses `status*`-prefixed keys (mirroring the stored config
  // keys in alarm-limits.def.ts); `AlarmStatusTexts` (alarm-display.ts) uses the
  // unprefixed display-contract names `statusText()` reads. The two vocabularies
  // are deliberately different — `mapStatusTextsResponse()` is the one place
  // that reconciles them, and is unit-tested directly.
  const { data: statusTextsResponse } = useSWR<AlarmStatusTextsResponse>(
    '/api/config/alarm-limits/status-texts',
  );
  const statusTexts = statusTextsResponse ? mapStatusTextsResponse(statusTextsResponse) : undefined;

  const rows = useMemo(
    () => filterByTab(data?.data ?? [], tab, unacknowledgedOnly),
    [data, tab, unacknowledgedOnly],
  );

  const acknowledge = async (reason: string, password: string) => {
    if (!target) return;
    setSubmitting(true);
    setDialogError('');
    try {
      await apiClient.postWithReauth(`/api/alarms/${target.id}/acknowledge`, { reason }, password);
      toast.success('Alarm acknowledged', `Signed for ${instrumentLabel(target)}.`);
      setTarget(null);
      await Promise.all([mutate(), mutateSummary()]);
    } catch (e) {
      // Kept in the dialog rather than a toast: the password is still on screen and the
      // operator needs to correct it in place. A 409 here means someone else signed first.
      setDialogError(e instanceof Error ? e.message : 'Could not acknowledge this alarm.');
    } finally {
      setSubmitting(false);
    }
  };

  const counts = summary ?? { active: 0, unacknowledged: 0, critical: 0 };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">Alarms</h1>
        <p className="mt-1 text-sm text-slate-500">
          Raised when an instrument reading crosses a limit — either an instrument's configured
          limit attributes or an alarm rule. Acknowledging one is an electronic signature.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryTile label="Active" value={counts.active} tone="bg-amber-50 border-amber-200 text-amber-900" />
        <SummaryTile label="Unacknowledged" value={counts.unacknowledged} tone="bg-red-50 border-red-200 text-red-900" />
        <SummaryTile label="Critical (active)" value={counts.critical} tone="bg-slate-50 border-slate-200 text-slate-900" />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-1">
          {(['active', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-4 py-1.5 text-sm font-medium capitalize ${
                tab === t ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={unacknowledgedOnly}
            onChange={(e) => setUnacknowledgedOnly(e.target.checked)}
            className="ctl-check"
          />
          Unacknowledged only
        </label>
      </div>

      {summary?.limitAlarmsEnabled === false && (
        <div className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Limit alarms are turned off, so no instrument limits are being checked.
          Turn them on in Configuration → Instrument Limit Alarms.
        </div>
      )}
      {(summary?.instrumentsWithoutLimits ?? 0) > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{summary?.instrumentsWithoutLimits}</strong> instrument
          {summary?.instrumentsWithoutLimits === 1 ? ' has' : 's have'} no usable limits set — no
          limit alarm can be raised for {summary?.instrumentsWithoutLimits === 1 ? 'it' : 'them'}.
          <span className="ml-1 text-amber-800">
            {(summary?.instrumentsWithoutLimitsCodes ?? []).join(', ')}
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="tbl w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Instrument</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Raised</th>
              <th className="px-4 py-3">Value</th>
              <th className="px-4 py-3">Limit</th>
              <th className="px-4 py-3">Cleared</th>
              <th className="px-4 py-3">Cleared value</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Acknowledged</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-500">Loading…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-slate-500">
                  {tab === 'active'
                    ? (unacknowledgedOnly ? 'No unacknowledged active alarms.' : 'No active alarms — every rule is within limit.')
                    : (unacknowledgedOnly ? 'Nothing in history is awaiting acknowledgement.' : 'No alarms have cleared yet.')}
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{instrumentLabel(a)}</td>
                <td className="px-4 py-3 text-slate-700">{alarmTypeText(a)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${severityTone(a.severity)}`}>
                    {a.severity}
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDateTime(a.raisedAt)}</td>
                <td className="px-4 py-3 tabular-nums text-slate-900">{triggeredText(a)}</td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{limitText(a)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {a.clearedAt ? formatDateTime(a.clearedAt) : <span className="font-medium text-amber-700">—</span>}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{clearedText(a)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${severityTone(a.severity)}`}>
                    {statusText(a, statusTexts)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {a.acknowledgedAt ? (
                    <span title={a.acknowledgeReason ?? undefined} className="text-slate-700">
                      {a.acknowledgedBy} · {formatDateTime(a.acknowledgedAt)}
                    </span>
                  ) : (
                    <span className="font-medium text-red-700">Awaiting</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {needsAcknowledgement(a) && can('alarms.acknowledge') && (
                    <Button size="sm" variant="outline" onClick={() => { setDialogError(''); setTarget(a); }}>
                      Acknowledge
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AcknowledgeDialog
        alarm={target}
        open={target !== null}
        submitting={submitting}
        error={dialogError}
        onSubmit={acknowledge}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-lg border px-4 py-3 ${tone}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
