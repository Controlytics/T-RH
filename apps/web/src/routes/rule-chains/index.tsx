import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RULE_CHAIN_NAME_MAX } from '@digilog/shared';
import { PageHero } from '@/components/ui/page-hero';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell, TableEmpty } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadError } from '@/components/ui/load-error';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import {
  createRuleChain, deleteRuleChain, makeRootRuleChain, useRuleChains, useRuleEngineStats,
} from './use-rule-chains';
import { downloadChainExport } from './import-export';
import { ImportDialog } from './import-dialog';
import { ReasonDialog, refusalText, useChainWrites } from './reason-dialog';
import { StatsBanner, statsTiles } from './stats-banner';
import type { RuleChainSummary } from './types';
import { PATHS, RootBadge, Svg } from './icons';

/**
 * Rule Chains (rule chains, 2026-11-04; spec section 11) — the list, and the
 * engine's figures. Everything shown is the server's: the chains as `GET
 * /api/rule-chains` returns them (root first), the stats as `/stats` returns
 * them. Writes are offered to a RULE_CHAIN_MANAGE holder (`useCan('rule_chains.manage')`,
 * the tree node's discriminating gate); the route's 403 is the control.
 * Every write carries a reason and runs in `reauth.execute('UPDATE_RULE_CHAIN', …)`.
 */

/** A row's icon-only action — `size="icon-sm"` keeps the icon visible (see the dashboards list). */
function IconAction({ label, d, danger, disabled, onClick }: { label: string; d: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Button
      type="button" variant="ghost" size="icon-sm" title={label} aria-label={label} disabled={disabled} onClick={onClick}
      className={danger ? 'text-rose-600 hover:bg-rose-50 hover:text-rose-700' : undefined}
    >
      <Svg d={d} />
    </Button>
  );
}

type Dialogs =
  | { kind: 'new' }
  | { kind: 'import' }
  | { kind: 'root'; row: RuleChainSummary }
  | { kind: 'delete'; row: RuleChainSummary }
  | null;

export function RuleChainsPage() {
  const can = useCan();
  const canManage = can('rule_chains.manage');
  const { rows, loading, error, mutate } = useRuleChains();
  const { stats } = useRuleEngineStats();
  const { formatDate, formatTime } = useDatetimeFormat();
  const { toast } = useToast();
  const navigate = useNavigate();
  const writes = useChainWrites();
  const nameId = useId();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [name, setName] = useState('');
  const [exporting, setExporting] = useState<string | null>(null);

  const open = (d: Dialogs) => { writes.setError(null); setName(''); setDialog(d); };
  const close = () => { if (!writes.busy) setDialog(null); };

  const create = (reason: string) => writes.run(
    (pw) => createRuleChain({ name: name.trim() }, reason, pw),
    {
      done: async (created) => {
        const { id } = created as { id: string };
        setDialog(null);
        await mutate();
        toast.success('Rule chain created', `"${name.trim()}" is empty. Drag nodes onto it.`);
        navigate(`/rule-chains/${id}`);
      },
    },
  );

  const makeRoot = (row: RuleChainSummary, reason: string) => writes.run(
    (pw) => makeRootRuleChain(row.id, reason, pw),
    {
      done: async () => {
        setDialog(null);
        await mutate();
        toast.success('Root chain changed', `Every message now enters "${row.name}".`);
      },
    },
  );

  const remove = (row: RuleChainSummary, reason: string) => writes.run(
    (pw) => deleteRuleChain(row.id, reason, pw),
    {
      done: async () => {
        setDialog(null);
        await mutate();
        toast.success('Rule chain deleted', `"${row.name}" removed.`);
      },
    },
  );

  const exportRow = async (row: RuleChainSummary) => {
    setExporting(row.id);
    try {
      const file = await downloadChainExport(row.id, row.name);
      toast.success('Exported', `${file} — credentials are masked in the file.`);
    } catch (e) {
      toast.error('Could not export', refusalText(e));
    } finally {
      setExporting(null);
    }
  };

  const columns = 4;

  return (
    <div className="space-y-6">
      <PageHero
        title="Rule Chains"
        icon={<Svg d={PATHS.chain} className="h-5 w-5" />}
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Rule Chains' }]}
        tiles={statsTiles(stats)}
        actions={canManage ? (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="h-10 px-4 font-semibold" onClick={() => open({ kind: 'import' })}>
              <Svg d={PATHS.upload} />Import chain
            </Button>
            <Button type="button" variant="outline" className="h-10 px-4 font-semibold" onClick={() => open({ kind: 'new' })}>
              <Svg d={PATHS.plus} />New rule chain
            </Button>
          </div>
        ) : undefined}
      />

      <StatsBanner stats={stats} />

      {error ? <LoadError what="rule chains" error={error} /> : loading && rows.length === 0 ? <SkeletonRows rows={4} columns={columns} /> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-center">Nodes</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-[11rem]"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmpty colSpan={columns} title="No rule chains." />
            ) : rows.map((row) => (
              <TableRow key={row.id} data-testid="rule-chain-row">
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/rule-chains/${row.id}`} className="font-bold text-[var(--theme-primary-dark,#1e3a5f)] hover:underline">{row.name}</Link>
                    {row.root && <RootBadge />}
                  </div>
                </TableCell>
                <TableCell className="text-center text-[1.0625rem] font-bold tabular-nums text-slate-900">{row.nodeCount}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="block font-semibold text-slate-800">{formatDate(row.updatedAt)} {formatTime(row.updatedAt)}</span>
                  <span className="block text-[0.8125rem] text-slate-500">by {row.updatedBy ?? 'System'}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <IconAction label="Open" d={PATHS.open} onClick={() => navigate(`/rule-chains/${row.id}`)} />
                    <IconAction label="Export" d={PATHS.download} disabled={exporting === row.id} onClick={() => { void exportRow(row); }} />
                    {canManage && (row.root ? (
                      // The root can be neither made root nor deleted: two empty
                      // slots keep every row's icons in the same columns.
                      <span aria-hidden className="inline-block w-[4.25rem]" />
                    ) : (
                      <>
                        <IconAction label="Make root" d={PATHS.root} disabled={writes.busy} onClick={() => open({ kind: 'root', row })} />
                        <IconAction label="Delete" d={PATHS.trash} danger disabled={writes.busy} onClick={() => open({ kind: 'delete', row })} />
                      </>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ReasonDialog
        open={dialog?.kind === 'new'}
        title="New rule chain"
        confirmLabel="Create"
        busyLabel="Creating…"
        busy={writes.busy}
        error={writes.error}
        canConfirm={name.trim() !== ''}
        onConfirm={create}
        onClose={close}
      >
        <div className="space-y-1">
          <label htmlFor={nameId} className="block text-sm font-semibold text-slate-700">Name</label>
          <Input id={nameId} value={name} maxLength={RULE_CHAIN_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cold room alarms" />
        </div>
      </ReasonDialog>

      <ReasonDialog
        open={dialog?.kind === 'root'}
        title="Make root chain"
        subtitle={dialog?.kind === 'root' ? dialog.row.name : undefined}
        confirmLabel="Make root chain"
        busyLabel="Changing…"
        busy={writes.busy}
        error={writes.error}
        onConfirm={(reason) => { if (dialog?.kind === 'root') makeRoot(dialog.row, reason); }}
        onClose={close}
      >
        <p className="text-sm text-slate-600">
          Every reading, attribute report and alarm enters the root chain. Making this chain the root stops them entering the current one.
        </p>
      </ReasonDialog>

      <ReasonDialog
        open={dialog?.kind === 'delete'}
        title="Delete rule chain"
        subtitle={dialog?.kind === 'delete' ? dialog.row.name : undefined}
        confirmLabel="Delete rule chain"
        busyLabel="Deleting…"
        danger
        busy={writes.busy}
        error={writes.error}
        onConfirm={(reason) => { if (dialog?.kind === 'delete') remove(dialog.row, reason); }}
        onClose={close}
      >
        <p className="text-sm text-slate-600">
          Its nodes, links and debug events go with it. A chain another chain calls cannot be deleted. This cannot be undone.
        </p>
      </ReasonDialog>

      {canManage && (
        <ImportDialog
          open={dialog?.kind === 'import'}
          onClose={() => setDialog(null)}
          onImported={(result, importedName) => {
            setDialog(null);
            void mutate();
            toast.success('Rule chain imported', `"${importedName}" created.`);
            navigate(`/rule-chains/${result.id}`);
          }}
        />
      )}

      <ReauthDialog
        open={writes.reauth.isOpen}
        password={writes.reauth.password}
        error={writes.reauth.error}
        isVerifying={writes.reauth.isVerifying}
        onPasswordChange={writes.reauth.setPassword}
        onConfirm={writes.reauth.confirm}
        onCancel={writes.reauth.cancel}
        actionLabel={writes.actionLabel}
      />
    </div>
  );
}
