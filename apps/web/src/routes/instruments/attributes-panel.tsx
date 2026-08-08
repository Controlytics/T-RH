import { useState } from 'react';
import useSWR from 'swr';
import { parseInstrumentAttributeKeys, placementColumnFor } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface Attribute { key: string; value: string; createdAt: string; updatedAt: string }

/**
 * Free-form per-instrument attributes.
 *
 * Reading is on INSTRUMENT_READ, so anyone who can open this page sees the
 * table; every mutation is on INSTRUMENT_UPDATE and is passed down as `canEdit`
 * from the route's `useCan('instruments.edit')`. Both halves are enforced by
 * the backend independently — the gating here decides what is rendered, not
 * what is permitted.
 *
 * No re-auth: unlike the token endpoints these are ordinary registry edits.
 * They ARE audited by key (`INSTRUMENT_ATTRIBUTE_SET` / `_REMOVED`, carrying
 * before and after), because an attribute may hold something like a calibration
 * due date and a change to that is a §11 record.
 *
 * Editing is inline rather than in a dialog: the common act is correcting one
 * value against a physical label, and a modal makes the operator lose sight of
 * the neighbouring rows they are checking it against.
 *
 * ── CONFIGURED KEYS THIS INSTRUMENT DOES NOT HAVE (2026-08-07) ──
 * Adding a key in Configuration used to change the New Instrument form ONLY, so
 * an admin who added "Calibration Due" saw nothing happen on the fifty
 * instruments already registered — the key existed, and there was no way to
 * reach it short of retyping it by hand on every one. Those keys are now listed
 * here as empty rows, filled in in place.
 *
 * NOT back-filled: an unfilled key is left ABSENT rather than written as an
 * empty attribute. An empty string is a recorded fact in a §11 trail ("this was
 * measured and is blank"), and absent is the truth ("nobody has said yet").
 */
export function AttributesPanel(
  { instrumentId, profileId, canEdit }:
  { instrumentId: string; profileId: string; canEdit: boolean },
) {
  const { toast } = useToast();
  const key = `/api/instruments/${instrumentId}/attributes`;
  const { data, mutate } = useSWR<{ data: Attribute[] }>(key);
  // The administered key list for THIS instrument's profile (per-profile since
  // 2026-08-08). A failure here must not break the panel — an unreachable
  // profile simply offers no suggestions, which is safe because every attribute
  // already RECORDED still renders below regardless.
  const { data: profile } = useSWR<{ attributeKeys: string | null }>(
    profileId ? `/api/instrument-profiles/${profileId}` : null,
  );

  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  // The key of the row being edited — the key is the identity, so only the
  // value is editable in place. Renaming would be a delete plus an add, and
  // pretending otherwise would produce a trail that loses the old key's value.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  // The key awaiting delete confirmation. `window.confirm` was used here until
  // 2026-08-06: it is unstyled OS chrome in an app whose every other
  // confirmation is a themed dialog, and it blocks the JS thread, so nothing
  // else on the page can react while it is open.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** In-progress values for configured keys this instrument does not have yet. */
  const [fills, setFills] = useState<Record<string, string>>({});

  const rows = data?.data ?? [];
  /**
   * Configured keys this instrument has no value for.
   *
   * Placement keys (Block / Area / Location) are EXCLUDED: they are columns on
   * the instrument, edited in Details, and offering them here would write a
   * second copy as an attribute that nothing reads.
   */
  const have = new Set(rows.map((r) => r.key.trim().toLowerCase()));
  const missingKeys = parseInstrumentAttributeKeys(profile?.attributeKeys)
    .filter((k) => !placementColumnFor(k))
    .filter((k) => !have.has(k.trim().toLowerCase()));

  const fill = async (k: string) => {
    const value = (fills[k] ?? '').trim();
    if (!value) return;
    setBusy(true);
    try {
      await apiClient.post(key, { key: k, value });
      setFills((f) => ({ ...f, [k]: '' }));
      await mutate();
      toast.success('Attribute saved', `"${k}" set on this instrument.`);
    } catch (err) {
      fail('Could not save attribute', err);
    } finally {
      setBusy(false);
    }
  };

  const fail = (what: string, err: unknown) =>
    toast.error(what, (err as { message?: string })?.message ?? 'The change was not saved.');

  const add = async () => {
    const k = newKey.trim();
    if (!k) return;
    setBusy(true);
    try {
      // POST upserts on the key, so re-adding an existing key updates it rather
      // than failing — matching the backend, which is deliberately idempotent.
      await apiClient.post(key, { key: k, value: newValue });
      setNewKey(''); setNewValue(''); setAdding(false);
      await mutate();
      toast.success('Attribute saved', `"${k}" set on this instrument.`);
    } catch (err) {
      fail('Could not save attribute', err);
    } finally {
      setBusy(false);
    }
  };

  const save = async (attrKey: string) => {
    setBusy(true);
    try {
      await apiClient.put(`${key}/${encodeURIComponent(attrKey)}`, { value: editValue });
      setEditingKey(null);
      await mutate();
      toast.success('Attribute updated', `"${attrKey}" saved.`);
    } catch (err) {
      fail('Could not update attribute', err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (attrKey: string) => {
    setBusy(true);
    try {
      await apiClient.delete(`${key}/${encodeURIComponent(attrKey)}`);
      // Closed only after the request settles. Closing first would leave the
      // operator looking at a row that is still there if the delete fails.
      setPendingDelete(null);
      await mutate();
      toast.success('Attribute removed', `"${attrKey}" deleted.`);
    } catch (err) {
      setPendingDelete(null);
      fail('Could not remove attribute', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Attributes ({rows.length})</CardTitle>
        {canEdit && !adding && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Add attribute
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {adding && (
          <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[1fr_2fr_auto]">
            <Input
              value={newKey} autoComplete="off" placeholder="Key (e.g. Calibration Due)"
              onChange={(e) => setNewKey(e.target.value)}
            />
            <Input
              value={newValue} autoComplete="off" placeholder="Value (may be left empty)"
              onChange={(e) => setNewValue(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={busy || !newKey.trim()} onClick={() => void add()}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type="button" size="sm" variant="secondary" disabled={busy}
                onClick={() => { setNewKey(''); setNewValue(''); setAdding(false); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            No attributes recorded. Attributes hold anything this registry has no
            column for — a calibration due date, an asset number, a supplier
            reference. Each change is audited by key.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                {canEdit && <TableHead className="w-40">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.key}>
                  <TableCell className="font-medium text-slate-800">{a.key}</TableCell>
                  <TableCell>
                    {editingKey === a.key ? (
                      <Input value={editValue} autoComplete="off" onChange={(e) => setEditValue(e.target.value)} />
                    ) : (
                      // An empty value is a legitimate state the backend
                      // accepts ("we track this, we do not know it yet"), so it
                      // gets a visible marker rather than a blank cell that
                      // reads as a rendering fault.
                      <span className={a.value ? 'text-slate-700' : 'text-slate-400'}>
                        {a.value || '(empty)'}
                      </span>
                    )}
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      {editingKey === a.key ? (
                        <div className="flex gap-2">
                          <Button type="button" size="sm" disabled={busy} onClick={() => void save(a.key)}>
                            {busy ? 'Saving…' : 'Save'}
                          </Button>
                          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setEditingKey(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <Button
                            type="button" size="sm" variant="secondary" disabled={busy}
                            onClick={() => { setEditingKey(a.key); setEditValue(a.value); }}
                          >
                            Edit
                          </Button>
                          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => setPendingDelete(a.key)}>
                            Delete
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {canEdit && missingKeys.length > 0 && (
          <div className="space-y-2 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Configured, not set on this instrument
            </p>
            {missingKeys.map((k) => (
              <div key={k} className="flex flex-wrap items-center gap-2">
                <span className="w-40 shrink-0 text-sm font-medium text-slate-700">{k}</span>
                <Input
                  className="max-w-xs flex-1"
                  value={fills[k] ?? ''}
                  autoComplete="off"
                  aria-label={k}
                  placeholder="Not set"
                  onChange={(e) => setFills((f) => ({ ...f, [k]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void fill(k); } }}
                />
                <Button
                  type="button" size="sm" variant="secondary"
                  disabled={busy || !(fills[k] ?? '').trim()}
                  onClick={() => void fill(k)}
                >
                  Save
                </Button>
              </div>
            ))}
            <p className="text-xs text-slate-500">
              These keys are configured in Configuration → Instrument Attributes.
              Left blank they stay unset — an empty value would record that
              someone checked and found nothing.
            </p>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove attribute"
        message={<>Remove <span className="font-semibold text-red-700">{pendingDelete}</span> from this instrument?</>}
        warning="Its current value is kept in the audit trail, but not on the instrument."
        confirmLabel="Remove attribute"
        busyLabel="Removing…"
        busy={busy}
        onConfirm={() => { if (pendingDelete !== null) void remove(pendingDelete); }}
        onClose={() => setPendingDelete(null)}
      />
    </Card>
  );
}
