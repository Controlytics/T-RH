import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import useSWR from 'swr';
import {
  DEFAULT_PROFILE_MEASUREMENTS, MEASUREMENT_CODES_PHASE1, measurementsEquivalent, parseInstrumentAttributeKeys,
  type MeasurementType, type ProfileMeasurement,
} from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { FormSection } from '@/components/ui/form-section';
import { RemarkDialog, type RemarkChange } from '@/routes/instruments/remark-dialog';

/**
 * PROFILE MEASUREMENTS (2026-10-26) — what this profile's devices measure and
 * which keys carry each measurement, with the profile's own NMT / NLT / MKT
 * switches. Operator: "temperature and humidity keys … limits keys … should be
 * updated instrument profiles wise, each profile can receive different keys",
 * then "in instrument profiles NLT and MNT attributes and MKT attributes are
 * should be enabled or disabled should come".
 *
 * Presentation over the server's rules, nothing more: the server validates the
 * list (`profileMeasurementsSchema`), refuses a change from anyone but a super
 * admin, refuses MKT on a non-°C measurement, requires the reason, and says
 * which open alarms a change clears (`POST …/measurement-impact`, asked BEFORE
 * the save so the admin signs knowing). MKT is offered only where the registry
 * says the unit is °C — the server's unit, not a guess.
 *
 * Its own Save, separate from the attribute keys above: a measurement change is
 * a different act (it changes monitoring on every instrument of the profile)
 * with its own reason, and folding it into the key save would sign both at once.
 */

export interface MeasurementsProfile {
  id: string;
  name: string;
  attributeKeys: string | null;
  measurements?: ProfileMeasurement[];
}

const LIMIT_WORD: Record<string, string> = { HIGH: 'NMT (high limit)', LOW: 'NLT (low limit)' };

/** One ordered key list: chips you can remove, a box to add (Enter or comma). */
function KeyListField({
  label, keys, onChange, suggestions,
}: { label: string; keys: string[]; onChange: (keys: string[]) => void; suggestions: string }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const folded = new Set(keys.map((k) => k.toLowerCase()));
    onChange([...keys, ...parts.filter((p) => !folded.has(p.toLowerCase()))]);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
  };
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
        {keys.map((k, i) => (
          <span key={`${k}-${i}`} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
            {k}
            <button
              type="button"
              aria-label={`Remove ${k} from ${label}`}
              className="text-slate-400 hover:text-red-600"
              onClick={() => onChange(keys.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </span>
        ))}
        <Input
          value={text}
          autoComplete="off"
          aria-label={label}
          list={suggestions}
          placeholder={keys.length ? 'Add…' : 'Type a key, Enter to add'}
          className="h-7 min-w-[8rem] flex-1 border-0 px-1 shadow-none focus-visible:ring-0"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={add}
        />
      </div>
    </div>
  );
}

export function ProfileMeasurementsEditor({ profile, onSaved }: { profile: MeasurementsProfile; onSaved: () => void }) {
  const { toast } = useToast();
  const reauth = useReauth();
  const { data: typesRes } = useSWR<{ data: MeasurementType[] }>('/api/instrument-profiles/measurement-types');
  const types = useMemo(() => new Map((typesRes?.data ?? []).filter((t) => t?.code).map((t) => [t.code, t])), [typesRes]);

  const stored = useMemo(() => profile.measurements ?? [], [profile.measurements]);
  const [draft, setDraft] = useState<ProfileMeasurement[]>(() => structuredClone(stored));
  const [seededFor, setSeededFor] = useState(profile.id);
  // A different profile picked above: start from ITS list. (A revalidation of
  // the same profile mid-edit does not reset the draft — edits are not lost.)
  useEffect(() => {
    if (profile.id !== seededFor) { setDraft(structuredClone(stored)); setSeededFor(profile.id); }
  }, [profile.id, seededFor, stored]);

  const [clears, setClears] = useState<{ metric: string; source: string; limitKind: string | null; count: number }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = !measurementsEquivalent(draft, stored);

  const nameOf = (code: string) => types.get(code)?.name ?? code;
  const unitOf = (code: string) => types.get(code)?.unit ?? '';
  const suggestionsId = `profile-attr-keys-${profile.id}`;
  const attributeKeys = parseInstrumentAttributeKeys(profile.attributeKeys);

  const patch = (code: string, fn: (m: ProfileMeasurement) => ProfileMeasurement) =>
    setDraft((ms) => ms.map((m) => (m.code === code ? fn(structuredClone(m)) : m)));
  const addable = MEASUREMENT_CODES_PHASE1.filter((c) => !draft.some((m) => m.code === c));
  const addMeasurement = (code: string) => {
    const seed = DEFAULT_PROFILE_MEASUREMENTS.find((m) => m.code === code);
    if (seed) setDraft((ms) => [...ms, structuredClone(seed)]);
  };

  const askImpact = async () => {
    setSaving(true);
    try {
      const res = await apiClient.post<{ clears: { metric: string; source: string; limitKind: string | null; count: number }[] }>(
        `/api/instrument-profiles/${profile.id}/measurement-impact`, { measurements: draft },
      );
      setClears(res.clears ?? []);
    } catch (err: unknown) {
      toast.error('Could not check the change', (err as { message?: string })?.message ?? 'Nothing was saved.');
    } finally {
      setSaving(false);
    }
  };

  const save = async (reason: string) => {
    setSaving(true);
    const body = { measurements: draft, reason };
    let done = false;
    await reauth.execute('UPDATE_INSTRUMENT_PROFILE', async (password?: string) => {
      if (done) return;
      if (password) await apiClient.putWithReauth(`/api/instrument-profiles/${profile.id}`, body, password);
      else await apiClient.put(`/api/instrument-profiles/${profile.id}`, body);
      done = true;
    }, {
      onSuccess: () => {
        setSaving(false);
        setClears(null);
        onSaved();
        toast.success('Measurements saved', `${profile.name} instruments are read with these keys from now on.`);
      },
      onError: (err: unknown) => {
        setSaving(false);
        toast.error('Could not save', (err as { message?: string })?.message ?? 'The measurements were not changed.');
      },
      onCancel: () => setSaving(false),
    });
  };

  const changes: RemarkChange[] = clears && clears.length > 0
    ? clears.map((c) => ({
        label: c.source === 'INSTRUMENT_LIMIT' ? `${nameOf(c.metric)} ${LIMIT_WORD[c.limitKind ?? ''] ?? 'limit'}`
          : c.source === 'RS485_FAILURE' ? `${nameOf(c.metric)} sensor failure`
            : `${nameOf(c.metric)} out of range`,
        from: `${c.count} open alarm${c.count === 1 ? '' : 's'}`,
        to: 'cleared',
      }))
    : [{ label: 'Measurements', from: 'as saved', to: 'changed' }];

  return (
    <div className="space-y-4">
      <datalist id={suggestionsId}>
        {attributeKeys.map((k) => <option key={k} value={k} />)}
      </datalist>

      {draft.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
          This profile measures nothing — its instruments show no reading and raise no limit alarm. Add a measurement below.
        </p>
      )}

      {draft.map((m) => {
        const celsius = unitOf(m.code) === '°C';
        const title = unitOf(m.code) ? `${nameOf(m.code)} (${unitOf(m.code)})` : nameOf(m.code);
        const keyField = (label: string, keys: string[], set: (keys: string[]) => void) => (
          <KeyListField label={label} keys={keys} onChange={set} suggestions={suggestionsId} />
        );
        return (
          <FormSection
            key={m.code}
            title={title}
            columns={2}
            actions={(
              <Button type="button" size="sm" variant="secondary" onClick={() => setDraft((ms) => ms.filter((x) => x.code !== m.code))}>
                Remove {nameOf(m.code)}
              </Button>
            )}
          >
            {keyField('Device keys', m.deviceKeys, (deviceKeys) => patch(m.code, (x) => ({ ...x, deviceKeys })))}
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              {keyField('Decimals attribute', m.decimals.attributeKeys, (attributeKeys) => patch(m.code, (x) => ({ ...x, decimals: { ...x.decimals, attributeKeys } })))}
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Default decimals</span>
                <Input
                  type="number" min={0} max={10} className="w-20"
                  aria-label={`${nameOf(m.code)} default decimals`}
                  value={m.decimals.fallback}
                  onChange={(e) => patch(m.code, (x) => ({ ...x, decimals: { ...x.decimals, fallback: Math.max(0, Math.min(10, Math.trunc(Number(e.target.value) || 0))) } }))}
                />
              </label>
            </div>

            {(['high', 'low'] as const).map((side) => (
              <div key={side} className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <Toggle
                  label={side === 'high' ? 'NMT — high limit enforced' : 'NLT — low limit enforced'}
                  checked={m[side].enabled}
                  onChange={(e) => patch(m.code, (x) => ({ ...x, [side]: { ...x[side], enabled: e.target.checked } }))}
                />
                {keyField(side === 'high' ? 'High limit attribute' : 'Low limit attribute', m[side].limitKeys,
                  (limitKeys) => patch(m.code, (x) => ({ ...x, [side]: { ...x[side], limitKeys } })))}
                {keyField(side === 'high' ? 'NMT enable attribute (per instrument)' : 'NLT enable attribute (per instrument)', m[side].enableKeys,
                  (enableKeys) => patch(m.code, (x) => ({ ...x, [side]: { ...x[side], enableKeys } })))}
              </div>
            ))}

            {keyField('High range attribute', m.range.highKeys, (highKeys) => patch(m.code, (x) => ({ ...x, range: { ...x.range, highKeys } })))}
            {keyField('Low range attribute', m.range.lowKeys, (lowKeys) => patch(m.code, (x) => ({ ...x, range: { ...x.range, lowKeys } })))}
            {keyField('Offset attribute', m.offsetKeys, (offsetKeys) => patch(m.code, (x) => ({ ...x, offsetKeys })))}

            {celsius && (
              <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <Toggle
                  label="MKT — mean kinetic temperature on the Data Report"
                  checked={m.mkt.enabled}
                  onChange={(e) => patch(m.code, (x) => ({ ...x, mkt: { ...x.mkt, enabled: e.target.checked } }))}
                />
                {keyField('MKT enable attribute (per instrument)', m.mkt.attributeKeys,
                  (attributeKeys) => patch(m.code, (x) => ({ ...x, mkt: { ...x.mkt, attributeKeys } })))}
              </div>
            )}
          </FormSection>
        );
      })}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {/* One button per measurement the profile does not carry — two at most
            in phase 1, so a picker would be one more click for nothing. */}
        <div className="mr-auto flex flex-wrap gap-2">
          {addable.map((c) => (
            <Button key={c} type="button" size="sm" variant="secondary" onClick={() => addMeasurement(c)}>
              Add {nameOf(c)}
            </Button>
          ))}
        </div>
        <Button type="button" disabled={saving || !dirty} onClick={() => void askImpact()}>
          Save measurements
        </Button>
      </div>

      <RemarkDialog
        open={clears !== null}
        attributeKey=""
        from=""
        title={`Change what ${profile.name} measures`}
        // Not the dialog's "destructive" mode: that words the button "Remove
        // attributes", which is not what this is. The rows say what clears.
        changes={changes}
        busy={saving}
        onSubmit={(remark) => void save(remark)}
        onClose={() => { if (!saving) setClears(null); }}
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
