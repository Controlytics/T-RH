import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { ALL_RECORDS_PARAM, type DashboardDetail, type DashboardSummary } from '@digilog/shared';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { FormSection } from '@/components/ui/form-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { saveAssignments } from './use-dashboards';

/**
 * Assign (SUPER_ADMIN; design sections 4 and 8): which roles and which users
 * see a dashboard. It starts from `dashboard.assignments` and a save REPLACES
 * them (`PUT /api/dashboards/:id/assignments { roles, userIds }`).
 *
 * Where the options come from:
 *  - roles: `GET /api/roles/active`, the public active-role list the
 *    configuration pickers use. The Users pages' own source,
 *    `/api/roles/:role/creatable`, is a USER_CREATE-gated list of roles the
 *    caller may CREATE (a hierarchy rule), which is not the question here.
 *    SUPER_ADMIN is never offered: it sees every dashboard already.
 *  - users: `GET /api/users` at ALL_RECORDS (the Users list's own param),
 *    enabled only. A user already assigned who has since been disabled stays
 *    listed, so a save does not silently drop them.
 *
 * Assignment grants nothing but sight of the dashboard: what its widgets show
 * is still each viewer's own instrument scope.
 */

interface RoleRow { id?: string; name: string; displayName?: string | null }
interface UserRow { id: string; username: string; fullName?: string | null; role?: string }
type Assignments = NonNullable<DashboardSummary['assignments']>;

export function AssignDialog({ open, dashboard, onClose, onSaved }: {
  open: boolean;
  dashboard: Pick<DashboardDetail, 'id' | 'title' | 'assignments'>;
  onClose: () => void;
  /** Called with the server's answer, `{ roles, users }`. */
  onSaved: (saved: Assignments) => void;
}) {
  // Mounted only while open: every open starts from the stored assignments.
  return open ? <AssignBody dashboard={dashboard} onClose={onClose} onSaved={onSaved} /> : null;
}

const label = (u: UserRow) => (u.fullName ? `${u.fullName} (${u.username})` : u.username);

function AssignBody({ dashboard, onClose, onSaved }: {
  dashboard: Pick<DashboardDetail, 'id' | 'title' | 'assignments'>;
  onClose: () => void;
  onSaved: (saved: Assignments) => void;
}) {
  const [roles, setRoles] = useState<string[]>(dashboard.assignments?.roles ?? []);
  const [userIds, setUserIds] = useState<string[]>(dashboard.assignments?.users.map((u) => u.id) ?? []);
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reauth = useReauth();
  const { toast } = useToast();

  const { data: roleData } = useSWR<RoleRow[]>('/api/roles/active');
  const { data: userData } = useSWR<{ data: UserRow[] }>(`/api/users?${ALL_RECORDS_PARAM}&status=ENABLED`);

  const roleOptions = (roleData ?? []).filter((r) => r.name !== 'SUPER_ADMIN');
  const userOptions = useMemo(() => {
    const fetched = (userData?.data ?? []).filter((u) => u.role !== 'SUPER_ADMIN');
    const known = new Set(fetched.map((u) => u.id));
    const kept = (dashboard.assignments?.users ?? []).filter((u) => !known.has(u.id));
    return [...fetched, ...kept] as UserRow[];
  }, [userData, dashboard.assignments]);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return userOptions;
    return userOptions.filter((u) => {
      const hay = `${u.fullName ?? ''} ${u.username}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [userOptions, query]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const save = () => {
    setProblem(null);
    let saved: Assignments | undefined;
    setBusy(true);
    void reauth.execute('UPDATE_DASHBOARD', async (password?: string) => {
      saved = await saveAssignments(dashboard.id, { roles, userIds }, password);
    }, {
      onSuccess: () => {
        setBusy(false);
        toast.success('Assignments saved', `Who sees "${dashboard.title}" was updated.`);
        if (saved) onSaved(saved);
        onClose();
      },
      onError: (e: unknown) => {
        setBusy(false);
        setProblem((e as { message?: string })?.message || 'Could not save. Please try again.');
      },
      onCancel: () => setBusy(false),
    });
  };

  return (
    <>
      <Dialog open onClose={onClose} className="max-w-2xl">
        <DialogBanner title="Assign dashboard" subtitle={dashboard.title} />
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}>
          <FormSection title="Roles" columns={1}>
            {roleOptions.length === 0 ? (
              <p className="text-sm text-slate-500">No roles to assign.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {roleOptions.map((r) => (
                  <label key={r.name} className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="ctl-check"
                      name={`dashboard-assign-role-${r.name}`}
                      checked={roles.includes(r.name)}
                      onChange={() => toggle(roles, setRoles, r.name)}
                    />
                    {r.displayName || r.name}
                  </label>
                ))}
              </div>
            )}
          </FormSection>

          <FormSection title="Users" columns={1}>
            <Input
              type="search"
              name="dashboard-assign-user-search"
              aria-label="Search users"
              placeholder="Search by name or username"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {shown.length === 0 ? (
                <p className="text-sm text-slate-500">{userOptions.length === 0 ? 'No users to assign.' : 'No user matches.'}</p>
              ) : shown.map((u) => (
                <label key={u.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="ctl-check"
                    name={`dashboard-assign-user-${u.id}`}
                    checked={userIds.includes(u.id)}
                    onChange={() => toggle(userIds, setUserIds, u.id)}
                  />
                  {label(u)}
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500">{roles.length} role(s) and {userIds.length} user(s) selected</p>
          </FormSection>

          {problem && <p role="alert" className="text-sm font-medium text-red-700">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update dashboard"
      />
    </>
  );
}
