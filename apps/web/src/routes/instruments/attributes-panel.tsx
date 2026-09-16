import { useState } from 'react';
import useSWR from 'swr';
import {
  parseInstrumentAttributeKeys,
  placementColumnFor,
  canEditAttributeKey,
  canAddAttribute,
  type AttributeAccess,
} from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useAttributeLabels } from '@/hooks/use-attribute-labels';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { RemarkDialog } from './remark-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface Attribute {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Server-resolved presentation for a key that holds a reading (a limit, a
   * range). `display` is `value` at this instrument's own decimals; both are null
   * for a key that is not a reading. `value` remains exactly what was typed and
   * is what the alarm evaluator parses — never save `display` back.
   */
  slot?: 'temperature' | 'humidity' | null;
  decimals?: number | null;
  display?: string | null;
}

/**
 * Free-form per-instrument attributes.
 *
 * Reading is on INSTRUMENT_READ, so anyone who can open this page sees the
 * table; every mutation is on INSTRUMENT_UPDATE and is passed down as `canEdit`
 * from the route's `useCan('instruments.edit')`. Both halves are enforced by
 * the backend independently — the gating here decides what is rendered, not
 * what is permitted.
 *
 * ── PER-ROLE ACCESS (2026-08-19) ──
 * `INSTRUMENT_UPDATE` alone no longer decides. A role's rule — all editable, all
 * view-only, or a named set editable — comes from
 * `GET /api/instruments/attribute-access/me` and is applied here with the SAME
 * shared function the API enforces with. Never re-derive it: a second
 * implementation eventually renders an Edit button the server refuses, which
 * reads as the app being broken rather than as a policy.
 *
 * Changing or removing a recorded value now takes a MANDATORY remark, and a role
 * may be configured to need its password as well. Adding a key for the first time
 * takes neither — that is registration, and demanding a reason on every key of a
 * new instrument teaches people to type "x".
 *
 * They ARE audited by key (`INSTRUMENT_ATTRIBUTE_SET` / `_REMOVED`, carrying
 * before and after, and now the remark), because an attribute may hold something
 * like a calibration due date and a change to that is a §11 record.
 *
 * Editing is inline rather than in a dialog: the common act is correcting one
 * value against a physical label, and a modal makes the operator lose sight of
 * the neighbouring rows they are checking it against.
 *
 * ── CONFIGURED KEYS THIS INSTRUMENT DOES NOT HAVE (2026-08-07) ──
 * Adding a key in Configuration used to change the New Instrument form ONLY, so
 * an admin who added "Calibration Due" saw nothing happen on the fifty
 * instruments already registered — the key existed, and there was no way to
 * reach it short of retyping it by hand on every one. Those keys are listed here
 * too, as empty rows filled in in place.
 *
 * NOT back-filled: an unfilled key is left ABSENT rather than written as an
 * empty attribute. An empty string is a recorded fact in a §11 trail ("this was
 * measured and is blank"), and absent is the truth ("nobody has said yet").
 *
 * ── ONE LIST, NOT TWO (2026-08-19) ──
 * Those unset keys used to sit in a separate dashed block BELOW the table, which
 * made a key typed on this instrument look like it had landed somewhere other
 * than the profile's keys — two lists of the same kind of thing, and the operator
 * reasonably read the split as meaning something. It does not: both rows are
 * attributes of this instrument, and the only difference is whether a value has
 * been recorded yet. They are now interleaved in ONE table, in the profile's
 * configured order first (so it reads like the registration form) with any key
 * this instrument alone carries after it.
 *
 * What the merge deliberately does NOT do: typing a key here still does not add
 * it to the PROFILE. Profile keys are administered in Configuration precisely so
 * one operator's spelling cannot become a prompt on every other instrument —
 * that is the drift `alarm-limits`' alias lists exist to undo.
 */
export function AttributesPanel(
  { instrumentId, profileId, canEdit }:
  { instrumentId: string; profileId: string; canEdit: boolean },
) {
  const { toast } = useToast();
  const reauth = useReauth();
  const { labelFor } = useAttributeLabels();
  const key = `/api/instruments/${instrumentId}/attributes`;
  const { data, mutate } = useSWR<{ data: Attribute[] }>(key);
  /**
   * This caller's own rule. Fetched rather than derived: the server owns it, and
   * an unreachable endpoint must not silently widen what is offered — hence the
   * ALL_VIEW fallback below rather than "assume editable".
   */
  const { data: accessRes, error: accessError } = useSWR<{
    mode: string | null; keys: string[]; requireReauth: boolean;
  }>('/api/instruments/attribute-access/me', { revalidateOnFocus: false });
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
  /**
   * The change awaiting its mandatory remark. Holds the whole act, not just the
   * key: the dialog shows the before and after, and reading those off two other
   * pieces of state at render time is how a dialog comes to describe a different
   * change from the one it will submit.
   */
  const [pendingRemark, setPendingRemark] = useState<
    { kind: 'change' | 'remove'; key: string; from: string; to?: string } | null
  >(null);

  const rows = data?.data ?? [];
  const norm = (k: string) => k.trim().toLowerCase();

  // Until the rule has loaded, offer nothing. A brief read-only flash is right:
  // the alternative is showing Edit and then taking it away, or worse offering it
  // to a role the server will refuse.
  const accessLoaded = Boolean(accessRes) || Boolean(accessError);
  const access: AttributeAccess | null = accessRes?.mode
    ? {
        mode: accessRes.mode as AttributeAccess['mode'],
        keys: accessRes.keys ?? [],
        requireReauth: accessRes.requireReauth === true,
      }
    : null;
  // `canEdit` is the INSTRUMENT_UPDATE half; the rule narrows it and never widens
  // it, which is why both are passed to the one shared decision.
  const permitted = canEdit && accessLoaded && !accessError;
  const mayEdit = (k: string) => canEditAttributeKey(access, k, permitted);
  const mayAdd = canAddAttribute(access, permitted);
  /**
   * Configured keys this instrument has no value for.
   *
   * Placement keys (Block / Area / Location) are EXCLUDED: they are columns on
   * the instrument, edited in Details, and offering them here would write a
   * second copy as an attribute that nothing reads.
   */
  const profileKeys = parseInstrumentAttributeKeys(profile?.attributeKeys)
    .filter((k) => !placementColumnFor(k));

  /**
   * The one list.
   *
   * Profile order first — this table is also how an instrument gets filled in
   * after registration, and reading in a different order from the form that
   * created it is its own small confusion. Anything this instrument carries that
   * the profile does not ask for follows, in the order the API returned it.
   *
   * An unset row has `attr: null`. That is the ONLY difference between the two
   * kinds of row, and it is exactly the difference the operator needs to see:
   * "no value recorded" versus a recorded empty string.
   */
  // Tracked by the EXACT recorded key, not the folded one. `parseInstrument-
  // AttributeKeys` folds the profile's list, but the attributes table does not:
  // its unique index is `(instrument_id, key)` and Postgres compares case, so an
  // instrument can genuinely carry both `Room` and `room`. Folding here would
  // have matched the profile's `Room` to one of them and then swallowed the
  // other as "already listed" — hiding a recorded §11 value on a screen whose
  // whole job is to show them.
  const claimed = new Set<string>();
  const items: { key: string; attr: Attribute | null }[] = [];
  for (const k of profileKeys) {
    const hit = rows.find((r) => norm(r.key) === norm(k) && !claimed.has(r.key));
    if (hit) { items.push({ key: hit.key, attr: hit }); claimed.add(hit.key); }
    else if (mayAdd && !rows.some((r) => norm(r.key) === norm(k))) {
      items.push({ key: k, attr: null });
    }
  }
  for (const r of rows) {
    if (!claimed.has(r.key)) items.push({ key: r.key, attr: r });
  }
  /** Is anything listed that has never been answered? Drives the one footnote.
   *  Read off `items` rather than re-derived, so the note cannot disagree with
   *  the table it is describing. */
  const hasUnset = items.some((i) => i.attr === null);

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

  /**
   * Changing and removing both go through the remark dialog and then through
   * `reauth.execute`.
   *
   * The reauth action is not in `REAUTH_ACTIONS` — this prompt is driven by the
   * ROLE's attribute rule, which `my-actions` knows nothing about — so
   * `needsReauth()` is always false here and the dialog does NOT pre-open. The
   * first attempt goes out with no password, the backend answers 401
   * `REAUTH_REQUIRED`, and `execute` opens the dialog retroactively and replays
   * the call. That path already exists for the token actions and is tested;
   * reusing it keeps one prompt implementation instead of a bespoke second one
   * that would drift.
   */
  const save = async (attrKey: string, remark: string) => {
    setBusy(true);
    reauth.execute(
      'UPDATE_INSTRUMENT_ATTRIBUTE',
      async (password) => {
        const url = `${key}/${encodeURIComponent(attrKey)}`;
        const body = { value: editValue, reason: remark };
        if (password) await apiClient.putWithReauth(url, body, password);
        else await apiClient.put(url, body);
      },
      {
        onSuccess: async () => {
          setEditingKey(null);
          setPendingRemark(null);
          setBusy(false);
          await mutate();
          toast.success('Attribute updated', `"${attrKey}" saved.`);
        },
        // A cancel is not an error — but the busy flag was set before execute(),
        // so it MUST be cleared on this path or the panel locks up.
        onCancel: () => setBusy(false),
        onError: (err) => { setBusy(false); fail('Could not update attribute', err); },
      },
    );
  };

  const remove = async (attrKey: string, remark: string) => {
    setBusy(true);
    reauth.execute(
      'UPDATE_INSTRUMENT_ATTRIBUTE',
      async (password) => {
        const url = `${key}/${encodeURIComponent(attrKey)}`;
        const body = { reason: remark };
        if (password) await apiClient.deleteWithReauth(url, password, body);
        else await apiClient.delete(url, body);
      },
      {
        onSuccess: async () => {
          // Closed only after the request settles. Closing first would leave the
          // operator looking at a row that is still there if the delete fails.
          setPendingDelete(null);
          setPendingRemark(null);
          setBusy(false);
          await mutate();
          toast.success('Attribute removed', `"${attrKey}" deleted.`);
        },
        onCancel: () => setBusy(false),
        onError: (err) => {
          setPendingDelete(null);
          setBusy(false);
          fail('Could not remove attribute', err);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        {/* Counts what is RECORDED, not what is listed: the unset rows are
            prompts, and including them would overstate what this instrument
            actually says about itself. */}
        <CardTitle>Attributes ({rows.length} set)</CardTitle>
        {mayAdd && !adding && (
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

        {items.length === 0 ? (
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
                {(mayAdd || rows.some((r) => mayEdit(r.key))) && <TableHead className="w-40">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(({ key: k, attr: a }) => (
                <TableRow key={k}>
                  <TableCell className={a ? 'font-medium text-slate-800' : 'font-medium text-slate-500'}>
                    {/* The administered display name ONLY (2026-09-16,
                        operator: "in instruments page or settings page only
                        attributes display names should be display"). The KEY
                        is not printed; it rides in the tooltip and in every
                        button's accessible name, and it is what every request
                        and audit row carries. */}
                    <span title={k}>{labelFor(k)}</span>
                  </TableCell>
                  <TableCell>
                    {a === null ? (
                      // Configured but never answered. The input IS the value
                      // cell rather than a row in a separate block, so the list
                      // reads as one thing with some blanks in it.
                      <Input
                        className="max-w-xs"
                        value={fills[k] ?? ''}
                        autoComplete="off"
                        aria-label={k}
                        placeholder="Not set"
                        onChange={(e) => setFills((f) => ({ ...f, [k]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void fill(k); } }}
                      />
                    ) : editingKey === a.key ? (
                      <Input value={editValue} autoComplete="off" onChange={(e) => setEditValue(e.target.value)} />
                    ) : (
                      // An empty value is a legitimate state the backend
                      // accepts ("we track this, we do not know it yet"), so it
                      // gets a visible marker rather than a blank cell that
                      // reads as a rendering fault. Distinct from "Not set"
                      // above: this one WAS answered.
                      <span
                        className={a.value ? 'text-slate-700' : 'text-slate-400'}
                        title={a.display && a.display !== a.value ? `Stored as ${a.value}` : undefined}
                      >
                        {a.display ?? (a.value || '(empty)')}
                      </span>
                    )}
                  </TableCell>
                  {(mayAdd || rows.some((r) => mayEdit(r.key))) && (
                    <TableCell>
                      {a === null ? (
                        <Button
                          type="button" size="sm" variant="secondary"
                          disabled={busy || !(fills[k] ?? '').trim()}
                          onClick={() => void fill(k)}
                        >
                          Save
                        </Button>
                      ) : editingKey === a.key ? (
                        <div className="flex gap-2">
                          <Button
                            type="button" size="sm" disabled={busy}
                            onClick={() => setPendingRemark({
                              kind: 'change', key: a.key, from: a.value, to: editValue,
                            })}
                          >
                            Save
                          </Button>
                          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setEditingKey(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : mayEdit(a.key) ? (
                        <div className="flex gap-2">
                          <Button
                            type="button" size="sm" variant="secondary" disabled={busy}
                            // The STORED value, never `display` — saving a
                            // formatted string would rewrite the record to match
                            // a presentation choice.
                            onClick={() => { setEditingKey(a.key); setEditValue(a.value); }}
                          >
                            Edit
                          </Button>
                          {/*
                            A GHOST ICON, not a solid red button.

                            An instrument commonly carries two dozen attributes,
                            and a filled destructive button on every row turned
                            the panel into a wall of red — which spends the
                            alarm colour on a routine list and leaves nothing
                            louder for the states that are actually wrong.

                            Quieting it is safe here specifically because the
                            act is NOT one click: this opens the remark dialog,
                            and removing an attribute requires a typed reason
                            that goes to the audit trail. The button is the door,
                            not the deletion.

                            The accessible name carries the KEY. Twenty-four
                            buttons all announcing "Delete" are indistinguishable
                            to anyone not looking at the row they sit in.
                          */}
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            disabled={busy}
                            title={`Delete ${a.key}`}
                            aria-label={`Delete ${a.key}`}
                            className="text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            onClick={() => {
                              setPendingDelete(a.key);
                              setPendingRemark({ kind: 'remove', key: a.key, from: a.value });
                            }}
                          >
                            <svg aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </Button>
                        </div>
                      ) : (
                        // Said, not merely absent. A blank cell where a
                        // neighbouring row has buttons reads as a rendering fault;
                        // this is a policy and the operator should be able to see
                        // that it is one.
                        <span className="text-xs text-slate-400">View only</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {hasUnset && (
          <p className="text-xs text-slate-500">
            Rows marked “Not set” are keys configured for this profile. Left blank
            they stay unset — an empty value would record that someone checked and
            found nothing.
          </p>
        )}

      </CardContent>

      {/* One dialog for both acts. The old ConfirmDialog is gone from this panel:
          a removal now needs the same remark a change does, and having a confirm
          for one and a remark dialog for the other would have been two ways to
          ask about the same kind of §11 event. */}
      <RemarkDialog
        open={pendingRemark !== null}
        attributeKey={pendingRemark?.key ?? ''}
        from={pendingRemark?.from ?? ''}
        to={pendingRemark?.to}
        destructive={pendingRemark?.kind === 'remove'}
        busy={busy}
        onSubmit={(remark) => {
          if (!pendingRemark) return;
          if (pendingRemark.kind === 'remove') void remove(pendingRemark.key, remark);
          else void save(pendingRemark.key, remark);
        }}
        onClose={() => { setPendingRemark(null); setPendingDelete(null); }}
      />

      <ReauthDialog
        open={reauth.isOpen}
        actionLabel="Update Instrument Attribute"
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
      />
    </Card>
  );
}
