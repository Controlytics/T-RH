/**
 * Save as role default — how a SUPER_ADMIN shares an arrangement, built widgets
 * included, with every user of a role (spec §6.1). Through the existing audited,
 * re-auth-gated `PUT /api/roles/dashboard-layout/role/:name`; the server refuses
 * anyone but a SUPER_ADMIN changing widgets, so this dialog is presentation.
 *
 * The busy flag is cleared ONLY by the three outcomes, never after `await
 * reauth.execute(...)`, which returns as soon as the password dialog opens.
 */
import { useState } from 'react';
import useSWR from 'swr';
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';

interface RoleRow { name: string; displayName?: string | null }

export function RoleDefaultDialog({
  open, onClose, onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (role: string, password?: string) => Promise<void>;
}) {
  const { data } = useSWR<RoleRow[] | { data: RoleRow[] }>(open ? '/api/roles' : null);
  const roles = (Array.isArray(data) ? data : data?.data ?? []).filter((r) => r.name !== 'SUPER_ADMIN');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reauth = useReauth();
  const { toast } = useToast();

  const save = async () => {
    if (!role) { setError('Choose a role.'); return; }
    setBusy(true);
    setError(null);
    await reauth.execute('UPDATE_ROLE_CONFIG', async (password?: string) => {
      await onSave(role, password);
    }, {
      onSuccess: () => {
        setBusy(false);
        toast.success('Saved', `This arrangement is now the default for ${role}.`);
        onClose();
      },
      onError: (err: unknown) => {
        setBusy(false);
        setError((err as { message?: string })?.message || 'Could not save the role default.');
      },
      onCancel: () => setBusy(false),
    });
  };

  return (
    <>
      <Dialog open={open} onClose={onClose}>
        <DialogHeader>
          <DialogTitle>Save as role default</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">
            Every user of this role sees this arrangement, and its built widgets wherever their Panels include Built widgets.
          </p>
          <label className="block">
            <span className="mb-1 block font-medium text-slate-700">Role</span>
            <select aria-label="Role" className="ctl w-full" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Choose a role</option>
              {roles.map((r) => <option key={r.name} value={r.name}>{r.displayName || r.name}</option>)}
            </select>
          </label>
          {error && <p role="alert" className="font-medium text-red-700">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save as role default'}</Button>
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
        actionLabel="Dashboard role default"
      />
    </>
  );
}
