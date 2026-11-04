import { useEffect, useId, useState } from 'react';
import { RULE_CHAIN_NAME_MAX } from '@digilog/shared';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReauthDialog } from '@/components/reauth-dialog';
import { ImportFileError, readImportFile } from './import-export';
import { ReasonDialog, useChainWrites } from './reason-dialog';
import { importRuleChain } from './use-rule-chains';
import type { RuleChainImportResult } from './types';

/**
 * Import a ThingsBoard rule chain export (rule chains, 2026-11-04). The file is
 * read here only to check it is a rule chain export and to prefill the name;
 * the SERVER maps ThingsBoard's node classes onto this system's and answers
 * with warnings (a node with no counterpart here, a credential masked on
 * export that must be entered again). The chain is created as a NEW chain,
 * never the root. A name already taken is a 409 the dialog shows in place.
 */
export function ImportDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  /** After a 201: the new chain's id and the server's warnings. */
  onImported: (result: RuleChainImportResult, name: string) => void;
}) {
  const fileId = useId();
  const nameId = useId();
  const writes = useChainWrites();
  const [json, setJson] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [warnings, setWarnings] = useState<{ result: RuleChainImportResult; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setJson(null); setFileName(''); setFileError(null); setName(''); setWarnings(null); writes.setError(null);
    // Reset on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = async (file: File | undefined) => {
    setJson(null);
    setFileError(null);
    setFileName(file?.name ?? '');
    if (!file) return;
    try {
      const read = await readImportFile(file);
      setJson(read.json);
      if (read.name) setName(read.name);
    } catch (e) {
      setFileError(e instanceof ImportFileError ? e.message : 'The file could not be read.');
    }
  };

  const submit = (reason: string) => {
    const chosen = name.trim();
    writes.run(
      (password) => importRuleChain({ json, ...(chosen && { name: chosen }) }, reason, password),
      {
        done: (result) => {
          const r = result as RuleChainImportResult;
          if (r.warnings.length > 0) setWarnings({ result: r, name: chosen });
          else onImported(r, chosen);
        },
      },
    );
  };

  if (warnings) {
    return (
      <Dialog open={open} onClose={() => onImported(warnings.result, warnings.name)} className="max-w-xl">
        <DialogBanner title="Imported, with warnings" subtitle={warnings.name || undefined} />
        <p className="text-sm text-slate-600">
          The chain was created. Read these before switching it on — each one is a node that will send its messages to Failure until it is fixed.
        </p>
        <ul data-testid="import-warnings" className="mt-3 max-h-72 list-disc space-y-1.5 overflow-y-auto pl-5 text-sm text-amber-900">
          {warnings.result.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
        <DialogFooter>
          <Button type="button" onClick={() => onImported(warnings.result, warnings.name)}>Open the chain</Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <>
      <ReasonDialog
        open={open}
        title="Import rule chain"
        subtitle="ThingsBoard JSON export"
        confirmLabel="Import"
        busyLabel="Importing…"
        busy={writes.busy}
        error={writes.error}
        canConfirm={json !== null && name.trim() !== ''}
        onConfirm={submit}
        onClose={onClose}
      >
        <div className="space-y-1">
          <label htmlFor={fileId} className="block text-sm font-semibold text-slate-700">File</label>
          <input
            id={fileId}
            type="file"
            accept=".json,application/json"
            disabled={writes.busy}
            onChange={(e) => { void pick(e.target.files?.[0]); }}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
          />
          {fileName && !fileError && json !== null && <p className="text-xs text-emerald-700">{fileName} is a rule chain export.</p>}
          {fileError && <p role="alert" className="text-xs text-rose-700">{fileError}</p>}
        </div>
        <div className="space-y-1">
          <label htmlFor={nameId} className="block text-sm font-semibold text-slate-700">Name</label>
          <Input
            id={nameId}
            value={name}
            maxLength={RULE_CHAIN_NAME_MAX}
            disabled={writes.busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="The name of the new chain"
          />
          <p className="text-xs text-slate-500">Imported as a new chain, not the root. A name already in use is refused.</p>
        </div>
      </ReasonDialog>
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
    </>
  );
}
