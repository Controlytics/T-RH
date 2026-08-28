import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { parseInstrumentAttributeKeys } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The attribute keys the New Instrument form asks for — PER PROFILE, one field
 * per key, added / renamed / removed individually.
 *
 * Each instrument profile owns its own list (2026-08-08, operator request), and
 * NOTHING is shared between them. A newly created profile starts EMPTY: the
 * "Default for new profiles" template that once seeded it was dropped the same
 * day, because a new profile opening as an identical copy of the last one is
 * exactly what makes the list read as global — the confusion per-profile keys
 * exist to remove. The global config key `instrument-attributes` still exists
 * but now seeds nothing and is asked for on no form; see the note in
 * `defs/instrument-attributes.def.ts`.
 *
 * One page with a profile picker rather than an editor on each profile, so the
 * lists can be compared side by side.
 *
 * The STORAGE is a newline-separated string under `attributeKeys` on the profile
 * itself, because the create form and `parseInstrumentAttributeKeys` already
 * agree on that shape, and changing the wire format to make an editor nicer
 * would be the tail wagging the dog. This page is a view over that string: split
 * on load, joined on save.
 *
 * Rows are keyed by a STABLE id, not by array index and not by the key text.
 * Index keys make React reuse the wrong input when a row is deleted from the
 * middle (the classic symptom: you delete row 2 and row 3's text appears to
 * jump up while focus stays put); text keys remount the field on every
 * keystroke, which loses the caret.
 */

interface Row { id: number; key: string }
interface Profile { id: string; name: string; instrumentCount: number; attributeKeys: string | null }

/**
 * The three keys that are NOT attributes — they are real columns the Instruments
 * list filters and displays on. A profile may omit them; the advisory says what
 * that costs.
 */
const PLACEMENT_KEYS = ['Block', 'Area', 'Location'];

let nextId = 1;
const toRows = (keys: string[]): Row[] => keys.map((key) => ({ id: nextId++, key }));

export function InstrumentAttributesConfigPage() {
  const { toast } = useToast();
  const { data: profileList, mutate: mutateProfiles } = useSWR<{ data: Profile[] }>('/api/instrument-profiles');

  /** Empty until the profile list arrives — there is nothing else to edit. */
  const [target, setTarget] = useState<string>('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The list as it stands on the server for the CURRENT target, in the same
   * normalised form the save sends. Comparing against it is what makes "Save
   * changes" go quiet once there is nothing to save — after a successful save it
   * is updated in place, so the button disables immediately instead of staying
   * lit until the next keystroke.
   */
  const [saved, setSaved] = useState<string | null>(null);
  /**
   * Which target `rows` / `saved` were seeded from. Without this the dirty check
   * would compare one target's edits against another target's baseline.
   */
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const profiles = profileList?.data ?? [];
  const selectedProfile = profiles.find((p) => p.id === target) ?? null;
  const serverKeys = selectedProfile?.attributeKeys;
  const ready = selectedProfile !== null;

  // Land on the first profile once the list arrives. Deliberately only when
  // nothing is selected, so a revalidation cannot yank the operator off the
  // profile they are editing.
  useEffect(() => {
    if (!target && profiles.length > 0) setTarget(profiles[0].id);
  }, [target, profiles]);

  // Seed once per target, then leave the operator's edits alone — a revalidation
  // mid-edit must not overwrite what they are typing.
  useEffect(() => {
    if (ready && seededFor !== target) {
      const keys = parseInstrumentAttributeKeys(serverKeys);
      setRows(toRows(keys));
      setSaved(keys.join('\n'));
      setSeededFor(target);
    }
  }, [ready, seededFor, target, serverKeys]);

  // Nothing to edit until a profile exists — the keys live ON a profile now, so
  // this page has no meaning without one. Says where to go rather than showing
  // an editor that could not save.
  if (profileList && profiles.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 py-10 text-center">
        <p className="text-slate-600">
          There are no instrument profiles yet. Attribute keys belong to a profile,
          so create one first — it starts with no attributes, and you add them here.
        </p>
        <Link to="/instruments"><Button>Go to Instrument Profiles</Button></Link>
      </div>
    );
  }

  if (rows === null) return <div className="py-10 text-center text-slate-400">Loading…</div>;

  const trimmed = rows.map((r) => r.key.trim());
  /**
   * Duplicate detection is CASE-INSENSITIVE, because that is the entire reason
   * these keys are administered: "Room" and "room" stored as two attributes is
   * the mess this page exists to prevent. Reported per row rather than as one
   * message at the top, so the operator can see WHICH field to fix.
   */
  const dupIds = new Set<number>();
  const seen = new Map<string, number>();
  rows.forEach((r) => {
    const fold = r.key.trim().toLowerCase();
    if (!fold) return;
    if (seen.has(fold)) dupIds.add(r.id);
    else seen.set(fold, r.id);
  });
  const badCharIds = new Set(rows.filter((r) => r.key.trim() && r.key.trim().length > 64).map((r) => r.id));
  const blocked = dupIds.size > 0 || badCharIds.size > 0;
  const kept = trimmed.filter(Boolean).length;

  // What a save would send. Blank rows and surrounding space are dropped here
  // too, so adding an empty row — then removing it — does not read as a change.
  const normalised = rows.map((r) => r.key.trim()).filter(Boolean).join('\n');
  const dirty = saved === null || normalised !== saved;

  const update = (id: number, key: string) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, key } : r)));
  const remove = (id: number) => setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
  const add = () => setRows((rs) => [...(rs ?? []), { id: nextId++, key: '' }]);
  const move = (id: number, by: -1 | 1) =>
    setRows((rs) => {
      const list = [...(rs ?? [])];
      const i = list.findIndex((r) => r.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= list.length) return list;
      [list[i], list[j]] = [list[j], list[i]];
      return list;
    });

  /**
   * Switching target is a second way to lose work: the editor deliberately
   * ignores server revalidations mid-edit, so an unsaved list has nowhere else to
   * come back from. Confirm, and leave the selector where it was when declined.
   */
  const changeTarget = (next: string) => {
    if (next === target) return;
    if (dirty && !window.confirm(
      'You have unsaved changes to this list. Discard them and switch?',
    )) return;
    setTarget(next);
  };

  /**
   * Block / Area / Location are real placement columns, not attributes. A profile
   * MAY omit them (2026-08-08 operator decision) and this says what it costs.
   * Advice, not a block — the same posture as the long-form note below. Since a
   * new profile now starts empty, this fires on every one of them until the keys
   * are added, which is the point: it is the only thing standing between a fresh
   * profile and a blank Placement column on the Instruments list.
   */
  const missingPlacement = PLACEMENT_KEYS
    .filter((p) => !trimmed.some((k) => k.toLowerCase() === p.toLowerCase()));

  const save = async () => {
    if (blocked || !dirty) return;
    setSaving(true);
    try {
      // Blank rows are dropped rather than refused: an operator who added a row
      // and changed their mind should not have to hunt for it to save.
      // `normalised` is the SAME value the dirty check compares against — built
      // once, so the button cannot disagree with what was sent.
      const keys = normalised;
      // The list is written ON the profile. There is no shared list to write to.
      await apiClient.put(`/api/instrument-profiles/${target}`, { attributeKeys: keys });
      // Before the revalidation, not after: this is what makes the button go
      // quiet the moment the save lands, instead of staying lit until the next
      // keystroke.
      setSaved(keys);
      await mutateProfiles();
      toast.success(
        'Attribute keys saved',
        `The ${selectedProfile?.name} form now asks for ${kept} attribute${kept === 1 ? '' : 's'}.`,
      );
    } catch (err: unknown) {
      toast.error('Could not save', (err as { message?: string })?.message ?? 'The attribute keys were not changed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Instrument Attributes</h1>
          <p className="text-sm text-slate-500">
            The attributes the New Instrument form asks for, per profile. You set
            the keys here; whoever registers a device fills in the values.
          </p>
        </div>
        <Link to="/config"><Button variant="secondary">Back to Settings</Button></Link>
      </div>

      <Card>
        <CardContent className="py-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Editing</span>
            <select
              aria-label="Editing"
              value={target}
              onChange={(e) => changeTarget(e.target.value)}
              className="ctl w-full"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.instrumentCount} instrument{p.instrumentCount === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-slate-500">
            This list is what the New Instrument form asks for in this profile only.
            Every profile has its own; a new one starts empty.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Attribute keys</CardTitle>
          {/* A count, not a quota. There is no cap (2026-08-07 operator
              decision) — this is here so an admin can see how long the
              registration form has become before an operator meets it. */}
          <span className="text-xs text-slate-500">{kept} key{kept === 1 ? '' : 's'}</span>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
              This profile asks for no attributes yet. Add one below.
            </p>
          )}

          {rows.map((row, i) => (
            <div key={row.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-right text-xs text-slate-400">{i + 1}</span>
                <Input
                  value={row.key}
                  autoComplete="off"
                  placeholder="e.g. Calibration Due"
                  aria-label={`Attribute key ${i + 1}`}
                  onChange={(e) => update(row.id, e.target.value)}
                  className={dupIds.has(row.id) || badCharIds.has(row.id) ? 'border-red-400' : ''}
                />
                {/* Order is the order the fields appear on the New Instrument
                    form, so it is worth being able to change without retyping. */}
                <button
                  type="button" aria-label={`Move ${row.key || `key ${i + 1}`} up`}
                  disabled={i === 0} onClick={() => move(row.id, -1)}
                  className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <button
                  type="button" aria-label={`Move ${row.key || `key ${i + 1}`} down`}
                  disabled={i === rows.length - 1} onClick={() => move(row.id, 1)}
                  className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <button
                  type="button" aria-label={`Delete ${row.key || `key ${i + 1}`}`}
                  onClick={() => remove(row.id)}
                  className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
              {dupIds.has(row.id) && (
                <p className="pl-8 text-xs text-red-600">
                  Already used above — keys must be unique, ignoring case.
                </p>
              )}
              {badCharIds.has(row.id) && (
                <p className="pl-8 text-xs text-red-600">Too long — keep a key under 64 characters.</p>
              )}
            </div>
          ))}

          {missingPlacement.length > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              This profile does not ask for {missingPlacement.join(', ')}. Those are
              real placement columns — instruments registered here will have them
              empty, and the Instruments list Placement column and its filters will
              be blank for them.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={add}>
              Add attribute key
            </Button>
            {kept >= 20 && (
              // Advice, not a block. Past roughly twenty fields a registration
              // form starts being tabbed through rather than filled in, and
              // blank-but-asked-for is worse data than never asked.
              <span className="text-xs text-amber-600">
                {kept} fields is a long form — operators tend to skip past the end of one.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {/* Removing a key does NOT remove it from instruments that already have
            it — this list decides what is ASKED FOR, not what is stored. Said
            here because "delete" on a config screen reasonably reads as
            destructive, and this one is not. */}
        <p className="mr-auto text-xs text-slate-500">
          Applies to the next instrument registered in {selectedProfile?.name}. Attributes already recorded are untouched.
        </p>
        <Link to="/config"><Button variant="secondary">Cancel</Button></Link>
        <Button type="button" disabled={saving || blocked || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}
