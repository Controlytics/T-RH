import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TRANSPORTS } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TokenDialog } from './token-dialog';

interface CreatedInstrument { id: string; code: string; transport: string; token: string }

export function InstrumentCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedInstrument | null>(null);
  const [form, setForm] = useState({
    name: '', code: '', transport: 'http',
    instrumentType: '', manufacturer: '', model: '', serialNumber: '',
    description: '', expectedIntervalSec: '',
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(), code: form.code.trim(), transport: form.transport,
      };
      // Send only what was filled. Posting '' for an optional field would store
      // an empty string where the schema means "not recorded".
      for (const k of ['instrumentType', 'manufacturer', 'model', 'serialNumber', 'description'] as const) {
        if (form[k].trim()) payload[k] = form[k].trim();
      }
      if (form.expectedIntervalSec.trim()) payload.expectedIntervalSec = Number(form.expectedIntervalSec);

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
          Registering an instrument issues its access token. The token is shown
          once, immediately after saving, and cannot be retrieved afterwards.
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
              <span className="text-sm font-medium text-slate-700">Code *</span>
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
              <span className="text-sm font-medium text-slate-700">Transport *</span>
              <Select value={form.transport} onChange={set('transport')}>
                {TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
              <span className="block text-xs text-slate-500">
                One transport per instrument, so the connection instructions are unambiguous.
              </span>
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Expected interval (seconds)</span>
              <Input
                type="number" min={1} value={form.expectedIntervalSec}
                onChange={set('expectedIntervalSec')} placeholder="Leave blank to exempt"
              />
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
          transport={created.transport}
          token={created.token}
          onClose={() => navigate(`/instruments/${created.id}`)}
        />
      )}
    </div>
  );
}
