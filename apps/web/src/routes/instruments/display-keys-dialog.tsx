/**
 * The trend page's Keys dialog (widget data keys phase 3, SUPER_ADMIN): which
 * extra keys every instrument of THIS profile shows beside temperature and
 * humidity.
 *
 * The picker reads this instrument's own keys from the server catalogue (a new
 * key appears with its first reading) and refuses what cannot be an extra key
 * here: an attribute (no history) and the two keys the page already draws. The
 * save is the audited, re-auth-gated profile PUT; the busy flag is cleared only
 * by the three outcomes, never after `await reauth.execute(...)`.
 */
import { useState } from 'react';
import { profileDisplayKeysSchema, type DataKeyInfo, type WidgetKey } from '@digilog/shared';
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api-client';
import { KeyPicker } from '@/routes/dashboard/widgets/key-picker';
import { KeyDisplayRows } from '@/routes/dashboard/widgets/key-display-rows';
import { useKeyCatalogue } from '@/routes/dashboard/widgets/use-widget-data';

/** The measurements this page already draws as band gauges and charts. */
const ON_THE_PAGE = new Set(['TEMPERATURE', 'HUMIDITY']);

export interface ProfileForKeys {
  id: string;
  name: string;
  instrumentCount: number;
  displayKeys?: WidgetKey[];
}

export function DisplayKeysDialog({
  open, instrumentId, profile, onClose, onSaved,
}: {
  open: boolean;
  instrumentId: string;
  profile: ProfileForKeys;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [keys, setKeys] = useState<WidgetKey[]>(profile.displayKeys ?? []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { keys: catalogue, loading } = useKeyCatalogue({ instrumentIds: [instrumentId] });
  const reauth = useReauth();
  const { toast } = useToast();

  const refuse = (e: DataKeyInfo) => (e.measurement && ON_THE_PAGE.has(e.measurement.code)
    ? `Already on this page as ${e.measurement.name}` : undefined);
  const measured = (k: WidgetKey) =>
    catalogue.some((e) => e.source === k.source && e.key === k.key && e.measurement !== null);
  const others = catalogue.filter((e) => !(e.measurement && ON_THE_PAGE.has(e.measurement.code)));

  const save = async () => {
    const parsed = profileDisplayKeysSchema.safeParse(keys);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'These keys cannot be saved.');
      return;
    }
    setBusy(true);
    setProblem(null);
    const url = `/api/instrument-profiles/${encodeURIComponent(profile.id)}/display-keys`;
    const body = { displayKeys: parsed.data };
    await reauth.execute('UPDATE_INSTRUMENT_PROFILE', async (password?: string) => {
      if (password) await apiClient.putWithReauth(url, body, password);
      else await apiClient.put(url, body);
    }, {
      onSuccess: () => {
        setBusy(false);
        toast.success('Saved', `The trend page's extra keys for ${profile.name} were updated.`);
        onSaved();
        onClose();
      },
      onError: (err: unknown) => {
        setBusy(false);
        setProblem((err as { message?: string })?.message || 'Could not save the keys.');
      },
      onCancel: () => setBusy(false),
    });
  };

  return (
    <>
      <Dialog open={open} onClose={() => { if (!busy) onClose(); }} className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Extra keys on the trend page</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 text-sm">
          <p className="font-medium text-slate-700">Applies to all {profile.instrumentCount} instruments of {profile.name}</p>
          {loading && catalogue.length === 0 ? (
            <p className="text-xs text-slate-500">Loading keys…</p>
          ) : others.length === 0 && keys.length === 0 ? (
            <p className="text-xs text-slate-500">This instrument has sent no other keys yet.</p>
          ) : (
            <KeyPicker catalogue={catalogue} chosen={keys} onChange={setKeys} type="trend_chart" refuse={refuse} />
          )}
          <KeyDisplayRows keys={keys} measured={measured} onChange={setKeys} />
          {problem && <p role="alert" className="font-medium text-red-700">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save keys'}</Button>
        </DialogFooter>
      </Dialog>
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Trend page keys"
      />
    </>
  );
}
