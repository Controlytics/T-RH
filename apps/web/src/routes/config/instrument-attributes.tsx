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
 * The attribute keys the New Instrument form asks for — one field per key,
 * added / renamed / removed individually.
 *
 * Replaces the shared textarea (2026-08-07, operator request). The STORAGE is
 * unchanged — still one newline-separated string behind
 * `/api/config/dynamic/instrument-attributes` — because the create form and
 * `parseInstrumentAttributeKeys` already agree on that shape, and changing the
 * wire format to make an editor nicer would be the tail wagging the dog. This
 * page is a view over the same string: split on load, joined on save.
 *
 * Rows are keyed by a STABLE id, not by array index and not by the key text.
 * Index keys make React reuse the wrong input when a row is deleted from the
 * middle (the classic symptom: you delete row 2 and row 3's text appears to
 * jump up while focus stays put); text keys remount the field on every
 * keystroke, which loses the caret.
 */

interface Row { id: number; key: string }

let nextId = 1;
const toRows = (keys: string[]): Row[] => keys.map((key) => ({ id: nextId++, key }));

export function InstrumentAttributesConfigPage() {
  const { toast } = useToast();
  const { data, mutate } = useSWR<{ keys?: string }>('/api/config/dynamic/instrument-attributes');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The list as it stands on the server, in the same normalised form the save
   * sends. Comparing against it is what makes "Save changes" go quiet once
   * there is nothing to save — after a successful save it is updated in place,
   * so the button disables immediately instead of staying lit until the next
   * keystroke.
   */
  const [saved, setSaved] = useState<string | null>(null);

  // Seed once from the server, then leave the operator's edits alone — a
  // revalidation mid-edit must not overwrite what they are typing.
  useEffect(() => {
    if (data && rows === null) {
      const keys = parseInstrumentAttributeKeys(data.keys);
      setRows(toRows(keys));
      setSaved(keys.join('\n'));
    }
  }, [data, rows]);

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

  const save = async () => {
    if (blocked || !dirty) return;
    setSaving(true);
    try {
      // Blank rows are dropped rather than refused: an operator who added a row
      // and changed their mind should not have to hunt for it to save.
      // `normalised` is the SAME value the dirty check compares against — built
      // once, so the button cannot disagree with what was sent.
      const keys = normalised;
      await apiClient.put('/api/config/dynamic/instrument-attributes', { keys });
      // Before the revalidation, not after: this is what makes the button go
      // quiet the moment the save lands, instead of staying lit until the next
      // keystroke.
      setSaved(keys);
      await mutate();
      toast.success('Attribute keys saved', `The New Instrument form now asks for ${kept} attribute${kept === 1 ? '' : 's'}.`);
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
            The attributes the New Instrument form asks for. You set the keys here;
            whoever registers a device fills in the values.
          </p>
        </div>
        <Link to="/config"><Button variant="secondary">Back to Settings</Button></Link>
      </div>

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
              No attribute keys. The New Instrument form will ask for none — add one below.
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
          Changes apply to the next instrument registered. Attributes already
          recorded on existing instruments are untouched.
        </p>
        <Link to="/config"><Button variant="secondary">Cancel</Button></Link>
        <Button type="button" disabled={saving || blocked || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}
