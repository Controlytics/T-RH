import { useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { apiClient } from '@/lib/api-client';

/**
 * The instrument's DEVICE CERTIFICATE (2026-10-27): the one client certificate
 * its device may present when its profile requires one (spec
 * docs/superpowers/specs/2026-10-27-device-certificates-design.md).
 *
 * Presentation over the server's answer: whether the server can issue one at
 * all (`available`), whether the profile requires it (`required`) and what is
 * issued come from GET /:id/device-certificate — nothing here decides them.
 *
 * Issue / Re-issue / Revoke are `enforceReauthAlways` server-side, like the
 * token: the first request goes out without a password, the 401 opens the
 * dialog and `execute` replays it. Issuing returns the bundle ONCE — the
 * private key is never kept by the server — so it is downloaded at once.
 */
interface Issued { issueId: string; fingerprint: string; issuedAt: string; issuedBy: string | null; notAfter: string }
interface Status { available: boolean; required: boolean; profileName: string; issued: Issued | null }
interface IssueResponse { issued: Issued; fileName: string; bundle: string }

function downloadBase64Zip(base64: string, fileName: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function DeviceCertificateCard({ instrumentId, canManage }: { instrumentId: string; canManage: boolean }) {
  const url = `/api/instruments/${instrumentId}/device-certificate`;
  const { data, mutate } = useSWR<Status>(url);
  const reauth = useReauth();
  const { toast } = useToast();
  const { formatDate, formatTime } = useDatetimeFormat();
  const [busy, setBusy] = useState(false);
  const [justIssued, setJustIssued] = useState(false);
  const [label, setLabel] = useState('Issue Device Certificate');

  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!data.available) {
    return <p className="text-sm text-slate-500">Device certificates are not set up on this server.</p>;
  }

  const issue = async () => {
    setLabel(data.issued ? 'Re-issue Device Certificate' : 'Issue Device Certificate');
    setBusy(true);
    let done = false;
    await reauth.execute('ISSUE_DEVICE_CERTIFICATE', async (password?: string) => {
      if (done) return;
      const res = password
        ? await apiClient.postWithReauth<IssueResponse>(url, {}, password)
        : await apiClient.post<IssueResponse>(url, {});
      done = true;
      downloadBase64Zip(res.bundle, res.fileName);
      setJustIssued(true);
      void mutate();
    }, {
      onSuccess: () => setBusy(false),
      onCancel: () => setBusy(false),
      onError: (err: unknown) => {
        setBusy(false);
        toast.error('Could not issue the certificate', (err as { message?: string })?.message ?? 'Nothing was issued.');
      },
    });
  };

  const revoke = async () => {
    setLabel('Revoke Device Certificate');
    setBusy(true);
    let done = false;
    await reauth.execute('REVOKE_DEVICE_CERTIFICATE', async (password?: string) => {
      if (done) return;
      if (password) await apiClient.deleteWithReauth(url, password);
      else await apiClient.delete(url);
      done = true;
      setJustIssued(false);
      void mutate();
    }, {
      onSuccess: () => setBusy(false),
      onCancel: () => setBusy(false),
      onError: (err: unknown) => {
        setBusy(false);
        toast.error('Could not revoke the certificate', (err as { message?: string })?.message ?? 'Nothing was changed.');
      },
    });
  };

  const { issued, required, profileName } = data;
  return (
    <div className="space-y-3 text-sm">
      <p className={required ? 'font-medium text-amber-700' : 'text-slate-600'}>
        {required ? `Required by profile ${profileName}` : `Not required by profile ${profileName}`}
      </p>

      {issued ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-slate-500">Issued</dt>
          <dd className="text-slate-800">
            {formatDate(issued.issuedAt)} {formatTime(issued.issuedAt)}{issued.issuedBy ? ` by ${issued.issuedBy}` : ''}
          </dd>
          <dt className="text-slate-500">Expires</dt>
          <dd className="text-slate-800">{formatDate(issued.notAfter)}</dd>
          <dt className="text-slate-500">Fingerprint</dt>
          <dd className="font-mono text-xs text-slate-700" title={issued.fingerprint}>{issued.fingerprint.slice(0, 16)}…</dd>
        </dl>
      ) : (
        <p className={required ? 'font-medium text-red-700' : 'text-slate-500'}>
          {required ? 'Not issued — this instrument\'s data is being refused.' : 'Not issued.'}
        </p>
      )}

      {justIssued && (
        <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">
          The private key is not kept — store this file safely. Load client.crt and client.key into the device.
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {issued ? (
            <>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void issue()}>Re-issue</Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void revoke()}>Revoke</Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void issue()}>Issue certificate</Button>
          )}
        </div>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel={label}
      />
    </div>
  );
}
