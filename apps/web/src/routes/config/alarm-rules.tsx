import { useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ReauthDialog } from '@/components/reauth-dialog';
import { RuleDialog, type RuleDraft } from './alarm-rule-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';

export interface AlarmRule {
  id: string;
  name: string;
  instrumentId: string | null;
  functionalLocationId: string | null;
  metric: string;
  comparison: string;
  thresholdLow: number | null;
  thresholdHigh: number | null;
  delaySeconds: number;
  severity: string;
  isActive: boolean;
  description: string;
  targetLabel: string | null;
  alarmCount: number;
}

/**
 * Alarm Rules — what the per-minute evaluator watches for.
 *
 * `description` is rendered SERVER-side so this page and an alarm row say the same
 * thing about the same rule; re-deriving the phrasing here is how the two drift.
 *
 * A rule that has raised alarms cannot be deleted — the alarms are regulated records
 * and the FK is RESTRICT. The API answers that with a 409 naming the count, and the
 * actionable alternative is deactivation, which is offered inline on the row.
 */
export function AlarmRulesConfigPage() {
  const can = useCan();
  const { toast } = useToast();
  const { data, isLoading, mutate } = useSWR<{ data: AlarmRule[] }>('/api/alarms/rules');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RuleDraft | undefined>();
  const [confirmDelete, setConfirmDelete] = useState<AlarmRule | null>(null);

  // Rule writes need re-authentication, so every one of them parks its intent here and
  // runs only after the password is accepted.
  const [pending, setPending] = useState<((p: string) => Promise<void>) | null>(null);
  const [password, setPassword] = useState('');
  const [reauthError, setReauthError] = useState('');
  const [verifying, setVerifying] = useState(false);

  const rules = data?.data ?? [];
  const canManage = can('alarm_rules.manage');

  const runWithPassword = async (fn: (p: string) => Promise<void>) => {
    setPassword('');
    setReauthError('');
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
    // Refetch only AFTER closing. Inside the try, a failed refresh would write an error
    // onto a dialog that is already gone, so the write would look like it had failed.
    setPending(null);
    await mutate();
  };

  const submit = (draft: RuleDraft) => {
    setDialogOpen(false);
    void runWithPassword(async (p) => {
      const body = {
        name: draft.name,
        instrumentId: draft.targetKind === 'instrument' ? draft.targetId : null,
        functionalLocationId: draft.targetKind === 'location' ? draft.targetId : null,
        metric: draft.metric,
        comparison: draft.comparison,
        thresholdLow: draft.thresholdLow,
        thresholdHigh: draft.thresholdHigh,
        delaySeconds: draft.delaySeconds,
        ...(draft.id ? { isActive: draft.isActive } : {}),
      };
      if (draft.id) {
        await apiClient.putWithReauth(`/api/alarms/rules/${draft.id}`, body, p);
        toast.success('Rule updated', `"${draft.name}" saved.`);
      } else {
        await apiClient.postWithReauth('/api/alarms/rules', body, p);
        toast.success('Rule created', `"${draft.name}" is now being evaluated.`);
      }
    });
  };

  const toggleActive = (rule: AlarmRule) => {
    void runWithPassword(async (p) => {
      await apiClient.putWithReauth(`/api/alarms/rules/${rule.id}`, { isActive: !rule.isActive }, p);
      toast.success(rule.isActive ? 'Rule deactivated' : 'Rule activated', `"${rule.name}".`);
    });
  };

  const remove = (rule: AlarmRule) => {
    setConfirmDelete(null);
    void runWithPassword(async (p) => {
      await apiClient.deleteWithReauth(`/api/alarms/rules/${rule.id}`, p);
      toast.success('Rule deleted', `"${rule.name}" removed.`);
    });
  };

  return (
    <div className="p-6">
      <PageHeader
        className="mb-6"
        title="Alarm Rules"
        description="Conditions the evaluator checks every minute. Raising and clearing are automatic; acknowledgement happens on the Alarms page."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Alarm Rules' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        }
        actions={canManage && (
          <Button onClick={() => { setEditing(undefined); setDialogOpen(true); }}>New Rule</Button>
        )}
      />

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="tbl w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Applies to</th>
              <th className="px-4 py-3">Condition</th>
              <th className="px-4 py-3">Delay</th>
              <th className="px-4 py-3">Alarms</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && <tr><td colSpan={7} className="px-4 py-4"><SkeletonRows rows={4} columns={6} /></td></tr>}
            {!isLoading && rules.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-2">
                  {/* The consequence stays in the description: an empty rules
                      table is not a neutral state here, it means nothing is
                      being watched. */}
                  <EmptyState
                    title="No alarm rules yet"
                    description="Without one, nothing is watched and no alarm can ever be raised."
                    action={canManage && (
                      <Button onClick={() => { setEditing(undefined); setDialogOpen(true); }}>
                        New Rule
                      </Button>
                    )}
                  />
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{r.name}</td>
                <td className="px-4 py-3 text-slate-700">{r.targetLabel ?? '—'}</td>
                <td className="px-4 py-3 text-slate-700">{r.description}</td>
                <td className="px-4 py-3 tabular-nums text-slate-600">
                  {r.delaySeconds === 0 ? 'Immediate' : `${r.delaySeconds}s`}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{r.alarmCount}</td>
                <td className="px-4 py-3">
                  <StatusBadge tone={r.isActive ? 'ok' : 'idle'} label={r.isActive ? 'Active' : 'Inactive'} />
                </td>
                <td className="px-4 py-3">
                  {canManage && (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(r)}>
                        {r.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditing({
                            id: r.id, name: r.name,
                            targetKind: r.instrumentId ? 'instrument' : 'location',
                            targetId: r.instrumentId ?? r.functionalLocationId ?? '',
                            metric: r.metric, comparison: r.comparison,
                            thresholdLow: r.thresholdLow, thresholdHigh: r.thresholdHigh,
                            delaySeconds: r.delaySeconds, isActive: r.isActive,
                          });
                          setDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(r)}>Delete</Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RuleDialog
        open={dialogOpen}
        initial={editing}
        onSubmit={submit}
        onClose={() => setDialogOpen(false)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete alarm rule"
        message={
          confirmDelete
            ? confirmDelete.alarmCount > 0
              ? `"${confirmDelete.name}" has raised ${confirmDelete.alarmCount} alarm(s). Those are permanent records, so this will be refused — deactivate the rule instead.`
              : `Delete "${confirmDelete.name}"? It will stop being evaluated.`
            : ''
        }
        confirmLabel="Delete rule"
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />

      <ReauthDialog
        open={pending !== null}
        password={password}
        error={reauthError}
        isVerifying={verifying}
        onPasswordChange={setPassword}
        onConfirm={confirmReauth}
        onCancel={() => setPending(null)}
        actionLabel="Save alarm rule"
      />
    </div>
  );
}

export default AlarmRulesConfigPage;
