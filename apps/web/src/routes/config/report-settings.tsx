import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  REPORT_KINDS, REPORT_APPROVERS_NONE_MESSAGE, coerceReportApprovers, coerceReportDownloads, reportDownloadsRow,
  type ReportDownloadsPolicy, type ReportDownloadMode,
} from '@digilog/shared';
import { PageHero } from '@/components/ui/page-hero';
import { FormSection } from '@/components/ui/form-section';
import { Checkbox } from '@/components/ui/checkbox';
import { Toggle } from '@/components/ui/toggle';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

/**
 * REPORT SETTINGS (2026-10-01) — Report Approvers and Report Downloads on ONE
 * page. Operator: "combine report approvers and report downloads into one
 * configuration".
 *
 * **One screen, two stored rows, unchanged.** The approvers stay
 * `system_config['report-approvers']`, the per-type download settings stay
 * `['report-downloads']`; each is saved through the generic
 * `PUT /api/config/dynamic/<key>`, which validates against the def, enforces
 * SUPER_ADMIN and writes the `CONFIG_CHANGED` audit row. Merging the ROWS would
 * have meant moving data already saved here and on AWS for no gain on screen.
 * Each is PUT only when it changed, and WHOLE — the dynamic PUT replaces the row.
 *
 * **Both saves are signed** (2026-10-12): the two defs carry the server's
 * re-auth action (UPDATE_CONFIG_PAGE), read from the config manifest — never
 * named here — and the saves run through `useReauth().execute`, so a role the
 * Action Re-auth policy asks a password of gets the dialog up front instead of
 * a bare 401 "error". One password covers both PUTs; a PUT that has already
 * gone through is not repeated if the hook replays the callback after a 401.
 *
 * The download table shows each type's EFFECTIVE values (`coerceReportDownloads`,
 * so a type split out of another shows the values it inherits), and a save
 * writes every type's own keys (`reportDownloadsRow`).
 */

interface Role { name: string; displayName?: string }
interface ManifestEntry { moduleKey: string; reauthAction?: string | null }
interface Option { value: string; label: string }
/** Per role and per user id: the Permissions-tab toggles it lacks to approve; empty = it can. */
interface Readiness { roles: Record<string, string[]>; users: Record<string, string[]> }

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function ReportSettingsConfigPage() {
  const { toast } = useToast();
  const reauth = useReauth();
  const { data: manifest } = useSWR<ManifestEntry[]>('/api/config/registry/manifest');
  const { data: approversRow, mutate: mutateApprovers } = useSWR<unknown>('/api/config/dynamic/report-approvers');
  const { data: downloadsRow, mutate: mutateDownloads } = useSWR<unknown>('/api/config/dynamic/report-downloads');
  const { data: rolesData } = useSWR<Role[]>('/api/roles/active');
  const { data: candidates } = useSWR<Option[]>('/api/config/report-approvers/candidates');
  // The SERVER's answer to "can this approver actually approve?" (2026-10-24):
  // the toggles each role / user lacks, by the same check a request applies.
  const { data: readiness } = useSWR<Readiness>('/api/config/report-approvers/readiness');

  const storedApprovers = useMemo(() => (approversRow === undefined ? undefined : coerceReportApprovers(approversRow)), [approversRow]);
  const storedPolicy = useMemo(() => (downloadsRow === undefined ? undefined : coerceReportDownloads(downloadsRow)), [downloadsRow]);

  const [roles, setRoles] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [policy, setPolicy] = useState<ReportDownloadsPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (storedApprovers) { setRoles(storedApprovers.approverRoles); setUserIds(storedApprovers.approverUserIds); } }, [storedApprovers]);
  useEffect(() => { if (storedPolicy) setPolicy(storedPolicy); }, [storedPolicy]);

  const roleOptions = (rolesData ?? []).filter((r) => r.name !== 'SUPER_ADMIN');
  const approversDirty = !!storedApprovers && (!sameSet(roles, storedApprovers.approverRoles) || !sameSet(userIds, storedApprovers.approverUserIds));
  const downloadsDirty = !!storedPolicy && !!policy && JSON.stringify(policy) !== JSON.stringify(storedPolicy);
  const loading = !storedApprovers || !policy;
  const lacking = (missing: string[] | undefined) => (missing && missing.length > 0 ? missing : null);
  const roleLacks = (name: string) => lacking(readiness?.roles[name]);
  const userLacks = (id: string) => lacking(readiness?.users[id]);
  // Ticked, yet not one of them can decide a request: every request from an
  // ordinary user is refused, and a super admin's reaches nobody.
  // A ticked user the server does not list (disabled, deleted) cannot approve either.
  const nobodyCanApprove = !!readiness && roles.length + userIds.length > 0
    && roles.every((r) => roleLacks(r) || !(r in readiness.roles))
    && userIds.every((u) => userLacks(u) || !(u in readiness.users));

  const toggleIn = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const setKind = (key: keyof ReportDownloadsPolicy, patch: Partial<ReportDownloadsPolicy[keyof ReportDownloadsPolicy]>) =>
    setPolicy((p) => (p ? { ...p, [key]: { ...p[key], ...patch } } : p));

  const save = async () => {
    setSaving(true);
    setError('');
    // The server's action for these two rows (they share one); a module whose
    // PUT enforces none still goes through the hook, under a name no policy
    // lists, so a 401 from a stale manifest still opens the dialog.
    const actionOf = (key: string) => manifest?.find((m) => m.moduleKey === key)?.reauthAction ?? null;
    const action = actionOf('report-approvers') ?? actionOf('report-downloads') ?? 'NO_REAUTH_report-settings';
    let approversSaved = false;
    let downloadsSaved = false;
    await reauth.execute(action, async (password?: string) => {
      const signed = (body: Record<string, unknown>) => (password ? { ...body, _currentPassword: password } : body);
      if (approversDirty && !approversSaved) {
        await apiClient.put('/api/config/dynamic/report-approvers', signed({ approverRoles: roles, approverUserIds: userIds }));
        approversSaved = true;
        await mutateApprovers();
      }
      if (downloadsDirty && policy && !downloadsSaved) {
        await apiClient.put('/api/config/dynamic/report-downloads', signed(reportDownloadsRow(policy) as Record<string, unknown>));
        downloadsSaved = true;
        await mutateDownloads();
      }
    }, {
      onSuccess: () => {
        toast.success('Report settings saved', 'Every change is recorded in the audit trail.');
        setSaving(false);
      },
      onError: (e: any) => {
        setError(e?.message ?? 'The settings could not be saved. Please try again.');
        setSaving(false);
      },
      // A cancel is not an error (audit 2026-10-12, finding 10): nothing was sent.
      onCancel: () => setSaving(false),
    });
  };

  return (
    <div className="space-y-6">
      <PageHero
        title="Report Settings"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Report Settings' }]}
        actions={
          <Button onClick={save} disabled={loading || saving || (!approversDirty && !downloadsDirty)}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        }
      />

      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <FormSection title="Approvers" columns={1}>
            <p className="text-sm text-slate-600">
              A report request goes to every holder of a ticked role and every ticked user. Any one of them may approve it.
            </p>
            {roles.length === 0 && userIds.length === 0 && (
              <p role="status" data-testid="no-approver" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {REPORT_APPROVERS_NONE_MESSAGE}
              </p>
            )}
            {nobodyCanApprove && (
              <p role="status" data-testid="no-approver-can-approve" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                None of these approvers can approve a report, so no request will reach anyone. Give their role the
                permissions named below in Roles &amp; Access → Permissions.
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <fieldset className="rounded-[var(--radius-control)] border border-slate-300 p-3">
                <legend className="px-1 text-sm font-semibold text-slate-700">Approver roles</legend>
                <div className="max-h-56 space-y-2.5 overflow-y-auto">
                  {roleOptions.map((r) => (
                    <div key={r.name}>
                      <Checkbox label={r.displayName || r.name} checked={roles.includes(r.name)} onChange={() => toggleIn(roles, setRoles, r.name)} />
                      {roles.includes(r.name) && roleLacks(r.name) && (
                        <p data-testid={`role-cannot-approve-${r.name}`} className="ml-7 text-xs text-amber-700">
                          Cannot approve: needs {roleLacks(r.name)!.join(' and ')}.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
              <fieldset className="rounded-[var(--radius-control)] border border-slate-300 p-3">
                <legend className="px-1 text-sm font-semibold text-slate-700">Approver users</legend>
                <div className="max-h-56 space-y-2.5 overflow-y-auto">
                  {(candidates ?? []).map((u) => (
                    <div key={u.value}>
                      <Checkbox label={u.label} checked={userIds.includes(u.value)} onChange={() => toggleIn(userIds, setUserIds, u.value)} />
                      {userIds.includes(u.value) && userLacks(u.value) && (
                        <p data-testid={`user-cannot-approve-${u.value}`} className="ml-7 text-xs text-amber-700">
                          Cannot approve: their role needs {userLacks(u.value)!.join(' and ')}.
                        </p>
                      )}
                    </div>
                  ))}
                  {/* A saved user who is no longer a candidate (disabled, deleted) still shows, so it can be unticked. */}
                  {userIds.filter((id) => !(candidates ?? []).some((u) => u.value === id)).map((id) => (
                    <Checkbox key={id} label={`${id} (not an active user)`} checked onChange={() => toggleIn(userIds, setUserIds, id)} />
                  ))}
                </div>
              </fieldset>
            </div>
          </FormSection>

          <FormSection title="Downloads by report type" columns={1}>
            <p className="text-sm text-slate-600">
              Direct: the PDF downloads at once. Request approval: it goes to the approvers above and is downloaded, signed, from Reports.
            </p>
            <Table>
              <TableHeader band="gradient">
                <TableRow>
                  <TableHead scope="col">Report</TableHead>
                  <TableHead scope="col">Download mode</TableHead>
                  <TableHead scope="col">Remarks required</TableHead>
                  <TableHead scope="col">Password required</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {REPORT_KINDS.map((k) => (
                  <TableRow key={k.key} data-report-kind={k.key}>
                    <TableCell>
                      <span className="block font-semibold text-slate-800">{k.label}</span>
                      <span className="block text-xs text-slate-500">{k.hint}</span>
                    </TableCell>
                    <TableCell>
                      <Select
                        aria-label={`${k.label} download mode`}
                        value={policy![k.key].mode}
                        onChange={(e) => setKind(k.key, { mode: e.target.value as ReportDownloadMode })}
                      >
                        <option value="DIRECT">Direct download</option>
                        <option value="REQUEST">Request approval</option>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Toggle aria-label={`${k.label} remarks required`} checked={policy![k.key].remarksRequired} onChange={(e) => setKind(k.key, { remarksRequired: e.target.checked })} />
                    </TableCell>
                    <TableCell>
                      <Toggle aria-label={`${k.label} password required`} checked={policy![k.key].passwordRequired} onChange={(e) => setKind(k.key, { passwordRequired: e.target.checked })} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FormSection>
        </>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Save Report Settings"
      />
    </div>
  );
}
