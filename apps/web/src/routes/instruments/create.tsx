import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TokenDialog } from './token-dialog';

interface CreatedInstrument { id: string; code: string; token: string }

export function InstrumentCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedInstrument | null>(null);
  const [form, setForm] = useState({
    name: '', code: '',
    instrumentType: '', manufacturer: '', model: '', serialNumber: '',
    description: '', expectedIntervalSec: '',
    block: '', area: '', location: '',
  });
  const [isGateway, setIsGateway] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(), code: form.code.trim(),
      };
      // Send only what was filled. Posting '' for an optional field would store
      // an empty string where the schema means "not recorded".
      for (const k of ['instrumentType', 'manufacturer', 'model', 'serialNumber', 'description', 'block', 'area', 'location'] as const) {
        if (form[k].trim()) payload[k] = form[k].trim();
      }
      if (form.expectedIntervalSec.trim()) payload.expectedIntervalSec = Number(form.expectedIntervalSec);
      if (isGateway) payload.isGateway = true;

      const res = await apiClient.post<CreatedInstrument>('/api/instruments', payload);
      setCreated(res);
    } catch (err: unknown) {
      const message = (err as { message?: string })?.message ?? 'Could not create the instrument.';
      toast.error('Create failed', message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New Instrument</h1>
        <p className="text-sm text-slate-500">
          Registering an instrument issues its access token. It is shown
          immediately after saving, and can be revealed again later from the
          instrument&apos;s Access token panel — with your password, and recorded
          in the audit trail.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-6">
        <Card>
          <CardHeader><CardTitle>Identity</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Name *</span>
              <Input required value={form.name} onChange={set('name')} placeholder="Cleanroom probe A" />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Instrument ID *</span>
              <Input
                required value={form.code} onChange={set('code')} placeholder="PROBE-A1"
                pattern="[A-Za-z0-9._\-]+"
                title="Letters, digits, dot, dash or underscore only"
              />
              <span className="block text-xs text-slate-500">
                Used in the MQTT topic and as the human reference. Cannot be changed later.
              </span>
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Expected interval (seconds)</span>
              <Input
                type="number" min={1} value={form.expectedIntervalSec}
                onChange={set('expectedIntervalSec')} placeholder="Leave blank to exempt"
              />
            </label>
            <label className="flex items-start gap-2 pt-6 text-sm text-slate-700 sm:col-span-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={isGateway}
                onChange={(e) => setIsGateway(e.target.checked)}
              />
              <span>
                <span className="font-medium">Is Gateway</span>
                <span className="block text-xs text-slate-500">
                  A gateway reports telemetry on behalf of the instruments linked to it.
                </span>
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Placement (optional)</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Block</span>
              <Input value={form.block} onChange={set('block')} />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Area</span>
              <Input value={form.area} onChange={set('area')} />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Location</span>
              <Input value={form.location} onChange={set('location')} />
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Hardware (optional)</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Type</span>
              <Input value={form.instrumentType} onChange={set('instrumentType')} />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Manufacturer</span>
              <Input value={form.manufacturer} onChange={set('manufacturer')} />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Model</span>
              <Input value={form.model} onChange={set('model')} />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Serial number</span>
              <Input value={form.serialNumber} onChange={set('serialNumber')} />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">Description</span>
              <Input value={form.description} onChange={set('description')} />
            </label>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => navigate('/instruments')}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create Instrument'}</Button>
        </div>
      </form>

      {created && (
        <TokenDialog
          open
          title="Instrument created"
          code={created.code}
          token={created.token}
          onClose={() => navigate(`/instruments/${created.id}`)}
        />
      )}
    </div>
  );
}
