import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { parseInstrumentAttributeKeys, placementColumnFor } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TokenDialog } from './token-dialog';

interface CreatedInstrument { id: string; code: string; token: string }

/**
 * Register an instrument.
 *
 * Trimmed 2026-08-07 (operator request) to the fields this install fills in:
 * the Instrument ID, whether it is a gateway, where it sits, and its
 * attributes. Name, expected interval and the whole Hardware block are gone
 * from the form — the columns still exist and are still editable on the detail
 * page, they were simply never filled in here.
 *
 * `name` is sent as the code. The API requires it, and two separate identity
 * fields on one form is how you get a register where half the rows are named
 * after the device and half after the room.
 *
 * ── Attributes ──
 * Which keys are asked for is administered PER PROFILE, in Configuration →
 * Instrument Attributes, so the same idea does not get stored as "Room", "room"
 * and "Room No" by three different operators, and so a Modbus sensor is not
 * asked for cleanroom humidity limits. This form only collects VALUES. The list
 * is a prompt, not a constraint: the detail page still accepts any key
 * afterwards.
 */
export function InstrumentCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedInstrument | null>(null);
  const [form, setForm] = useState({ code: '' });
  const [isGateway, setIsGateway] = useState(false);
  /**
   * Which gateway this instrument reports through. Optional — most instruments
   * report directly.
   *
   * The list is EVERY gateway, across ALL profiles, on purpose: gateways are
   * routinely created under one profile and the instruments behind them under
   * another, and the backend has never restricted the pairing
   * (`eligible-children` filters on isGateway/gatewayId/isActive, never profile).
   * Each option names the gateway's own profile so a cross-profile link is a
   * visible choice rather than an accident.
   */
  const [gatewayId, setGatewayId] = useState('');
  const { data: gateways } = useSWR<{ data: { id: string; code: string; name: string; profileName: string | null }[] }>(
    '/api/instruments?isGateway=true&limit=200',
  );
  /** Values for the configured keys, keyed by the key itself. */
  const [attrs, setAttrs] = useState<Record<string, string>>({});

  // Profiles. Arriving from inside a profile (the normal route) pre-selects it
  // and shows it as a chip: the operator made that choice by opening the
  // profile, and asking again would be a decision they have already taken.
  const [searchParams] = useSearchParams();
  const presetProfileId = searchParams.get('profileId');
  const { data: profiles } = useSWR<{ data: { id: string; name: string }[] }>('/api/instrument-profiles');
  const [profileId, setProfileId] = useState(presetProfileId ?? '');
  const presetProfileName = profiles?.data?.find((p) => p.id === presetProfileId)?.name;

  /**
   * The keys THIS PROFILE asks for. Read from the profile rather than the global
   * config since 2026-08-08 — each profile owns its own list.
   *
   * `INSTRUMENT_CREATE`'s grant set includes `INSTRUMENT_READ`
   * (permission-tree.ts:323), so anyone who can reach this form can read the
   * profile. That matters: the config endpoint this replaced was deliberately
   * left ungated so the form would not silently ask for nothing for exactly the
   * role that fills it in.
   *
   * A failure here must not block registration — see the four states rendered
   * below, which keep "failed" distinct from "asks for nothing".
   */
  const { data: profile, error: profileError, isLoading: profileLoading } =
    useSWR<{ attributeKeys: string | null }>(
      profileId ? `/api/instrument-profiles/${profileId}` : null,
    );
  const attributeKeys = parseInstrumentAttributeKeys(profile?.attributeKeys);

  /**
   * Values are not carried across profiles — a different profile asks different
   * questions — so a switch clears them. Confirmed rather than silent: the
   * operator typed those values. Unreachable on the normal route, which arrives
   * with `?profileId=` and shows a chip instead of this selector.
   */
  const changeProfile = (next: string) => {
    if (next === profileId) return;
    const typed = Object.values(attrs).some((v) => v.trim() !== '');
    if (typed && !window.confirm(
      'The attributes you have filled in do not apply to a different profile and will be cleared. Continue?',
    )) return;
    setAttrs({});
    setProfileId(next);
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const code = form.code.trim();
      const payload: Record<string, unknown> = { name: code, code, profileId };
      if (isGateway) payload.isGateway = true;
      // A gateway cannot itself sit behind a gateway — the backend rejects that
      // as NESTED_GATEWAY — so the picker is hidden in gateway mode and the value
      // is not sent even if one was chosen before the checkbox was ticked.
      if (!isGateway && gatewayId) payload.gatewayId = gatewayId;

      // Block / Area / Location are configured keys like any other, but they
      // are real COLUMNS on the instrument — the Instruments list filters on
      // them. Routed here rather than written as attribute rows, which would
      // look identical on screen and quietly empty those filters. Everything
      // else becomes an attribute below.
      const attributeEntries: Array<[string, string]> = [];
      for (const key of attributeKeys) {
        const value = (attrs[key] ?? '').trim();
        // Send only what was filled. Posting '' would store an empty string
        // where the schema means "not recorded".
        if (!value) continue;
        const column = placementColumnFor(key);
        if (column) payload[column] = value;
        else attributeEntries.push([key, value]);
      }

      const res = await apiClient.post<CreatedInstrument>('/api/instruments', payload);

      // Attributes are separate writes — there is no bulk endpoint, and each is
      // separately audited. The instrument EXISTS by now, so a failure here is
      // reported without discarding it: the operator keeps the registration and
      // the token, and can add the missing attribute from the detail page.
      const failed: string[] = [];
      for (const [key, value] of attributeEntries) {
        try {
          await apiClient.post(`/api/instruments/${res.id}/attributes`, { key, value });
        } catch {
          failed.push(key);
        }
      }
      if (failed.length) {
        toast.error(
          'Instrument created, some attributes were not saved',
          `${failed.join(', ')} could not be saved. Add them from the instrument's Attributes panel.`,
        );
      }

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
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">New Instrument</h1>

      <form onSubmit={submit} className="space-y-6">
        <Card>
          <CardHeader><CardTitle>Identity</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {presetProfileId ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <span className="text-xs text-slate-500">Profile</span>
                <p className="text-sm font-medium text-slate-800">{presetProfileName ?? '…'}</p>
              </div>
            ) : (
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Profile *</span>
                <select
                  required value={profileId} onChange={(e) => changeProfile(e.target.value)}
                  className="ctl w-full"
                >
                  <option value="">Select a profile…</option>
                  {profiles?.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Instrument ID *</span>
              <Input
                required value={form.code} onChange={set('code')} placeholder="PROBE-A1"
                pattern="[A-Za-z0-9._\-]+"
                title="Letters, digits, dot, dash or underscore only"
              />
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="ctl-check mt-0.5"
                checked={isGateway}
                onChange={(e) => setIsGateway(e.target.checked)}
              />
              <span className="font-medium">Is Gateway</span>
            </label>

            {/* Hidden in gateway mode: a gateway behind a gateway is rejected
                server-side (NESTED_GATEWAY), so offering the control would be
                offering a guaranteed error. */}
            {!isGateway && (
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Reports through gateway</span>
                <select
                  value={gatewayId}
                  onChange={(e) => setGatewayId(e.target.value)}
                  className="ctl w-full"
                >
                  <option value="">None — reports directly</option>
                  {gateways?.data?.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.code}{g.name && g.name !== g.code ? ` — ${g.name}` : ''}
                      {g.profileName ? ` (${g.profileName})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Attributes</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/*
              Four states, deliberately distinguishable. Collapsing "loading" or
              "failed" into "asks for nothing" lets an operator register an
              instrument with every attribute missing and no signal that
              anything went wrong.
            */}
            {!profileId ? (
              <p className="text-xs text-slate-500">
                Choose a profile to see the attributes it asks for.
              </p>
            ) : profileLoading ? (
              <p className="text-xs text-slate-500">
                Loading the attributes this profile asks for…
              </p>
            ) : profileError ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Could not load the attributes this profile asks for. You can still
                register the instrument and add them from its Attributes panel.
              </p>
            ) : attributeKeys.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {attributeKeys.map((key) => (
                  <label key={key} className="space-y-1">
                    <span className="text-sm font-medium text-slate-700">{key}</span>
                    <Input
                      value={attrs[key] ?? ''}
                      onChange={(e) => setAttrs((a) => ({ ...a, [key]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                This profile asks for no attributes. Add keys for it in
                Configuration → Instrument Attributes.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button
            type="button" variant="secondary"
            onClick={() => navigate(profileId ? `/instruments/profiles/${profileId}` : '/instruments')}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !profileId}>
            {saving ? 'Creating…' : 'Create Instrument'}
          </Button>
        </div>
      </form>

      {created && (
        <TokenDialog
          open
          title="Instrument created"
          id={created.id}
          code={created.code}
          token={created.token}
          onClose={() => navigate(`/instruments/${created.id}`)}
        />
      )}
    </div>
  );
}
