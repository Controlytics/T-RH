import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  ALARM_WEBHOOK_DELIVERY_STATUSES,
  ALARM_WEBHOOK_EVENTS,
  ALARM_WEBHOOK_METHODS,
  ALARM_WEBHOOK_VARIABLES,
  DEFAULT_WEBHOOK_BODY_TEMPLATE,
} from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Button } from '@/components/ui/button';
import { ReauthDialog } from '@/components/reauth-dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ALL_RECORDS_PARAM } from '@digilog/shared';

export interface WebhookTarget {
  id: string;
  name: string;
  description: string | null;
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  bodyTemplate: string;
  successRegex: string | null;
  timeoutMs: number;
  fireOnRaised: boolean;
  fireOnCleared: boolean;
  fireOnAcknowledged: boolean;
  cooldownSeconds: number;
  isActive: boolean;
  scopeLocationIds: string[];
  scopeInstrumentIds: string[];
  /** Resolved SERVER-side — never recomputed here. See AlarmWebhooksConfigPage's note. */
  instrumentCount: number;
  lastDeliveryStatus: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Delivery {
  id: string;
  targetId: string;
  alarmId: string | null;
  event: string;
  url: string;
  requestBody: string;
  httpStatus: number | null;
  responseSnippet: string | null;
  attempt: number;
  status: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface InstrumentRow { id: string; code: string; name: string }
interface FlNode { id: string; name: string; type: 'BLOCK' | 'AREA'; ownCount: number; totalCount: number; children: FlNode[] }

interface TestResult { ok: boolean; httpStatus: number | null; responseSnippet: string | null; error: string | null }
/**
 * `stamp` exists so a REPEATED test with an identical outcome still counts as a new
 * result. Press-test-again is the commissioning loop; keying the delivery-log refetch
 * on the result's content alone would silently skip the second row.
 */
interface StampedTestResult extends TestResult { stamp: number }

const DELIVERY_PAGE = 25;

// One shared class string per file was how these two dialogs avoided the
// per-field drift the rest of the app had — the right instinct, one layer too
// low. Pointing it at `.ctl` keeps the single definition AND joins the
// application's one control appearance, so these fields now follow the site
// theme's focus ring like every other field instead of a hardcoded slate one.
const field = 'ctl w-full';
const labelCls = 'mb-1 block text-sm font-medium text-slate-700';

interface Draft {
  id?: string;
  name: string;
  description: string;
  url: string;
  method: string;
  headerRows: { key: string; value: string }[];
  contentType: string;
  bodyTemplate: string;
  successRegex: string;
  timeoutMs: number;
  cooldownSeconds: number;
  fireOnRaised: boolean;
  fireOnCleared: boolean;
  fireOnAcknowledged: boolean;
  isActive: boolean;
  scopeLocationIds: string[];
  scopeInstrumentIds: string[];
}

const emptyDraft: Draft = {
  name: '', description: '', url: '', method: 'POST',
  headerRows: [], contentType: 'application/json',
  bodyTemplate: DEFAULT_WEBHOOK_BODY_TEMPLATE,
  successRegex: '', timeoutMs: 5000, cooldownSeconds: 0,
  fireOnRaised: true, fireOnCleared: true, fireOnAcknowledged: true, isActive: true,
  scopeLocationIds: [], scopeInstrumentIds: [],
};

function draftOf(t: WebhookTarget): Draft {
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? '',
    url: t.url,
    method: t.method,
    headerRows: Object.entries(t.headers ?? {}).map(([key, value]) => ({ key, value })),
    contentType: t.contentType,
    bodyTemplate: t.bodyTemplate,
    successRegex: t.successRegex ?? '',
    timeoutMs: t.timeoutMs,
    cooldownSeconds: t.cooldownSeconds,
    fireOnRaised: t.fireOnRaised,
    fireOnCleared: t.fireOnCleared,
    fireOnAcknowledged: t.fireOnAcknowledged,
    isActive: t.isActive,
    scopeLocationIds: t.scopeLocationIds ?? [],
    scopeInstrumentIds: t.scopeInstrumentIds ?? [],
  };
}

/** Every variable any event can provide — exactly the union `validateTargetDraft` allows. */
const KNOWN_VARIABLES = new Set(Object.values(ALARM_WEBHOOK_VARIABLES).flatMap((v) => [...v]));

/**
 * Mirrors the server's `validateTargetDraft`, in the same order, for the MESSAGE only.
 * The server stays authoritative — this exists so a typo in a template is named before
 * a round trip that also costs a re-authentication.
 */
export function webhookDraftError(d: Draft): { field: string; message: string } | null {
  if (!d.name.trim()) return { field: 'name', message: 'Name is required.' };
  let parsed: URL;
  try { parsed = new URL(d.url); } catch { return { field: 'url', message: 'Enter a full URL, e.g. http://192.168.1.60/alarm' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { field: 'url', message: 'URL must start with http:// or https://' };
  }
  if (!ALARM_WEBHOOK_METHODS.includes(d.method as (typeof ALARM_WEBHOOK_METHODS)[number])) {
    return { field: 'method', message: `Method must be one of ${ALARM_WEBHOOK_METHODS.join(', ')}.` };
  }
  if (!d.bodyTemplate.trim()) return { field: 'bodyTemplate', message: 'Body template is required.' };
  for (const m of d.bodyTemplate.matchAll(/\$\{([^}]+)\}/g)) {
    const key = m[1].trim();
    if (!KNOWN_VARIABLES.has(key)) return { field: 'bodyTemplate', message: `Unknown variable \${${key}}.` };
  }
  if (d.successRegex.trim()) {
    try { new RegExp(d.successRegex); }
    catch { return { field: 'successRegex', message: 'Not a valid regular expression.' }; }
  }
  if (!Number.isInteger(d.timeoutMs) || d.timeoutMs < 100 || d.timeoutMs > 60_000) {
    return { field: 'timeoutMs', message: 'Timeout must be between 100 and 60000 ms.' };
  }
  if (!Number.isInteger(d.cooldownSeconds) || d.cooldownSeconds < 0 || d.cooldownSeconds > 86_400) {
    return { field: 'cooldownSeconds', message: 'Cooldown must be between 0 and 86400 seconds.' };
  }
  for (const r of d.headerRows) {
    if (r.value.trim() && !r.key.trim()) return { field: 'headers', message: 'A header value needs a name.' };
  }
  return null;
}

/** Draft → request body. Undoes the two representation choices `draftOf` made. */
function bodyOf(d: Draft) {
  const headers: Record<string, string> = {};
  for (const r of d.headerRows) if (r.key.trim()) headers[r.key.trim()] = r.value;
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    url: d.url.trim(),
    method: d.method,
    headers,
    contentType: d.contentType.trim(),
    bodyTemplate: d.bodyTemplate,
    successRegex: d.successRegex.trim() || null,
    timeoutMs: d.timeoutMs,
    cooldownSeconds: d.cooldownSeconds,
    fireOnRaised: d.fireOnRaised,
    fireOnCleared: d.fireOnCleared,
    fireOnAcknowledged: d.fireOnAcknowledged,
    isActive: d.isActive,
    scopeLocationIds: d.scopeLocationIds,
    scopeInstrumentIds: d.scopeInstrumentIds,
  };
}

/**
 * Alarm Webhooks — the IP hooters and HTTP endpoints an alarm is announced to.
 *
 * `instrumentCount` is the SERVER's number and is only ever read off an API response.
 * It is not recomputed here from the location tree: the server resolves it with the
 * fire flags deliberately held open, and a second implementation
 * in the browser is exactly the drift CLAUDE.md forbids. The consequence is that the
 * count belongs on the list row, not inside the unsaved form — there is no endpoint
 * that resolves a count for a scope that has not been saved yet.
 */
export function AlarmWebhooksConfigPage() {
  const can = useCan();
  const { toast } = useToast();
  const { formatDateTime } = useDatetimeFormat();
  const { data, isLoading, mutate } = useSWR<{ data: WebhookTarget[] }>('/api/alarm-webhooks');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Draft | undefined>();
  const [confirmDelete, setConfirmDelete] = useState<WebhookTarget | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, StampedTestResult>>({});

  // Every write needs re-authentication, so each one parks its intent here and runs
  // only once the password is accepted.
  const [pending, setPending] = useState<((p: string) => Promise<void>) | null>(null);
  // Named per action: an e-signature that says "Save alarm webhook" while the operator
  // is test-firing a hooter misdescribes what is being signed for.
  const [pendingLabel, setPendingLabel] = useState('Save alarm webhook');
  const [password, setPassword] = useState('');
  const [reauthError, setReauthError] = useState('');
  const [verifying, setVerifying] = useState(false);

  const targets = data?.data ?? [];
  const canManage = can('alarm_webhooks.manage');
  const detail = targets.find((t) => t.id === detailId) ?? null;

  const runWithPassword = (label: string, fn: (p: string) => Promise<void>) => {
    setPassword('');
    setReauthError('');
    setPendingLabel(label);
    setPending(() => fn);
  };

  const confirmReauth = async () => {
    if (!pending) return;
    setVerifying(true);
    setReauthError('');
    try {
      await pending(password);
    } catch (e) {
      // Stays open with the message: the password is still on screen to correct.
      setReauthError(e instanceof Error ? e.message : 'Could not complete that change.');
      return;
    } finally {
      setVerifying(false);
    }
    // Refetch only AFTER closing — a failed refresh inside the try would write an
    // error onto a dialog that is already gone, so the write would look like it failed.
    setPending(null);
    await mutate();
  };

  const submit = (draft: Draft) => {
    setDialogOpen(false);
    runWithPassword(draft.id ? 'Update alarm webhook' : 'Create alarm webhook', async (p) => {
      const body = bodyOf(draft);
      if (draft.id) {
        await apiClient.putWithReauth(`/api/alarm-webhooks/${draft.id}`, body, p);
        toast.success('Target updated', `"${body.name}" saved.`);
      } else {
        await apiClient.postWithReauth('/api/alarm-webhooks', body, p);
        toast.success('Target created', `"${body.name}" saved.`);
      }
    });
  };

  const toggleActive = (t: WebhookTarget) => {
    runWithPassword(t.isActive ? 'Deactivate alarm webhook' : 'Activate alarm webhook', async (p) => {
      await apiClient.putWithReauth(`/api/alarm-webhooks/${t.id}`, { isActive: !t.isActive }, p);
      toast.success(t.isActive ? 'Target deactivated' : 'Target activated', `"${t.name}".`);
    });
  };

  const remove = (t: WebhookTarget, reason: string) => {
    // Closed FIRST, so the re-auth prompt is never stacked on top of this dialog.
    // `reason` is already an argument, so nothing is lost by unmounting the form.
    setConfirmDelete(null);
    setDeleteError('');
    runWithPassword('Delete alarm webhook', async (p) => {
      try {
        await apiClient.deleteWithReauth(`/api/alarm-webhooks/${t.id}`, p, { reason });
      } catch (e) {
        // A 409 is not a failed signature — the target is simply undeletable because
        // its deliveries are regulated records. Report it where the operator is looking
        // and offer the act that IS available, rather than a generic error.
        // `code` — apiClient lifts the server's `error` field onto an Error as `.code`.
        const err = e as { code?: string; message?: string };
        if (err?.code === 'TARGET_HAS_DELIVERIES') {
          setPending(null);
          toast.error('Cannot delete', `${err.message ?? ''} Deactivate it instead.`.trim());
          return;
        }
        throw e;
      }
      toast.success('Target deleted', `"${t.name}" removed.`);
    });
  };

  const sendTest = (t: WebhookTarget) => {
    runWithPassword('Test-fire alarm webhook', async (p) => {
      // `ok: false` arrives as a 200. Throwing on it would render a dead hooter as a
      // re-authentication failure, so the result is stored and shown on the page.
      const res = await apiClient.postWithReauth<TestResult>(`/api/alarm-webhooks/${t.id}/test`, {}, p);
      setTestResult((prev) => ({ ...prev, [t.id]: { ...res, stamp: Date.now() } }));
      if (res.ok) toast.success('Test delivered', `HTTP ${res.httpStatus ?? '—'}`);
      else toast.error('Test failed', res.error ?? `HTTP ${res.httpStatus ?? '—'}`);
    });
  };

  return (
    <div className="p-6">
      <PageHeader
        className="mb-6"
        title="Alarm Webhooks"
        description="Send an alarm to a device as well as a person — an IP-addressable hooter, a panel, any endpoint on the plant network."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Alarm Webhooks' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
          </svg>
        }
        actions={canManage && (
          <Button onClick={() => { setEditing(undefined); setDialogOpen(true); }}>New Target</Button>
        )}
      />

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="tbl w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">URL</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Events</th>
              <th className="px-4 py-3">Scope</th>
              <th className="px-4 py-3">Last delivery</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && <tr><td colSpan={8} className="px-4 py-4"><SkeletonRows rows={4} columns={6} /></td></tr>}
            {!isLoading && targets.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-2"><EmptyState compact title="No targets" /></td></tr>
            )}
            {targets.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{t.name}</td>
                <td className="max-w-xs truncate px-4 py-3 text-slate-700" title={t.url}>{t.url}</td>
                <td className="px-4 py-3 text-slate-700">{t.method}</td>
                <td className="px-4 py-3">
                  {/* All three flags off is as terminal as an empty scope, and was the one
                      mute state carrying no visual weight at all. */}
                  {(() => {
                    const events = [
                      t.fireOnRaised && 'Raised',
                      t.fireOnCleared && 'Cleared',
                      t.fireOnAcknowledged && 'Acknowledged',
                    ].filter(Boolean);
                    return events.length === 0
                      ? <span className="text-amber-700">No events — this target will not fire</span>
                      : <span className="text-slate-700">{events.join(', ')}</span>;
                  })()}
                </td>
                <td className="px-4 py-3">
                  {t.instrumentCount === 0 ? (
                    <span className="text-amber-700">0 instruments — this target will not fire</span>
                  ) : (
                    <span className="tabular-nums text-slate-600">
                      {t.scopeLocationIds.length} locations, {t.scopeInstrumentIds.length} instruments
                      {' · '}{t.instrumentCount} in scope
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {/* Resolved server-side on the list response. "Did this hooter actually
                      work last time" cannot be derived from anything else on the row. */}
                  {t.lastDeliveryStatus === null ? (
                    <span className="text-slate-500">Never fired</span>
                  ) : (
                    <span className={t.lastDeliveryStatus === 'SENT' ? 'text-emerald-700' : 'text-red-700'}>
                      {t.lastDeliveryStatus}
                      {t.lastDeliveryAt && <span className="text-slate-500"> {'·'} {formatDateTime(t.lastDeliveryAt)}</span>}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge tone={t.isActive ? 'ok' : 'idle'} label={t.isActive ? 'Active' : 'Inactive'} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setDetailId(detailId === t.id ? null : t.id)}>
                      {detailId === t.id ? 'Hide' : 'Deliveries'}
                    </Button>
                    {canManage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => toggleActive(t)}>
                          {t.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setEditing(draftOf(t)); setDialogOpen(true); }}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => { setConfirmDelete(t); setDeleteReason(''); setDeleteError(''); }}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <TargetDetail
          target={detail}
          canManage={canManage}
          testResult={testResult[detail.id]}
          onTest={() => sendTest(detail)}
          formatDateTime={formatDateTime}
        />
      )}

      {dialogOpen && (
        <TargetDialog
          initial={editing}
          onSubmit={submit}
          onClose={() => setDialogOpen(false)}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="wh-delete-title" className="w-full max-w-md rounded-lg bg-white shadow-[var(--elev-2)]">
            <div className="rounded-t-lg bg-gradient-to-r from-rose-500 to-red-600 px-5 py-3">
              <h2 id="wh-delete-title" className="text-base font-semibold text-white">Delete “{confirmDelete.name}”</h2>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div>
                <label htmlFor="webhook-delete-reason" className={labelCls}>Reason</label>
                <textarea
                  id="webhook-delete-reason"
                  rows={3}
                  maxLength={500}
                  className={field}
                  value={deleteReason}
                  onChange={(e) => { setDeleteReason(e.target.value); setDeleteError(''); }}
                />
                {deleteError && <p className="mt-1 text-xs text-red-600">{deleteError}</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
              <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (!deleteReason.trim()) { setDeleteError('A reason is required.'); return; }
                  remove(confirmDelete, deleteReason.trim());
                }}
              >
                Delete target
              </Button>
            </div>
          </div>
        </div>
      )}

      <ReauthDialog
        open={pending !== null}
        password={password}
        error={reauthError}
        isVerifying={verifying}
        onPasswordChange={setPassword}
        onConfirm={confirmReauth}
        onCancel={() => setPending(null)}
        actionLabel={pendingLabel}
      />
    </div>
  );
}

/**
 * Delivery log for one target, plus the test control.
 *
 * The status filter is a QUERY PARAM, never a filter over the fetched page: `total` and
 * the pager have to move with the rows, or the footer, the Next button and the empty
 * state all describe a different set from the one on screen.
 */
function TargetDetail({
  target, canManage, testResult, onTest, formatDateTime,
}: {
  target: WebhookTarget;
  canManage: boolean;
  testResult?: StampedTestResult;
  onTest: () => void;
  formatDateTime: (v: string | Date) => string;
}) {
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => { setOffset(0); setStatus(''); }, [target.id]);

  const { data, isLoading, mutate } = useSWR<{ data: Delivery[]; total: number }>(
    `/api/alarm-webhooks/${target.id}/deliveries?limit=${DELIVERY_PAGE}&offset=${offset}`
      + (status ? `&status=${status}` : ''),
  );
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  // A test writes delivery rows, so the log must be refetched after one fires.
  const testKey = testResult?.stamp ?? 0;
  useEffect(() => { if (testKey) void mutate(); }, [testKey, mutate]);

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">{target.name}</h2>
        <div className="flex items-center gap-2">
          <select
            className="ctl ctl-sm"
            value={status}
            aria-label="Delivery status"
            // Back to the first page: offset 25 of the unfiltered log is not offset 25
            // of the filtered one.
            onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
          >
            <option value="">All statuses</option>
            {ALARM_WEBHOOK_DELIVERY_STATUSES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {canManage && <Button size="sm" onClick={onTest}>Send test</Button>}
        </div>
      </div>

      {canManage && (
        <div className="border-b border-slate-200 px-4 py-2">
          <p className="text-xs text-slate-500">Test fires sound a real hooter and are recorded in the audit trail.</p>
          {testResult && (
            <div className={`mt-2 rounded-md border px-3 py-2 text-xs ${
              testResult.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-300 bg-red-50 text-red-900'
            }`}>
              <div className="font-semibold">{testResult.ok ? 'Delivered' : 'Failed'} · HTTP {testResult.httpStatus ?? '—'}</div>
              {testResult.error && <div className="mt-1">{testResult.error}</div>}
              {testResult.responseSnippet && (
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">{testResult.responseSnippet}</pre>
              )}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="tbl w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Event</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">HTTP</th>
              <th className="px-4 py-2">Attempt</th>
              <th className="px-4 py-2">Response</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && <tr><td colSpan={6} className="px-4 py-4"><SkeletonRows rows={4} columns={6} /></td></tr>}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  {/* Unqualified, this says the target has never fired — false, and
                      dangerously so, on a target with 400 rows and a filter applied. */}
                  {status ? `No ${status} deliveries.` : 'No deliveries.'}
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="px-4 py-2 text-slate-700">{formatDateTime(d.sentAt ?? d.createdAt)}</td>
                <td className="px-4 py-2 text-slate-700">{d.event}</td>
                <td className="px-4 py-2">
                  <StatusBadge tone={d.status === 'SENT' ? 'ok' : 'danger'} label={d.status} />
                </td>
                <td className="px-4 py-2 tabular-nums text-slate-600">{d.httpStatus ?? '—'}</td>
                <td className="px-4 py-2 tabular-nums text-slate-600">{d.attempt}</td>
                <td className="max-w-md truncate px-4 py-2 font-mono text-xs text-slate-600" title={d.responseSnippet ?? d.error ?? ''}>
                  {d.responseSnippet ?? d.error ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-2 text-xs text-slate-600">
        <span className="tabular-nums">{total} deliveries{status ? ` · ${status}` : ''}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - DELIVERY_PAGE))}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={offset + DELIVERY_PAGE >= total} onClick={() => setOffset(offset + DELIVERY_PAGE)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Create / edit form.
 *
 * The placeholder picker renders FROM `ALARM_WEBHOOK_VARIABLES`, grouped by the event
 * that provides each variable. The server validates the template against the UNION of
 * those lists, so any chip here is accepted; a hand-written list would eventually offer
 * a placeholder that fails on save.
 *
 * No instrument count is shown here: the count is resolved server-side and only exists
 * on a saved target's response, so it lives on the list row instead.
 */
function TargetDialog({
  initial, onSubmit, onClose,
}: {
  initial?: Draft;
  onSubmit: (d: Draft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial ?? emptyDraft);
  const [touched, setTouched] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // The 500 cap is DELIBERATE — do not "fix" it by moving to
  // /api/functional-locations/linkable-instruments, which returns every instrument
  // unpaginated but is a bare findMany with no visibility scoping. This route applies
  // resolveVisibility, so a user with a restricted instrument_scope cannot read the
  // codes and names of instruments outside it. The cap costs display only: ids beyond
  // it stay in scopeInstrumentIds and are resubmitted untouched, so nothing is lost by
  // saving from a truncated picker.
  const { data: instrumentData, error: instrumentError } = useSWR<{ data: InstrumentRow[] }>(
    `/api/instruments?${ALL_RECORDS_PARAM}`,
  );
  const { data: flData, error: flError } = useSWR<{ data: FlNode[] }>('/api/functional-locations');

  const instruments = useMemo(
    () => [...(instrumentData?.data ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [instrumentData],
  );
  const flat = useMemo(
    () => (flData?.data ?? []).flatMap((b) => [{ node: b, depth: 0 }, ...(b.children ?? []).map((c) => ({ node: c, depth: 1 }))]),
    [flData],
  );

  const err = webhookDraftError(draft);
  const showErr = (f: string) => touched && err?.field === f;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  /** Inserts at the caret so a chip can be added mid-template, not only at the end. */
  const insertVariable = (name: string) => {
    const el = bodyRef.current;
    const token = `\${${name}}`;
    if (!el) { set('bodyTemplate', draft.bodyTemplate + token); return; }
    const start = el.selectionStart ?? draft.bodyTemplate.length;
    const end = el.selectionEnd ?? start;
    const next = draft.bodyTemplate.slice(0, start) + token + draft.bodyTemplate.slice(end);
    set('bodyTemplate', next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="wh-dialog-title" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white shadow-[var(--elev-2)]">
        <div className="rounded-t-lg bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-3">
          <h2 id="wh-dialog-title" className="text-base font-semibold text-white">{draft.id ? 'Edit Target' : 'New Target'}</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="wh-name" className={labelCls}>Name</label>
              <input id="wh-name" className={field} value={draft.name} onChange={(e) => set('name', e.target.value)} />
              {showErr('name') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
            </div>
            <div>
              <label htmlFor="wh-description" className={labelCls}>Description</label>
              <input id="wh-description" className={field} value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <div>
              <label htmlFor="wh-url" className={labelCls}>URL</label>
              <input id="wh-url" className={field} value={draft.url} onChange={(e) => set('url', e.target.value)} placeholder="http://192.168.1.60/alarm" />
              {showErr('url') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
            </div>
            <div>
              <label htmlFor="wh-method" className={labelCls}>Method</label>
              <select id="wh-method" className={field} value={draft.method} onChange={(e) => set('method', e.target.value)}>
                {ALARM_WEBHOOK_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {showErr('method') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="wh-content-type" className={labelCls}>Content type</label>
              <input id="wh-content-type" className={field} value={draft.contentType} onChange={(e) => set('contentType', e.target.value)} />
            </div>
            <div>
              <label htmlFor="wh-timeout" className={labelCls}>Timeout (ms)</label>
              <input
                id="wh-timeout" type="number" min={100} max={60000} step={1} className={field}
                value={draft.timeoutMs}
                onChange={(e) => set('timeoutMs', Math.trunc(Number(e.target.value) || 0))}
              />
              {showErr('timeoutMs') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
            </div>
            <div>
              <label htmlFor="wh-cooldown" className={labelCls}>Cooldown (s)</label>
              <input
                id="wh-cooldown" type="number" min={0} max={86400} step={1} className={field}
                value={draft.cooldownSeconds}
                onChange={(e) => set('cooldownSeconds', Math.trunc(Number(e.target.value) || 0))}
              />
              {showErr('cooldownSeconds') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
            </div>
          </div>

          <div>
            <span className={labelCls}>Headers</span>
            <div className="space-y-2">
              {draft.headerRows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className={field}
                    aria-label={`Header ${i + 1} name`}
                    value={row.key}
                    onChange={(e) => set('headerRows', draft.headerRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                  />
                  <input
                    className={field}
                    aria-label={`Header ${i + 1} value`}
                    value={row.value}
                    onChange={(e) => set('headerRows', draft.headerRows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                  />
                  <Button variant="ghost" size="sm" onClick={() => set('headerRows', draft.headerRows.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => set('headerRows', [...draft.headerRows, { key: '', value: '' }])}>
                Add header
              </Button>
              {showErr('headers') && <p className="text-xs text-red-600">{err!.message}</p>}
            </div>
          </div>

          <div>
            <label htmlFor="wh-body" className={labelCls}>Body template</label>
            <textarea
              id="wh-body"
              ref={bodyRef}
              rows={5}
              className={`${field} font-mono`}
              value={draft.bodyTemplate}
              onChange={(e) => set('bodyTemplate', e.target.value)}
            />
            {showErr('bodyTemplate') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
            <div className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
              {/* TEST offers exactly RAISED's variables — a duplicate row, and the
                  server validates against the union either way. */}
              {ALARM_WEBHOOK_EVENTS.filter((e) => e !== 'TEST').map((event) => (
                <div key={event} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-28 shrink-0 text-xs font-semibold text-slate-600">{event}</span>
                  {ALARM_WEBHOOK_VARIABLES[event].map((v) => (
                    <Button variant="outline" size="sm"
                      key={v}
                      type="button"
                      onClick={() => insertVariable(v)}
                    >
                      {`\${${v}}`}
                    </Button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="wh-success-regex" className={labelCls}>Success regex</label>
            <input id="wh-success-regex" className={`${field} font-mono`} value={draft.successRegex} onChange={(e) => set('successRegex', e.target.value)} />
            {showErr('successRegex') && <p className="mt-1 text-xs text-red-600">{err!.message}</p>}
          </div>

          <div>
            <div>
              <span className={labelCls}>Fire on</span>
              <div className="flex flex-wrap gap-3">
                {([
                  ['fireOnRaised', 'Raised'],
                  ['fireOnCleared', 'Cleared'],
                  ['fireOnAcknowledged', 'Acknowledged'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="ctl-check"
                      checked={draft[key]}
                      onChange={(e) => set(key, e.target.checked)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className={labelCls}>Functional locations</span>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
                {/* A role holding only alarm-webhook management holds neither
                    FUNCTIONAL_LOCATION_READ nor INSTRUMENT_READ, and an unreadable list
                    must not read as an empty site. */}
                {flError && <p className="text-xs text-amber-700">Could not load — you may not have FUNCTIONAL_LOCATION_READ.</p>}
                {!flError && flat.length === 0 && <p className="text-xs text-slate-500">None.</p>}
                {flat.map(({ node, depth }) => (
                  <label key={node.id} className={`flex items-center gap-2 text-sm ${depth ? 'pl-6' : 'font-medium'}`}>
                    <input
                      type="checkbox"
                      className="ctl-check"
                      checked={draft.scopeLocationIds.includes(node.id)}
                      onChange={() => set('scopeLocationIds', toggleIn(draft.scopeLocationIds, node.id))}
                    />
                    <span>{node.name}</span>
                    <span className="text-xs text-slate-500">
                      {node.type === 'BLOCK' ? `Block · ${node.totalCount}` : `Area · ${node.ownCount}`}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <span className={labelCls}>Instruments</span>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
                {instrumentError && <p className="text-xs text-amber-700">Could not load — you may not have INSTRUMENT_READ.</p>}
                {!instrumentError && instruments.length === 0 && <p className="text-xs text-slate-500">None.</p>}
                {instruments.map((i) => (
                  <label key={i.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="ctl-check"
                      checked={draft.scopeInstrumentIds.includes(i.id)}
                      onChange={() => set('scopeInstrumentIds', toggleIn(draft.scopeInstrumentIds, i.id))}
                    />
                    <span>{i.code} — {i.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="ctl-check"
              checked={draft.isActive}
              onChange={(e) => set('isActive', e.target.checked)}
            />
            Active
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setTouched(true); if (!err) onSubmit(draft); }}>
            {draft.id ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AlarmWebhooksConfigPage;
