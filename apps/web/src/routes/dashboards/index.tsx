import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DashboardSummary, DashboardSourceSummary } from '@digilog/shared';
import { PageHero } from '@/components/ui/page-hero';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell, TableEmpty } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LoadError } from '@/components/ui/load-error';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import {
  useDashboards, createDashboard, duplicateDashboard, deleteDashboard, saveDashboard,
} from './use-dashboards';
import { NameDialog, type NameValues } from './name-dialog';

/**
 * Dashboards (2026-10-29, the dashboard builder, design section 8). The list of
 * dashboards a SUPER_ADMIN builds and assigns to roles and users.
 *
 * Who sees what is the SERVER's answer: `GET /api/dashboards` returns every
 * active dashboard to a SUPER_ADMIN and only the assigned ones to anyone else,
 * and sends `assignments` to a SUPER_ADMIN only. This page adds no filter of
 * its own. Hiding New / Duplicate / Rename / Delete and the Assigned-to column
 * from everyone else is presentation; the write routes answer 403
 * (`DASHBOARDS_SUPER_ADMIN_ONLY`) regardless.
 *
 * Every write runs inside `reauth.execute('UPDATE_DASHBOARD', ...)` with all
 * three outcomes handled, then refreshes the list and says so in a toast.
 */

function Svg({ d, className = 'h-3.5 w-3.5' }: { d: string; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={d} />
    </svg>
  );
}
const PATHS = {
  all: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 010 18M12 3a14 14 0 000 18',
  profile: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z',
  location: 'M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z',
  instruments: 'M4 6h16M4 12h16M4 18h10',
  unreadable: 'M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z',
  role: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  copy: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z',
  rename: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
  plus: 'M12 4v16m8-8H4',
  grid: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z',
} as const;

function Chip({ tone, icon, children }: { tone: 'role' | 'user'; icon: string; children: ReactNode }) {
  return (
    <span
      data-chip={tone}
      className={
        tone === 'role'
          ? 'inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-violet-50 px-2 py-0.5 text-[0.75rem] font-semibold text-violet-800 ring-1 ring-inset ring-violet-200'
          : 'inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-slate-100 px-2 py-0.5 text-[0.75rem] font-semibold text-slate-700 ring-1 ring-inset ring-slate-200'
      }
    >
      <Svg d={icon} className="h-3 w-3" />{children}
    </span>
  );
}

function SourceChip({ source }: { source: DashboardSourceSummary }) {
  return (
    <span
      data-testid="source-chip"
      data-mode={source.mode}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--surface-tint-2)] px-2.5 py-1 text-[0.8125rem] font-semibold text-[var(--theme-primary-dark,#1e3a5f)] ring-1 ring-inset ring-cyan-200"
    >
      <Svg d={PATHS[source.mode]} />{source.label}
    </span>
  );
}

function IconAction({ label, d, danger, onClick }: { label: string; d: string; danger?: boolean; onClick: () => void }) {
  return (
    <Button
      type="button" variant="ghost" title={label} aria-label={label} onClick={onClick}
      className={danger ? 'h-8 w-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700' : 'h-8 w-8'}
    >
      <Svg d={d} className="h-4 w-4" />
    </Button>
  );
}

type Dialogs =
  | { kind: 'new' }
  | { kind: 'rename'; row: DashboardSummary }
  | { kind: 'delete'; row: DashboardSummary }
  | null;

export function DashboardsPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const { rows, loading, error, mutate } = useDashboards();
  const { formatDate, formatTime } = useDatetimeFormat();
  const { toast } = useToast();
  const navigate = useNavigate();
  const reauth = useReauth();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reason = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback;
  const closeDialog = () => { setDialog(null); setFormError(null); };

  /**
   * ONE runner for every write. `busy` is cleared by the three outcomes only,
   * never after `await reauth.execute(...)`, which returns as soon as the
   * password dialog opens. `inForm` says where a refusal is shown: beside the
   * field of an open form, or as a toast for a row action (Duplicate) and the
   * Delete confirm, which closes on failure.
   */
  const write = (
    run: (password?: string) => Promise<unknown>,
    done: (result: unknown) => void | Promise<void>,
    failTitle: string,
    inForm: boolean,
  ) => {
    setBusy(true);
    setFormError(null);
    void reauth.execute('UPDATE_DASHBOARD', async (password?: string) => {
      const result = await run(password);
      await done(result);
    }, {
      onSuccess: () => setBusy(false),
      onError: (e: unknown) => {
        setBusy(false);
        if (inForm) setFormError(reason(e, 'Please try again.'));
        else { setDialog(null); toast.error(failTitle, reason(e, 'Please try again.')); }
      },
      onCancel: () => setBusy(false),
    });
  };

  const create = (v: NameValues) => write(
    (password) => createDashboard({ title: v.title, ...(v.description && { description: v.description }) }, password),
    async (created) => {
      const { id, title } = created as { id: string; title: string };
      setDialog(null);
      await mutate();
      toast.success('Dashboard created', `"${title}" is empty. Add widgets to it.`);
      navigate(`/dashboards/${id}?edit=1`);
    },
    'Could not create',
    true,
  );

  const rename = (row: DashboardSummary, v: NameValues) => write(
    (password) => saveDashboard(row.id, { title: v.title, description: v.description || null, expectedUpdatedAt: row.updatedAt }, password),
    async () => {
      setDialog(null);
      await mutate();
      toast.success('Dashboard renamed', `"${v.title}" saved.`);
    },
    'Could not rename',
    true,
  );

  const duplicate = (row: DashboardSummary) => write(
    (password) => duplicateDashboard(row.id, password),
    async (copy) => {
      await mutate();
      toast.success('Dashboard duplicated', `"${(copy as { title?: string })?.title ?? row.title}" created from "${row.title}".`);
    },
    'Could not duplicate',
    false,
  );

  const remove = (row: DashboardSummary) => write(
    (password) => deleteDashboard(row.id, password),
    async () => {
      setDialog(null);
      await mutate();
      toast.success('Dashboard deleted', `"${row.title}" removed.`);
    },
    'Could not delete',
    false,
  );

  const columns = isSuperAdmin ? 6 : 4;

  return (
    <div className="space-y-6">
      <PageHero
        title="Dashboards"
        icon={<Svg d={PATHS.grid} className="h-5 w-5" />}
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Dashboards' }]}
        actions={isSuperAdmin ? (
          <Button type="button" variant="outline" className="h-10 px-4 font-semibold" onClick={() => setDialog({ kind: 'new' })}>
            <Svg d={PATHS.plus} className="h-4 w-4" />New dashboard
          </Button>
        ) : undefined}
      />

      {error ? <LoadError what="dashboards" error={error} /> : loading && rows.length === 0 ? <SkeletonRows rows={5} columns={columns} /> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Instruments</TableHead>
              <TableHead className="text-center">Widgets</TableHead>
              {isSuperAdmin && <TableHead>Assigned to</TableHead>}
              <TableHead>Updated</TableHead>
              {isSuperAdmin && <TableHead className="w-[10rem]"><span className="sr-only">Actions</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmpty
                colSpan={columns}
                title={isSuperAdmin ? 'No dashboards yet. Create the first one.' : 'No dashboard has been assigned to you.'}
              />
            ) : rows.map((row) => {
              const roles = row.assignments?.roles ?? [];
              const users = row.assignments?.users ?? [];
              return (
                <TableRow key={row.id} data-testid="dashboard-row">
                  <TableCell>
                    <Link to={`/dashboards/${row.id}`} className="block font-bold text-[var(--theme-primary-dark,#1e3a5f)] hover:underline">{row.title}</Link>
                    {row.description && <span className="block text-[0.8125rem] text-slate-500">{row.description}</span>}
                  </TableCell>
                  <TableCell><SourceChip source={row.sourceSummary} /></TableCell>
                  <TableCell className="text-center text-[1.0625rem] font-bold tabular-nums text-slate-900">{row.widgetCount}</TableCell>
                  {isSuperAdmin && (
                    <TableCell>
                      {roles.length + users.length === 0 ? (
                        <span className="text-[0.8125rem] italic text-slate-400">Not assigned</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {roles.map((r) => <Chip key={`r-${r}`} tone="role" icon={PATHS.role}>{r}</Chip>)}
                          {users.map((u) => <Chip key={`u-${u.id}`} tone="user" icon={PATHS.user}>{u.fullName || u.username}</Chip>)}
                        </div>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="whitespace-nowrap">
                    <span className="block font-semibold text-slate-800">{formatDate(row.updatedAt)}</span>
                    <span className="block text-[0.8125rem] text-slate-500">{formatTime(row.updatedAt)}</span>
                  </TableCell>
                  {isSuperAdmin && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <IconAction label="Duplicate" d={PATHS.copy} onClick={() => duplicate(row)} />
                        <IconAction label="Rename" d={PATHS.rename} onClick={() => setDialog({ kind: 'rename', row })} />
                        <IconAction label="Delete" d={PATHS.trash} danger onClick={() => setDialog({ kind: 'delete', row })} />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <NameDialog
        open={dialog?.kind === 'new' || dialog?.kind === 'rename'}
        mode={dialog?.kind === 'rename' ? 'rename' : 'new'}
        initial={dialog?.kind === 'rename' ? { title: dialog.row.title, description: dialog.row.description ?? '' } : undefined}
        busy={busy}
        error={formError}
        onClose={closeDialog}
        onSubmit={(v) => (dialog?.kind === 'rename' ? rename(dialog.row, v) : create(v))}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="Delete dashboard"
        message={dialog?.kind === 'delete' ? <>Delete the dashboard <strong>&quot;{dialog.row.title}&quot;</strong>?</> : ''}
        warning="Its widgets and assignments go with it. Anyone it was assigned to stops seeing it. This cannot be undone."
        confirmLabel="Delete dashboard"
        busyLabel="Deleting…"
        busy={busy}
        onConfirm={() => { if (dialog?.kind === 'delete') remove(dialog.row); }}
        onClose={closeDialog}
      />
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
    </div>
  );
}
