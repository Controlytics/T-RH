import { useState } from 'react';
import { Toggle } from '@/components/ui/toggle';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api-client';
import { RemarkDialog } from '@/routes/instruments/remark-dialog';

/**
 * The profile's "Require device certificate" switch (2026-10-27). Every
 * instrument of a profile with it ON is refused on every ingest channel
 * unless its device connects with its own certificate (issued on the
 * instrument's page).
 *
 * The server decides everything: super admin only, a reason, and ON refused
 * while the server has no device CA (its message is shown as it comes). The
 * toggle commits through a reason dialog — it does not move until the save
 * succeeds — and the count it reports (instruments with no certificate yet,
 * whose data is refused from now on) is the server's.
 */
export interface ProfileDeviceCertificateSwitchProps {
  profile: { id: string; name: string; requireDeviceCertificate?: boolean };
  onSaved: () => void;
}

export function ProfileDeviceCertificateSwitch({ profile, onSaved }: ProfileDeviceCertificateSwitchProps) {
  const reauth = useReauth();
  const { toast } = useToast();
  const stored = profile.requireDeviceCertificate === true;
  const [pending, setPending] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [withoutCertificate, setWithoutCertificate] = useState<number | null>(null);
  const [gateways, setGateways] = useState<{ code: string; certificateIssued: boolean }[]>([]);

  const save = async (next: boolean, reason: string) => {
    setSaving(true);
    const body = { requireDeviceCertificate: next, reason };
    let res: {
      instrumentsWithoutCertificate?: number | null;
      gatewaysNeedingCertificate?: { code: string; certificateIssued: boolean }[] | null;
    } | undefined;
    await reauth.execute('UPDATE_INSTRUMENT_PROFILE', async (password?: string) => {
      if (res) return;
      res = password
        ? await apiClient.putWithReauth(`/api/instrument-profiles/${profile.id}`, body, password)
        : await apiClient.put(`/api/instrument-profiles/${profile.id}`, body);
    }, {
      onSuccess: () => {
        setSaving(false);
        setPending(null);
        setWithoutCertificate(next ? (res?.instrumentsWithoutCertificate ?? null) : null);
        setGateways(next ? (res?.gatewaysNeedingCertificate ?? []) : []);
        onSaved();
        toast.success(
          next ? 'Device certificates required' : 'Device certificates no longer required',
          `${profile.name}: ${next ? 'instruments must now connect with their own certificate.' : 'instruments connect as before.'}`,
        );
      },
      onError: (err: unknown) => {
        setSaving(false);
        setPending(null);
        toast.error('Could not save', (err as { message?: string })?.message ?? 'Nothing was changed.');
      },
      onCancel: () => { setSaving(false); setPending(null); },
    });
  };

  return (
    <div className="space-y-2">
      <Toggle
        checked={stored}
        disabled={saving}
        onChange={(e) => setPending(e.target.checked)}
        label="Require device certificate"
        helper="Every instrument of this profile must connect with its own client certificate (issued on the instrument's page). Data sent without it is refused on HTTPS, MQTT, WebSocket and TCP."
      />
      {withoutCertificate !== null && withoutCertificate > 0 && (
        <p role="status" className="text-sm font-medium text-amber-700">
          {withoutCertificate === 1
            ? '1 instrument has no certificate yet — its data will be refused.'
            : `${withoutCertificate} instruments have no certificate yet — their data will be refused.`}
        </p>
      )}
      {gateways.length > 0 && (
        // The blast radius the count above cannot show: a gateway reporting
        // for one of these instruments must present its OWN certificate, and
        // is refused on MQTT (with every instrument it carries) until it does.
        <div role="status" className="text-sm text-amber-800">
          <p className="font-medium">Gateways that must now present their own certificate:</p>
          <ul className="ml-4 list-disc">
            {gateways.map((g) => (
              <li key={g.code}>
                {g.code} ({g.certificateIssued ? 'issued' : 'none issued — refused on MQTT until one is'})
              </li>
            ))}
          </ul>
        </div>
      )}
      <RemarkDialog
        open={pending !== null}
        attributeKey="Require device certificate"
        from={stored ? 'On' : 'Off'}
        to={pending ? 'On' : 'Off'}
        title={`${pending ? 'Require' : 'Stop requiring'} device certificates for ${profile.name}`}
        busy={saving}
        onSubmit={(reason) => { if (pending !== null) void save(pending, reason); }}
        onClose={() => { if (!saving) setPending(null); }}
      />
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update Instrument Profile"
      />
    </div>
  );
}
