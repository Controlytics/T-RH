import { useState } from 'react';
import useSWR from 'swr';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';

interface HierarchyOption { id: string; path: string }
interface ProfileOption { id: string; name: string }
interface GatewayOption { id: string; name: string }

const TYPES = [
  'temperature-sensor', 'humidity-sensor', 'pressure-sensor', 'flow-meter',
  'energy-meter', 'plc', 'controller', 'rfid-reader', 'vfd', 'analyzer', 'custom',
];

export default function InstrumentWizard() {
  const nav = useNavigate();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '', code: '', description: '', instrumentType: TYPES[0],
    manufacturer: '', model: '', serialNumber: '',
    hierarchyNodeId: '', communicationProfileId: '',
    gatewayEnabled: false, gatewayId: '', deviceKey: '',
  });

  const { data: nodes } = useSWR<HierarchyOption[]>('/api/hierarchy');
  const { data: profiles } = useSWR<ProfileOption[]>('/api/communication-profiles');
  const { data: gateways } = useSWR<GatewayOption[]>('/api/gateways');

  const set = (k: keyof typeof form, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const step1Valid = Boolean(form.name.trim() && form.code.trim() && form.hierarchyNodeId);
  const step3Valid = form.gatewayEnabled
    ? Boolean(form.gatewayId && form.deviceKey.trim())
    : Boolean(form.communicationProfileId);

  async function submit() {
    setBusy(true);
    try {
      await apiClient.post('/api/instruments', {
        name: form.name, code: form.code, instrumentType: form.instrumentType,
        manufacturer: form.manufacturer || undefined, model: form.model || undefined,
        serialNumber: form.serialNumber || undefined, description: form.description || undefined,
        hierarchyNodeId: form.hierarchyNodeId,
        gatewayId: form.gatewayEnabled ? form.gatewayId : null,
        deviceKey: form.gatewayEnabled ? form.deviceKey : null,
        communicationProfileId: form.gatewayEnabled ? null : form.communicationProfileId,
      });
      toast.success('Instrument created', `"${form.name}" has been created.`);
      nav('/data-injection/instruments');
    } catch (e) {
      toast.error('Could not create instrument', (e as Error)?.message ?? 'Please check the form and try again.');
    } finally { setBusy(false); }
  }

  const field = 'w-full rounded border border-slate-300 px-2 py-1.5 text-sm';

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Create Instrument</h1>

      <ol className="mt-4 flex gap-2 text-xs" role="group" aria-label="Wizard progress">
        {['Basic details', 'Communication', 'Gateway'].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? 'step' : undefined}
            className={`flex-1 rounded px-3 py-2 text-center ${
              step === i + 1 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <div className="mt-6 space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        {step === 1 && (
          <>
            <label className="block text-sm">Instrument Name
              <input className={field} value={form.name} onChange={e => set('name', e.target.value)} /></label>
            <label className="block text-sm">Instrument Code
              <input className={field} value={form.code} onChange={e => set('code', e.target.value)} /></label>
            <label className="block text-sm">Type
              <select className={field} value={form.instrumentType} onChange={e => set('instrumentType', e.target.value)}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select></label>
            <label className="block text-sm">Manufacturer
              <input className={field} value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} /></label>
            <label className="block text-sm">Model
              <input className={field} value={form.model} onChange={e => set('model', e.target.value)} /></label>
            <label className="block text-sm">Serial Number
              <input className={field} value={form.serialNumber} onChange={e => set('serialNumber', e.target.value)} /></label>
            <label className="block text-sm">Location (hierarchy node)
              <select className={field} value={form.hierarchyNodeId} onChange={e => set('hierarchyNodeId', e.target.value)}>
                <option value="">Select…</option>
                {(nodes ?? []).map(n => <option key={n.id} value={n.id}>{n.path}</option>)}
              </select></label>
          </>
        )}

        {step === 2 && (
          <label className="block text-sm">Communication Profile
            <select className={field} value={form.communicationProfileId}
              onChange={e => set('communicationProfileId', e.target.value)}>
              <option value="">Select…</option>
              {(profiles ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              Ignored if this instrument sits behind a gateway — it inherits the gateway's profile.
            </span>
          </label>
        )}

        {step === 3 && (
          <>
            <fieldset>
              <legend className="text-sm text-slate-700">Gateway Enabled?</legend>
              <div className="mt-2 flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={form.gatewayEnabled} onChange={() => set('gatewayEnabled', true)} /> Yes
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!form.gatewayEnabled} onChange={() => set('gatewayEnabled', false)} /> No
                </label>
              </div>
            </fieldset>
            {form.gatewayEnabled ? (
              <>
                <label className="block text-sm">Gateway
                  <select className={field} value={form.gatewayId} onChange={e => set('gatewayId', e.target.value)}>
                    <option value="">Select…</option>
                    {(gateways ?? []).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select></label>
                <label className="block text-sm">Device Key
                  <input className={field} value={form.deviceKey} onChange={e => set('deviceKey', e.target.value)} />
                  <span className="mt-1 block text-xs text-slate-500">
                    How this device is addressed inside the gateway's payload. Must be unique within the gateway.
                  </span></label>
              </>
            ) : (
              <p className="text-sm text-slate-500">
                This instrument communicates independently and will use the profile chosen in step 2.
              </p>
            )}
          </>
        )}
      </div>

      <div className="mt-4 flex justify-between">
        <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
          className="rounded border border-slate-300 px-4 py-2 text-sm disabled:opacity-40">Back</button>
        {step < 3 ? (
          <button onClick={() => setStep(s => s + 1)} disabled={step === 1 && !step1Valid}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">Next</button>
        ) : (
          <button onClick={submit} disabled={busy || !step3Valid}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">Create instrument</button>
        )}
      </div>
    </div>
  );
}
