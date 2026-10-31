import { useState } from 'react';
import { MODBUS_INTERVAL, MODBUS_UNIT_ID } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { FormSection } from '@/components/ui/form-section';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api-client';
import { ModbusReadingFields } from './modbus-reading-fields';

/**
 * A TCP/IP (Modbus) profile's reading settings: how often the server reads each
 * instrument, and the Modbus unit id. Drawn only for a profile whose `connection`
 * the server reports as MODBUS_TCP (the connection is chosen at creation; there
 * is no switch here). A save sends only what changed, through the profile PUT
 * under UPDATE_INSTRUMENT_PROFILE, and the API's refusal is shown as it comes —
 * the browser enforces no range of its own.
 */
export function ProfileTcpIpReading({ profile, onSaved }: {
  profile: { id: string; name: string; modbusIntervalSec?: number | null; modbusUnitId?: number | null };
  onSaved: () => void;
}) {
  const reauth = useReauth();
  const { toast } = useToast();
  const storedInterval = profile.modbusIntervalSec ?? MODBUS_INTERVAL.default;
  const storedUnit = profile.modbusUnitId ?? MODBUS_UNIT_ID.default;
  const [intervalSec, setIntervalSec] = useState<number>(storedInterval);
  const [unitId, setUnitId] = useState<string>(String(storedUnit));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unitChanged = unitId.trim() !== '' && Number(unitId) !== storedUnit;
  const intervalChanged = intervalSec !== storedInterval;
  const dirty = (intervalChanged || unitChanged) && unitId.trim() !== '';

  const save = async () => {
    const body = {
      ...(intervalChanged ? { modbusIntervalSec: intervalSec } : {}),
      ...(unitChanged ? { modbusUnitId: Number(unitId) } : {}),
    };
    setSaving(true);
    setError(null);
    let done = false;
    await reauth.execute('UPDATE_INSTRUMENT_PROFILE', async (password?: string) => {
      if (done) return;
      if (password) await apiClient.putWithReauth(`/api/instrument-profiles/${profile.id}`, body, password);
      else await apiClient.put(`/api/instrument-profiles/${profile.id}`, body);
      done = true;
    }, {
      onSuccess: () => {
        setSaving(false);
        onSaved();
        toast.success('TCP/IP reading saved', `${profile.name} is now read as set here.`);
      },
      onError: (err: unknown) => {
        setSaving(false);
        const message = (err as { message?: string })?.message ?? 'Nothing was changed.';
        setError(message);
        toast.error('Could not save', message);
      },
      onCancel: () => setSaving(false),
    });
  };

  return (
    <>
      <FormSection
        title="TCP/IP reading"
        columns={1}
        actions={(
          <Button type="button" variant="secondary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save TCP/IP reading'}
          </Button>
        )}
      >
        <ModbusReadingFields
          idPrefix={`profile-${profile.id}`}
          intervalSec={intervalSec}
          unitId={unitId}
          onIntervalChange={setIntervalSec}
          onUnitIdChange={setUnitId}
        />
        <p className="text-xs text-slate-500">For every instrument in this profile. Keys are set on each instrument.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      </FormSection>
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
    </>
  );
}
