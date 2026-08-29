import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Button } from '@/components/ui/button';
import { AcknowledgeDialog } from './acknowledge-dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonRows } from '@/components/ui/skeleton';
import {
  needsAcknowledgement, severityTone,
  instrumentLabel, statusText, alarmTypeText, limitText,
  mapStatusTextsResponse,
  filterByQuadrant, quadrantCounts, ALARM_QUADRANTS,
  triggeredText, clearedText, alarmDurationText,
  type AlarmRow, type AlarmQuadrant, type AlarmStatusTextsResponse,
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

  // ONE four-way filter replaces the Active/History tabs and the
  // "Unacknowledged only" checkbox (operator, 2026-08-29). `null` = nothing
  // chosen = show everything, so the page does not open having silently hidden
  // three quarters of the alarms; clicking the chosen box again returns to it.
  const [quadrant, setQuadrant] = useState<AlarmQuadrant | null>(null);
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

  const all = useMemo(() => data?.data ?? [], [data]);
  const rows = useMemo(() => filterByQuadrant(all, quadrant), [all, quadrant]);
  // Counted over the SAME rows the table can show (the request is capped at 500),
  // so a box's number and the list under it can never disagree.
  const counts = useMemo(() => quadrantCounts(all), [all]);

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

  return (
    // NO padding here. `<main>` in app-layout already applies `p-3 sm:p-4 lg:p-6`,
    // so this page's own `p-6` was DOUBLE-padding it — ~48px of dead margin down
    // each side, which is why the table appeared not to reach the page edges while
    // the dashboard (which adds none) did. Removed 2026-08-29.
    <div>
      <PageHeader
        className="mb-6"
        title="Alarms"
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Alarms' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        }
      />

      {/* The four boxes ARE the filter. Selected one filters the table; clicking it
          again clears the selection and shows everything. */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ALARM_QUADRANTS.map((q) => (
          <FilterTile
            key={q.id}
            label={q.label}
            value={counts[q.id]}
            tone={QUADRANT_TONE[q.id]}
            selected={quadrant === q.id}
            onClick={() => setQuadrant(quadrant === q.id ? null : q.id)}
          />
        ))}
      </div>

      {summary?.limitAlarmsEnabled === false && (
        <div className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Limit alarms are turned off, so no instrument limits are being checked.
          Turn them on in Configuration → Instrument Limit Alarms.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="tbl w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Instrument ID</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Raised</th>
              <th className="px-4 py-3 whitespace-nowrap">Value (°C / %RH)</th>
              <th className="px-4 py-3">Limit</th>
              <th className="px-4 py-3">Cleared</th>
              <th className="px-4 py-3 whitespace-nowrap">Cleared (°C / %RH)</th>
              <th className="px-4 py-3">Status</th>
              {/* H = hours, m = minutes. Abbreviated because the spelled-out
                  legend was the widest header on the page and pushed the table
                  past the viewport. */}
              <th className="px-4 py-3 whitespace-nowrap" title="H = hours, m = minutes">Duration (H/m)</th>
              <th className="px-4 py-3">Acknowledged</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={11} className="px-4 py-4"><SkeletonRows rows={4} columns={6} /></td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-slate-500">
                  {quadrant
                    ? 'No alarms in this state.'
                    : 'No alarms have been raised.'}
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{instrumentLabel(a)}</td>
                <td className="px-4 py-3 text-slate-700">{alarmTypeText(a)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDateTime(a.raisedAt)}</td>
                <td className="px-4 py-3 tabular-nums text-slate-900">{triggeredText(a)}</td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{limitText(a)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {a.clearedAt ? formatDateTime(a.clearedAt) : <span className="font-medium text-amber-700">—</span>}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{clearedText(a)}</td>
                <td className="px-4 py-3">
                  <StatusBadge tone={severityTone(a.severity)} label={statusText(a, statusTexts)} />
                </td>
                <td
                  className="px-4 py-3 tabular-nums whitespace-nowrap text-slate-700"
                  title={a.clearedAt ? undefined : 'Still active — no cleared time yet'}
                >
                  {alarmDurationText(a)}
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

/**
 * Tone per state. Active-unacknowledged is the loudest because it is the one
 * nobody has answered for yet; cleared-unacknowledged is still amber rather than
 * neutral, because an excursion that ended without a signature is unfinished
 * paperwork, not a closed matter.
 */
const QUADRANT_TONE: Record<AlarmQuadrant, string> = {
  'active-ack': 'bg-amber-50 border-amber-200 text-amber-900',
  'active-unack': 'bg-red-50 border-red-200 text-red-900',
  'cleared-ack': 'bg-slate-50 border-slate-200 text-slate-900',
  'cleared-unack': 'bg-orange-50 border-orange-200 text-orange-900',
};

function FilterTile({
  label, value, tone, selected, onClick,
}: { label: string; value: number; tone: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-lg border px-4 py-3 text-left transition-shadow ${tone} ${
        selected ? 'ring-2 ring-slate-900/70 shadow-sm' : 'hover:shadow-sm'
      }`}
    >
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </button>
  );
}
