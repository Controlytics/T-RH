import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR, { mutate as mutateGlobal } from 'swr';
import {
  parseInstrumentAttributeKeys, coerceAttributeLabels, coerceSettingsHidden, isHiddenInSettings,
  ATTRIBUTE_LABEL_MAX, type AttributeLabels, type SettingsHidden,
} from '@digilog/shared';
import { ATTRIBUTE_LABELS_URL } from '@/hooks/use-attribute-labels';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { Card, CardContent } from '@/components/ui/card';
import { FormSection } from '@/components/ui/form-section';
import { PageHero } from '@/components/ui/page-hero';
import { SkeletonCard } from '@/components/ui/skeleton';
import { RemarkDialog } from '@/routes/instruments/remark-dialog';

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

/**
 * `name` is the key's DISPLAY NAME (2026-09-16, operator: "dont give as
 * seperate configuration add in instrument attributes configuration"). The
 * names are ONE global map — the `attribute-labels` config row — so a key is
 * called the same thing in every profile; this page shows and edits the names
 * of the keys on the SELECTED profile. Saved through the generic dynamic PUT
 * as the WHOLE map, merged: this profile's rows are written over the stored
 * map (a blank clears a name), a key that left this profile's list loses its
 * name unless another profile still lists it, and every other key is untouched.
 */
/**
 * `shown` is whether the SETTINGS page draws this key (2026-09-21, operator:
 * "in that configuration page any attribute or any field hide, then that
 * field should not show in the settings page, in configuration page give
 * hid/un hide options"). ON by default; what is stored is the HIDDEN set,
 * beside the names on the same row, so a key nobody has considered shows.
 * Carried on the row so a rename keeps it; merged on save by the same rules
 * as the names — see `mergeSettingsHidden`.
 */
interface Row { id: number; key: string; name: string; shown: boolean }
interface Profile { id: string; name: string; instrumentCount: number; attributeKeys: string | null }

const fold = (k: string) => k.trim().toLowerCase();
const nameOf = (labels: AttributeLabels, key: string): string => {
  const hit = Object.keys(labels).find((k) => fold(k) === fold(key));
  return hit ? labels[hit] : '';
};

/**
 * The map a save sends. Pure, so the merge rule can be tested without the page.
 * `originalKeys` are the keys this profile listed when the editor was seeded;
 * `otherProfilesKeys` every key any OTHER profile lists.
 */
export function mergeLabels(
  stored: AttributeLabels,
  rows: { key: string; name: string }[],
  originalKeys: string[],
  otherProfilesKeys: string[],
): AttributeLabels {
  const out: AttributeLabels = { ...stored };
  const drop = (key: string) => { for (const k of Object.keys(out)) if (fold(k) === fold(key)) delete out[k]; };
  const rowKeys = new Set(rows.map((r) => fold(r.key)).filter(Boolean));
  const elsewhere = new Set(otherProfilesKeys.map(fold));
  // A key that left this profile (removed or renamed) takes its name with it —
  // unless another profile still asks for it, in which case the name is theirs too.
  for (const key of originalKeys) {
    if (!rowKeys.has(fold(key)) && !elsewhere.has(fold(key))) drop(key);
  }
  for (const r of rows) {
    const key = r.key.trim();
    const name = r.name.trim();
    if (!key) continue;
    drop(key);
    if (name) out[key] = name;
  }
  return out;
}

/**
 * The hidden set a save sends — the Settings-page half of the same row. Pure,
 * and the SAME merge rule as `mergeLabels`: this profile's rows decide their
 * own keys (a row switched off is hidden, a row switched on is not), a key that
 * left this profile drops out unless another profile still lists it, and every
 * other key — hidden through some other profile — is untouched. A renamed row
 * carries `shown` with it, so the old spelling drops and the new one takes its
 * place. Order: the stored keys that survive, then this profile's newly hidden
 * ones in row order.
 */
export function mergeSettingsHidden(
  stored: SettingsHidden,
  rows: { key: string; shown: boolean }[],
  originalKeys: string[],
  otherProfilesKeys: string[],
  hideInstrumentId: boolean,
): SettingsHidden {
  const rowKeys = new Set(rows.map((r) => fold(r.key)).filter(Boolean));
  const elsewhere = new Set(otherProfilesKeys.map(fold));
  const left = new Set(originalKeys.map(fold).filter((k) => !rowKeys.has(k) && !elsewhere.has(k)));
  const keys = stored.keys.filter((k) => !left.has(fold(k)) && !rowKeys.has(fold(k)));
  for (const r of rows) {
    const key = r.key.trim();
    if (key && !r.shown) keys.push(key);
  }
  return { instrumentId: hideInstrumentId, keys };
}

/**
 * The three keys that are NOT attributes — they are real columns the Instruments
 * list filters and displays on. A profile may omit them; the advisory says what
 * that costs.
 */
const PLACEMENT_KEYS = ['Block', 'Area', 'Location'];

let nextId = 1;
const toRows = (keys: string[], labels: AttributeLabels, hidden: SettingsHidden): Row[] =>
  keys.map((key) => ({ id: nextId++, key, name: nameOf(labels, key), shown: !isHiddenInSettings(hidden, key) }));

export function InstrumentAttributesConfigPage() {
  const { toast } = useToast();
  // `UPDATE_INSTRUMENT_PROFILE` is an admin-configurable re-auth action
  // (audit 2026-10-03, SEC-7); the server checks it first on the profile PUT.
  const reauth = useReauth();
  const { data: profileList, mutate: mutateProfiles } = useSWR<{ data: Profile[] }>('/api/instrument-profiles');
  // The SUPER_ADMIN editor endpoint for the display-name map (this page is
  // SUPER_ADMIN); every other screen reads the narrow-slice route instead.
  const { data: labelsRow, mutate: mutateLabels } = useSWR<{ labels?: unknown }>('/api/config/dynamic/attribute-labels');
  const storedLabels = coerceAttributeLabels(labelsRow);
  const storedHidden = coerceSettingsHidden(labelsRow);

  /** Empty until the profile list arrives — there is nothing else to edit. */
  const [target, setTarget] = useState<string>('');
  const [rows, setRows] = useState<Row[] | null>(null);
  /** Draft of the Settings page's Instrument ID tile: true = hidden. Global, not per profile. */
  const [hideId, setHideId] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * The list as it stands on the server for the CURRENT target, in the same
   * normalised form the save sends. Comparing against it is what makes "Save
   * changes" go quiet once there is nothing to save — after a successful save it
   * is updated in place, so the button disables immediately instead of staying
   * lit until the next keystroke.
   */
  const [saved, setSaved] = useState<string | null>(null);
  /** The display names as seeded, in the same normalised form a save compares. */
  const [savedNames, setSavedNames] = useState<string | null>(null);
  /** The Show in Settings switches as seeded — Instrument ID flag plus per-row — same idea. */
  const [savedHidden, setSavedHidden] = useState<string | null>(null);
  /** The keys the selected profile listed when seeded — what a save may un-name. */
  const [originalKeys, setOriginalKeys] = useState<string[]>([]);
  /**
   * Which target `rows` / `saved` were seeded from. Without this the dirty check
   * would compare one target's edits against another target's baseline.
   */
  const [seededFor, setSeededFor] = useState<string | null>(null);
  /**
   * Which keys the selected profile's instruments actually carry (2026-09-16).
   * Removing such a key DELETES the attribute on those instruments — the save
   * says so, key by key with the count, and takes ONE remark the server writes
   * on every INSTRUMENT_ATTRIBUTE_REMOVED row.
   */
  const { data: usageRes, mutate: mutateUsage } = useSWR<{ keys: { key: string; instruments: number }[] }>(
    target ? `/api/instrument-profiles/${target}/attribute-usage` : null,
  );
  const [removalRemarkOpen, setRemovalRemarkOpen] = useState(false);

  const profiles = profileList?.data ?? [];
  const selectedProfile = profiles.find((p) => p.id === target) ?? null;
  const serverKeys = selectedProfile?.attributeKeys;
  const ready = selectedProfile !== null && labelsRow !== undefined;

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
      const seeded = toRows(keys, storedLabels, storedHidden);
      setRows(seeded);
      setHideId(storedHidden.instrumentId);
      setSaved(keys.join('\n'));
      setSavedNames(JSON.stringify(seeded.map((r) => [r.key, r.name.trim()])));
      setSavedHidden(JSON.stringify([storedHidden.instrumentId, seeded.map((r) => [r.key, r.shown])]));
      setOriginalKeys(keys);
      setSeededFor(target);
    }
  }, [ready, seededFor, target, serverKeys, storedLabels, storedHidden]);

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

  if (rows === null) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} lines={1} />)}
      </div>
    );
  }

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
  /**
   * A display name may not repeat, case ignored (2026-09-16, operator) — among
   * this profile's rows, and against the names other profiles' keys already
   * hold, since the map is one. Reported on the row, naming the key that has it.
   */
  const dupNames = new Map<number, string>();
  {
    // Names held by keys OUTSIDE this profile are taken. A key this profile
    // listed at seed is governed by these rows — renamed, removed or kept —
    // so its stored name must not count against the row that carries it.
    const ours = new Set([...rows.map((r) => fold(r.key)), ...originalKeys.map(fold)].filter(Boolean));
    const taken = new Map<string, string>();
    for (const [k, n] of Object.entries(storedLabels)) {
      if (!ours.has(fold(k))) taken.set(fold(n), k);
    }
    for (const r of rows) {
      const fn = fold(r.name);
      if (!fn) continue;
      const owner = taken.get(fn);
      if (owner) dupNames.set(r.id, owner);
      else taken.set(fn, r.key.trim() || 'another row');
    }
  }
  const blocked = dupIds.size > 0 || badCharIds.size > 0 || dupNames.size > 0;
  /** Listed keys this save DROPS (a rename by case alone is not a removal) that instruments carry. */
  const affectedRemovals = originalKeys
    .filter((k) => !rows.some((r) => fold(r.key) === fold(k)))
    .map((k) => (usageRes?.keys ?? []).find((u) => fold(u.key) === fold(k)))
    .filter((u): u is { key: string; instruments: number } => Boolean(u));
  const kept = trimmed.filter(Boolean).length;

  // What a save would send. Blank rows and surrounding space are dropped here
  // too, so adding an empty row — then removing it — does not read as a change.
  const normalised = rows.map((r) => r.key.trim()).filter(Boolean).join('\n');
  const keysDirty = saved === null || normalised !== saved;
  const normalisedNames = JSON.stringify(rows.map((r) => [r.key, r.name.trim()]));
  const namesDirty = savedNames === null || normalisedNames !== savedNames;
  const normalisedHidden = JSON.stringify([hideId, rows.map((r) => [r.key, r.shown])]);
  const hiddenDirty = savedHidden === null || normalisedHidden !== savedHidden;
  const dirty = keysDirty || namesDirty || hiddenDirty;

  const update = (id: number, key: string) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, key } : r)));
  const rename = (id: number, name: string) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, name } : r)));
  const setShown = (id: number, shown: boolean) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, shown } : r)));
  const remove = (id: number) => setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
  const add = () => setRows((rs) => [...(rs ?? []), { id: nextId++, key: '', name: '', shown: true }]);
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
    // A removal that deletes recorded values is signed first — the dialog names
    // every key and how many instruments lose it. The server refuses the PUT
    // without the remark, so this is the operator's disclosure, not the control.
    if (keysDirty && affectedRemovals.length > 0) { setRemovalRemarkOpen(true); return; }
    await performSave(null);
  };

  const performSave = async (reason: string | null) => {
    setSaving(true);
    try {
      // Blank rows are dropped rather than refused: an operator who added a row
      // and changed their mind should not have to hunt for it to save.
      // `normalised` is the SAME value the dirty check compares against — built
      // once, so the button cannot disagree with what was sent.
      const keys = normalised;
      if (keysDirty) {
        // The list is written ON the profile. There is no shared list to write to.
        // Through the re-auth hook; the sequence below waits for the hook's own
        // outcome (the dialog, when the policy is on, resolves it later). The
        // callback is idempotent — the hook replays it with the password.
        const body = { attributeKeys: keys, ...(reason ? { reason } : {}) };
        let done = false;
        await new Promise<void>((resolve, reject) => {
          void reauth.execute('UPDATE_INSTRUMENT_PROFILE', async (password?: string) => {
            if (done) return;
            if (password) await apiClient.putWithReauth(`/api/instrument-profiles/${target}`, body, password);
            else await apiClient.put(`/api/instrument-profiles/${target}`, body);
            done = true;
          }, { onSuccess: resolve, onError: reject, onCancel: () => reject({ error: 'REAUTH_CANCELLED' }) });
        });
        setRemovalRemarkOpen(false);
        await mutateUsage();
      }
      if (namesDirty || keysDirty || hiddenDirty) {
        // The display names and the Settings-page hidden set are ONE row,
        // written WHOLE (the dynamic PUT replaces the row) and merged — see
        // `mergeLabels` / `mergeSettingsHidden`. Sending one half alone would
        // erase the other.
        const others = profiles.filter((p) => p.id !== target)
          .flatMap((p) => parseInstrumentAttributeKeys(p.attributeKeys));
        const labels = mergeLabels(storedLabels, rows, originalKeys, others);
        const settingsHidden = mergeSettingsHidden(storedHidden, rows, originalKeys, others, hideId);
        await apiClient.put('/api/config/dynamic/attribute-labels', { labels, settingsHidden });
        await mutateLabels();
        // Every other screen reads the narrow-slice route; refresh it so an open
        // Attributes panel re-labels at once rather than when its cache expires.
        await mutateGlobal(ATTRIBUTE_LABELS_URL);
      }
      // Before the revalidation, not after: this is what makes the button go
      // quiet the moment the save lands, instead of staying lit until the next
      // keystroke.
      setSaved(keys);
      setSavedNames(normalisedNames);
      setSavedHidden(normalisedHidden);
      setOriginalKeys(keys.split('\n').filter(Boolean));
      await mutateProfiles();
      toast.success(
        'Attribute keys saved',
        `The ${selectedProfile?.name} form now asks for ${kept} attribute${kept === 1 ? '' : 's'}.`,
      );
    } catch (err: unknown) {
      // A cancelled password prompt is not an error: nothing was written and the
      // operator chose to stop.
      if ((err as { error?: string })?.error !== 'REAUTH_CANCELLED') {
        toast.error('Could not save', (err as { message?: string })?.message ?? 'The attribute keys were not changed.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* The "Back to Settings" button is gone: the breadcrumb's Configuration
          link goes to the same place, and a page does not need two. */}
      <PageHero
        title="Instrument Attributes"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Instrument Attributes' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        }
      />

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

      <FormSection
        title="Attribute keys and display names"
        columns={1}
        // A count, not a quota. There is no cap (2026-08-07 operator
        // decision) — this is here so an admin can see how long the
        // registration form has become before an operator meets it.
        actions={<span className="text-xs text-white/85">{kept} key{kept === 1 ? '' : 's'}</span>}
      >
          {/* The Settings page's ONE non-attribute tile (2026-09-21). Global —
              the Instrument ID is not a profile's key — so it sits above the
              rows rather than among them. */}
          <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-sm font-medium text-slate-700">Instrument ID</span>
            <Toggle
              label="Show Instrument ID in Settings"
              checked={!hideId}
              onChange={(e) => setHideId(!e.target.checked)}
            />
          </div>

          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
              This profile asks for no attributes yet. Add one below.
            </p>
          )}

          {rows.length > 0 && (
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
              <span className="w-6 shrink-0" />
              <span className="flex-1">Key</span>
              <span className="flex-1">Display name</span>
              {/* Width = the switch (2.75rem) + gap + the On/Off word (1.75rem). */}
              <span className="w-[5.25rem] shrink-0">Settings</span>
              <span className="w-[6.75rem] shrink-0" />
            </div>
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
                {/* The key's DISPLAY NAME — what every screen prints for it.
                    Blank = the key is shown as itself. */}
                <Input
                  value={row.name}
                  autoComplete="off"
                  maxLength={ATTRIBUTE_LABEL_MAX}
                  placeholder="Display name"
                  aria-label={`Display name ${i + 1}`}
                  onChange={(e) => rename(row.id, e.target.value)}
                />
                {/* Whether the SETTINGS page draws this key. Presentation over
                    that one page; the attribute is still stored and served. */}
                <Toggle
                  aria-label={`Show in Settings ${i + 1}`}
                  title="Show in Settings"
                  className="shrink-0"
                  checked={row.shown}
                  onChange={(e) => setShown(row.id, e.target.checked)}
                />
                {/* Order is the order the fields appear on the New Instrument
                    form, so it is worth being able to change without retyping. */}
                <Button variant="ghost" size="icon"
                  type="button" aria-label={`Move ${row.key || `key ${i + 1}`} up`}
                  disabled={i === 0} onClick={() => move(row.id, -1)}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </Button>
                <Button variant="ghost" size="icon"
                  type="button" aria-label={`Move ${row.key || `key ${i + 1}`} down`}
                  disabled={i === rows.length - 1} onClick={() => move(row.id, 1)}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </Button>
                <Button variant="ghost" size="icon"
                  type="button" aria-label={`Delete ${row.key || `key ${i + 1}`}`}
                  onClick={() => remove(row.id)}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
              {dupIds.has(row.id) && (
                <p className="pl-8 text-xs text-red-600">
                  Already used above — keys must be unique, ignoring case.
                </p>
              )}
              {badCharIds.has(row.id) && (
                <p className="pl-8 text-xs text-red-600">Too long — keep a key under 64 characters.</p>
              )}
              {dupNames.has(row.id) && (
                <p className="pl-8 text-xs text-red-600">
                  Display name is already used by &ldquo;{dupNames.get(row.id)}&rdquo; — names must differ, ignoring case.
                </p>
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
      </FormSection>

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
      <RemarkDialog
        open={removalRemarkOpen}
        attributeKey=""
        from=""
        destructive
        changes={affectedRemovals.map((a) => ({
          label: a.key,
          from: `${a.instruments} instrument${a.instruments === 1 ? '' : 's'}`,
          to: 'removed',
        }))}
        busy={saving}
        onSubmit={(remark) => void performSave(remark)}
        onClose={() => { if (!saving) setRemovalRemarkOpen(false); }}
      />
    </div>
  );
}
