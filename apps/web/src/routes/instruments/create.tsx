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
 * Which keys are asked for is administered in Configuration → Instrument
 * Attributes, so the same idea does not get stored as "Room", "room" and
 * "Room No" by three different operators. This form only collects VALUES.
 * The list is a prompt, not a constraint: the detail page still accepts any
 * key afterwards.
 */
export function InstrumentCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedInstrument | null>(null);
  const [form, setForm] = useState({ code: '' });
  const [isGateway, setIsGateway] = useState(false);
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

  // Public-ish config read: any authenticated user who may create an instrument
  // may see which keys to fill in. A failure here must not block registration,
  // so an unreachable config simply yields no attribute fields.
  const { data: attrConfig } = useSWR<{ keys?: string }>('/api/config/instrument-attributes/current');
  const attributeKeys = parseInstrumentAttributeKeys(attrConfig?.keys);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const code = form.code.trim();
      const payload: Record<string, unknown> = { name: code, code, profileId };
      if (isGateway) payload.isGateway = true;

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
      <h1 className="text-2xl font-semibold text-slate-900">New Instrument</h1>

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
                  required value={profileId} onChange={(e) => setProfileId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
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
                className="mt-0.5"
                checked={isGateway}
                onChange={(e) => setIsGateway(e.target.checked)}
              />
              <span className="font-medium">Is Gateway</span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Attributes</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {attributeKeys.length > 0 ? (
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
                No attribute keys are configured. Add them in Configuration →
                Instrument Attributes to have them asked for here.
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
