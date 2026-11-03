import { useEffect, useRef, useState } from 'react';
import { PlugZap, X } from 'lucide-react';
import {
  MODBUS_BYTE_ORDERS, MODBUS_BYTE_ORDER_LABELS, MODBUS_DATA_TYPES, MODBUS_MAX_KEYS, MODBUS_QUANTITY_TYPES,
  fromDesktopKeysFile, modbusRegisterMapSchema, parseModiconRef, registerRange, registersFor,
  type ModbusByteOrder, type ModbusDataType, type ModbusRegister, type ModbusRegisterMap,
} from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRowKeys } from '@/hooks/use-row-keys';
import { cn } from '@/lib/cn';
import { ALARM_BANNER_SOLID } from '@/routes/alarms/alarm-table';
import { CopyMapDialog } from './copy-map-dialog';
import {
  isAnswered, judgedWord, pillFor, runModbusTest, targetProblem, testBody,
  type Failure, type JudgedAs, type TestOutcome, type TestTarget,
} from './modbus-test';

export type { JudgedAs } from './modbus-test';

/**
 * Cell padding: a row of inputs has to fit a form card, so the table is
 * tighter than the shared default.
 */
const PAD = 'px-1.5 py-2';

/**
 * Column widths sit on the CONTROLS, never on the cells: Chrome ignores
 * `min-width` on a table cell, and a `w-full` control contributes no minimum of
 * its own, so at a 1240 px window with the sidebar open the Data type select
 * was squeezed to "FLOAT3" (render check, 2026-11-02). Register, Quantity and
 * Scale are fixed so the width they do not need goes to Key. The Byte order
 * select is `w-auto`: a native select then sizes to its longest option
 * ("Little-endian, byte swap (CDAB)"), and every row offers the same four, so
 * the column is one width and no label is clipped.
 */
const W = {
  key: 'min-w-[8rem]',
  register: 'w-24',
  quantity: 'w-16',
  dataType: 'min-w-[7rem]',
  byteOrder: 'w-auto',
  scale: 'w-20',
} as const;

/** The small line under a Key or Register control: what the reference reads, what the server judged. */
const CAPTION = 'mt-0.5 block text-[0.6875rem] leading-tight text-slate-500';

/**
 * EVERY column fits a 1240 px window with the sidebar open, in edit too (CR-1
 * fix round 1, render check): what the reference reads is a caption under the
 * Register, and in edit the server's judgement is a caption under the Key, so
 * no column of their own. The actions column (Test, Remove) stays pinned to
 * the right edge in case a narrower window does scroll: a sticky cell needs an
 * OPAQUE background, so the head cell takes the band's solid end colour (the
 * Alarms page's rule) and a body cell its row's.
 */
const STICKY = 'sticky right-0 shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.18)]';

/**
 * A row whose Quantity was changed carries NO data type (ledger Ruling CR1-1,
 * revised): the map holds this empty value, the Data type select shows
 * "Choose…", and the shared schema names it under the row — so nothing is
 * saved or tested until the operator picks one. A type of the other quantity
 * is never kept or guessed: it would read a believable wrong number.
 */
const NO_TYPE = '' as ModbusDataType;
const isDataType = (t: string): t is ModbusDataType => (MODBUS_DATA_TYPES as readonly string[]).includes(t);

/** What "+ Add key" opens: FLOAT32 (Quantity 2), its byte order left for the operator to choose. */
const NEW_ROW: ModbusRegister = { key: '', register: '', dataType: 'FLOAT32', scale: 1 };

const TEST_TITLE = 'Read this key from the device now — nothing is stored.';
const FIX_ROW = 'Fix this row first — see the message under it.';
const ADD_UNTESTED = 'Test the key first — Add is enabled once a value comes back.';
const ADD_READY = 'Add this key to the register map.';
const NO_TEST_HERE = 'Test is not available here — the key is added untested.';
const MAP_FULL = `The register map already holds ${MODBUS_MAX_KEYS} keys, the most it can.`;

/**
 * The key being added (2026-11-03): typed and tested in its own row under the
 * map, and in NO map — not `value`, not saved, not sent by Test connection —
 * until Add. `quantity` / `scaleText` are the rows' per-row UI state, for it.
 */
interface Draft { row: ModbusRegister; quantity?: 1 | 2; scaleText?: string }

/**
 * The register map of a TCP/IP (Modbus) instrument (spec §6, §12, §18 CR-1):
 * one row per key this server reads from the device — Key, Register (and under
 * it the area and references it reads), Quantity, Data type, Byte order (two
 * registers only), Scale, and Judged as (a column in the read view, a caption
 * under the Key in edit — fix round 1, so the edit table fits). No Unit
 * column (spec §6.1 ruling): a raw key's unit is set where it is shown, a
 * measured key's comes from its measurement.
 *
 * Everything this component says on its own is about the SHAPE of what was
 * typed, from the shared `modbusRegisterMapSchema` — the same schema the API
 * runs, so the words under a row are the words a 400 would carry. Quantity is
 * NOT stored (Ruling CR1-1): it is `registersFor` of the row's type, and only
 * while a changed Quantity has left the type unchosen is it held here, per row,
 * beside the map. What a row reads (area and references) is a pure parse of
 * the reference (`registerRange`). **Judged as is never decided here**: it is
 * the `judged` prop, the whole-map Test connection's `judgedAs` — "—" in the
 * read view for a key no response covered, no caption in edit — (root
 * CLAUDE.md "Never reconstruct server-side decision logic").
 *
 * With a `testTarget`, every row has a Test button (Ruling CR1-2): the same
 * `POST /api/instruments/modbus/test` with a ONE-key map, its answer printed on
 * a line under the row (Ruling CR1-5 — it does not write Judged as). The answer
 * is dropped when the row or the target changes, the panel's signature rule.
 *
 * **A key is TESTED before it is ADDED (2026-11-03, operator: "when key was
 * adding at that time give a test option before adding the key; once test is
 * completed value was coming then user will add that key").** "+ Add key"
 * opens ONE draft row under the map — the same six inputs, validated as the
 * map's next row so a duplicate key is named — with Test, Add and Cancel. Add
 * is enabled only once the draft's own Test brought a VALUE back (`ok` with a
 * value; a refusal, a failure or "Not readable" is not one), for the draft and
 * target as they stand; the answer follows the key onto its new row. With no
 * `testTarget` there is no test to wait for: Add takes a valid draft and says
 * the key goes in untested. The draft is local state: Cancel, leaving edit
 * (`readOnly`) and unmounting all discard it.
 *
 * Shared by New Instrument and the instrument page (`readOnly` there until a
 * super admin edits), so nothing page-specific lives here.
 */
export function RegisterMapEditor({
  value, onChange, judged, readOnly = false, testTarget,
}: {
  value: ModbusRegisterMap;
  onChange: (next: ModbusRegisterMap) => void;
  judged?: Record<string, JudgedAs>;
  readOnly?: boolean;
  /** Where a per-key Test reads. Absent = no Test buttons. */
  testTarget?: TestTarget;
}) {
  const rowKeys = useRowKeys(value.length);
  /**
   * The Scale text as typed, per row. The map holds a NUMBER, and an input
   * driven from it would turn "0." into "0" and "" into "0" mid-keystroke. The
   * text is shown only while it still parses to the stored number, so a map
   * replaced by an import or a copy shows its own scales.
   */
  const [scaleText, setScaleText] = useState<Record<string, string>>({});
  /** A Quantity chosen while the row's type is unchosen, per row key (UI state; never in the map). */
  const [quantity, setQuantity] = useState<Record<string, 1 | 2>>({});
  /** Per-key Test answers, each with the request it was read with. */
  const [answers, setAnswers] = useState<Record<string, { signature: string; outcome: TestOutcome }>>({});
  const [testing, setTesting] = useState<Record<string, true>>({});
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [copyOpen, setCopyOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  /** The draft's Test answer, with the request it was read with. */
  const [draftAnswer, setDraftAnswer] = useState<{ signature: string; outcome: TestOutcome } | null>(null);
  const [draftTesting, setDraftTesting] = useState(false);
  /** Bumped whenever a draft opens or closes: an answer for a draft that has gone is dropped. */
  const draftGen = useRef(0);
  /**
   * The draft's answer, handed to the row Add appended. That row's key exists
   * only on the next render, so the signature effect below adopts it there —
   * once, and only if the row at that index is still the request it answers.
   */
  const carry = useRef<{ index: number; signature: string; outcome: TestOutcome } | null>(null);

  const issues = readOnly ? { rows: new Map<number, string[]>(), map: [] as string[] } : mapIssues(value);

  /** What a per-key Test of this row would send, serialised — its answer's signature. */
  const signatureOf = (row: ModbusRegister): string => (testTarget ? JSON.stringify(testBody(testTarget, [row])) : '');
  const signatures = value.map((row, i) => [rowKeys.at(i), signatureOf(row)] as const);
  const live = useRef(new Map<string, string>());
  live.current = new Map(signatures);
  const liveOrder = useRef<string[]>([]);
  liveOrder.current = signatures.map(([k]) => k);
  const signaturesKey = JSON.stringify(signatures);
  // A row (or the target) changed under its answer, or the row went: drop it.
  // And a key just added from the draft takes the draft's answer with it.
  useEffect(() => {
    const handed = carry.current;
    carry.current = null;
    setAnswers((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [k, a] of Object.entries(prev)) {
        if (live.current.get(k) === a.signature) next[k] = a;
        else changed = true;
      }
      const rk = handed ? liveOrder.current[handed.index] : undefined;
      if (handed && rk !== undefined && live.current.get(rk) === handed.signature) {
        next[rk] = { signature: handed.signature, outcome: handed.outcome };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [signaturesKey]);

  /** What a Test of the draft would send, serialised; null with no draft or no target. */
  const draftSig = draft && testTarget ? JSON.stringify(testBody(testTarget, [draft.row])) : null;
  const draftLive = useRef<string | null>(null);
  draftLive.current = draftSig;
  // The rows' rule, for the draft: the draft (or the target) changed under its
  // answer, or the draft went — DROP the answer, so putting the draft back as
  // it was does not bring it (or Add) back.
  useEffect(() => {
    setDraftAnswer((a) => (a && a.signature !== draftSig ? null : a));
  }, [draftSig]);

  const closeDraft = () => {
    draftGen.current += 1;
    setDraft(null);
    setDraftAnswer(null);
    setDraftTesting(false);
  };
  // Leaving edit discards the draft: the instrument page keeps this editor
  // mounted between its read and edit views, so it would come back otherwise.
  useEffect(() => {
    if (readOnly) closeDraft();
  }, [readOnly]);

  const setRow = (i: number, next: ModbusRegister) => onChange(value.map((r, j) => (j === i ? next : r)));

  const setDataType = (i: number, dataType: ModbusDataType) => {
    const rk = rowKeys.at(i);
    setQuantity(({ [rk]: _gone, ...others }) => others);
    setRow(i, withDataType(value[i]!, dataType));
  };

  /** Quantity → the other value clears the type (Ruling CR1-1); one register drops the byte order. */
  const setRowQuantity = (i: number, q: 1 | 2) => {
    const row = value[i]!;
    const rk = rowKeys.at(i);
    if (q === quantityFor(row, quantity[rk])) return;
    setQuantity((m) => ({ ...m, [rk]: q }));
    setRow(i, withQuantity(row, q));
  };

  const setScale = (i: number, raw: string) => {
    setScaleText((t) => ({ ...t, [rowKeys.at(i)]: raw }));
    setRow(i, { ...value[i]!, scale: parseScale(raw) });
  };

  const removeRow = (i: number) => {
    const rk = rowKeys.at(i);
    setQuantity(({ [rk]: _gone, ...others }) => others);
    rowKeys.remove(i);
    onChange(value.filter((_, j) => j !== i));
  };

  /** Import and Copy REPLACE the map; rows already typed are not dropped unasked. */
  const replace = (next: ModbusRegisterMap): boolean => {
    if (value.length > 0 && !window.confirm(
      `Replace the ${value.length} key${value.length === 1 ? '' : 's'} in this register map?`,
    )) return false;
    // The rows are new: no Quantity chosen for an old row may follow its index.
    setQuantity({});
    onChange(next);
    return true;
  };

  const testRow = async (i: number) => {
    if (!testTarget) return;
    const row = value[i]!;
    const rk = rowKeys.at(i);
    const sent = signatureOf(row);
    setTesting((t) => ({ ...t, [rk]: true }));
    const outcome = await runModbusTest(testBody(testTarget, [row]));
    setTesting(({ [rk]: _done, ...others }) => others);
    // Answered for a row (or target) that has since changed: it describes nothing on screen.
    if (live.current.get(rk) !== sent) return;
    setAnswers((a) => ({ ...a, [rk]: { signature: sent, outcome } }));
  };

  const openDraft = () => {
    if (draft || value.length >= MODBUS_MAX_KEYS) return;
    draftGen.current += 1;
    setDraftAnswer(null);
    setDraftTesting(false);
    setDraft({ row: NEW_ROW });
  };
  const editDraft = (next: (d: Draft) => Draft) => setDraft((d) => (d ? next(d) : d));

  const testDraft = async () => {
    if (!testTarget || !draft || draftSig === null) return;
    const gen = draftGen.current;
    const sent = draftSig;
    setDraftTesting(true);
    const outcome = await runModbusTest(testBody(testTarget, [draft.row]));
    // The draft was added, cancelled or left meanwhile: nothing on screen asked.
    if (draftGen.current !== gen) return;
    setDraftTesting(false);
    // Answered for a draft (or target) that has since changed.
    if (draftLive.current !== sent) return;
    setDraftAnswer({ signature: sent, outcome });
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Clear so choosing the same file again (after fixing it) fires again.
      input.value = '';
      let json: unknown;
      try {
        json = JSON.parse(String(reader.result ?? ''));
      } catch (err) {
        setImportErrors([`${file.name} is not a JSON file: ${(err as Error).message}`]);
        return;
      }
      // All or nothing: the converter names every bad row and returns no map.
      const converted = fromDesktopKeysFile(json);
      if (!converted.ok) {
        setImportErrors(converted.errors);
        return;
      }
      if (replace(converted.map)) setImportErrors([]);
    };
    reader.onerror = () => {
      input.value = '';
      setImportErrors([`${file.name} could not be read.`]);
    };
    reader.readAsText(file);
  };

  const targetBlocked = testTarget ? targetProblem(testTarget) : null;
  const actions = !readOnly || testTarget !== undefined;
  const headings = ['Key', 'Register', 'Quantity', 'Data type', 'Byte order', 'Scale', ...(readOnly ? ['Judged as'] : [])];
  const columns = headings.length + (actions ? 1 : 0);

  // The draft, judged as the map's NEXT row: a key or register another row
  // already has is named under it, in the schema's words.
  const shownDraft = readOnly ? null : draft;
  const draftIssues = shownDraft ? (mapIssues([...value, shownDraft.row]).rows.get(value.length) ?? []) : [];
  const draftOutcome = draftAnswer && draftAnswer.signature === draftSig ? draftAnswer.outcome : null;
  // A VALUE came back: an `ok` answer naming one. A refusal, a failure and a
  // "Not readable" key are answers too, and none of them is a value.
  const valueBack = draftOutcome !== null && isAnswered(draftOutcome) && draftOutcome.values.length > 0;
  const draftTestBlocked = targetBlocked ?? (draftIssues.length > 0 ? FIX_ROW : null);
  const addBlocked = value.length >= MODBUS_MAX_KEYS ? MAP_FULL
    : draftIssues.length > 0 ? FIX_ROW
      : testTarget && !valueBack ? ADD_UNTESTED
        : null;

  const addDraft = () => {
    if (!shownDraft || addBlocked !== null) return;
    if (draftSig !== null && draftOutcome) carry.current = { index: value.length, signature: draftSig, outcome: draftOutcome };
    const row = shownDraft.row;
    closeDraft();
    onChange([...value, row]);
  };

  return (
    <div className="space-y-3">
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setCopyOpen(true)}>
            Copy from instrument…
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
            Import keys file
          </Button>
          {/* The real control; the button above opens it. Labelled so it is
              reachable (and testable) without the button. */}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            aria-label="Import keys file"
            className="sr-only"
            tabIndex={-1}
            onChange={onFile}
          />
          <Button type="button" size="sm" onClick={openDraft} disabled={draft !== null || value.length >= MODBUS_MAX_KEYS}>
            + Add key
          </Button>
        </div>
      )}

      {importErrors.length > 0 && (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <p className="font-semibold">The keys file was not imported — nothing changed.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {importErrors.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            {headings.map((h) => (
              <TableHead key={h} className={cn(PAD, 'whitespace-nowrap')}>{h}</TableHead>
            ))}
            {actions && (
              <TableHead className={cn(PAD, STICKY)} style={ALARM_BANNER_SOLID}><span className="sr-only">Actions</span></TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {value.length === 0 && !shownDraft && <TableEmpty colSpan={columns} title="No keys" />}
          {value.map((row, i) => {
            const n = i + 1;
            const rk = rowKeys.at(i);
            const q = quantityFor(row, quantity[rk]);
            const rowIssues = issues.rows.get(i);
            const answer = answers[rk];
            const shown = answer && answer.signature === signatureOf(row) ? answer.outcome : null;
            const testBlocked = targetBlocked
              ?? (rowIssues && rowIssues.length > 0 ? FIX_ROW : null);
            return (
              <MapRow key={rk} errors={rowIssues} answer={shown} columns={columns} id={i}>
                {readOnly ? <ReadCells index={i} row={row} quantity={q} judged={judged} /> : (
                  <EditCells
                    id={i}
                    label={`row ${n}`}
                    row={row}
                    quantity={q}
                    scaleShown={scaleShownFor(row, scaleText[rk])}
                    judgedCaption={judgedWord(judgedOf(judged, row.key) ?? null)}
                    onRow={(next) => setRow(i, next)}
                    onQuantity={(next) => setRowQuantity(i, next)}
                    onDataType={(t) => setDataType(i, t)}
                    onScale={(raw) => setScale(i, raw)}
                  />
                )}
                {actions && (
                  <TableCell className={cn(PAD, STICKY, 'whitespace-nowrap bg-inherit text-right')}>
                    {testTarget && (
                      // The title is on the wrapper too: a disabled button
                      // takes no pointer events, so its own title never shows.
                      <span title={testBlocked ?? undefined} className="inline-flex">
                        <Button
                          type="button" size="icon-sm" variant="ghost"
                          aria-label={`Test key, row ${n}`}
                          title={testBlocked ?? TEST_TITLE}
                          disabled={testBlocked !== null}
                          loading={testing[rk] === true}
                          onClick={() => void testRow(i)}
                        >
                          <PlugZap className="h-4 w-4" aria-hidden />
                        </Button>
                      </span>
                    )}
                    {!readOnly && (
                      <Button
                        type="button" size="icon-sm" variant="ghost"
                        aria-label={`Remove row ${n}`}
                        onClick={() => removeRow(i)}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </TableCell>
                )}
              </MapRow>
            );
          })}
          {shownDraft && (
            <MapRow
              key="draft"
              errors={draftIssues}
              answer={draftOutcome}
              columns={columns}
              id="draft"
              note={testTarget ? undefined : NO_TEST_HERE}
            >
              <EditCells
                id="draft"
                label="new key"
                autoFocus
                row={shownDraft.row}
                quantity={quantityFor(shownDraft.row, shownDraft.quantity)}
                scaleShown={scaleShownFor(shownDraft.row, shownDraft.scaleText)}
                judgedCaption={null}
                onRow={(next) => editDraft((d) => ({ ...d, row: next }))}
                onQuantity={(q) => editDraft((d) => (q === quantityFor(d.row, d.quantity)
                  ? d
                  : { ...d, quantity: q, row: withQuantity(d.row, q) }))}
                onDataType={(t) => editDraft((d) => ({ ...d, quantity: undefined, row: withDataType(d.row, t) }))}
                onScale={(raw) => editDraft((d) => ({ ...d, scaleText: raw, row: { ...d.row, scale: parseScale(raw) } }))}
              />
              {/* Test and Cancel where a row has Test and Remove, Add under
                  them: the actions column keeps the width the rows give it. */}
              <TableCell className={cn(PAD, STICKY, 'whitespace-nowrap bg-inherit text-right')}>
                <div className="inline-flex flex-col items-stretch gap-1">
                  <div className="flex justify-end">
                    {testTarget && (
                      <span title={draftTestBlocked ?? undefined} className="inline-flex">
                        <Button
                          type="button" size="icon-sm" variant="ghost"
                          aria-label="Test new key"
                          title={draftTestBlocked ?? TEST_TITLE}
                          disabled={draftTestBlocked !== null}
                          loading={draftTesting}
                          onClick={() => void testDraft()}
                        >
                          <PlugZap className="h-4 w-4" aria-hidden />
                        </Button>
                      </span>
                    )}
                    <Button
                      type="button" size="icon-sm" variant="ghost"
                      aria-label="Cancel new key"
                      title="Discard this key — nothing is added."
                      onClick={closeDraft}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                  <span title={addBlocked ?? undefined} className="flex">
                    <Button
                      type="button" size="sm" className="w-full"
                      title={addBlocked ?? ADD_READY}
                      disabled={addBlocked !== null}
                      onClick={addDraft}
                    >
                      Add
                    </Button>
                  </span>
                </div>
              </TableCell>
            </MapRow>
          )}
        </TableBody>
      </Table>

      {issues.map.length > 0 && (
        <p className="text-xs text-rose-600">{issues.map.join(' ')}</p>
      )}

      {!readOnly && (
        <CopyMapDialog
          open={copyOpen}
          onClose={() => setCopyOpen(false)}
          onCopy={(map) => { if (replace(map)) setCopyOpen(false); }}
        />
      )}
    </div>
  );
}

/**
 * One row's six inputs — a map row's or the draft's, so the draft is typed
 * exactly as a row is. `label` ends every control's name ("Key, row 2",
 * "Key, new key"); `id` ends the captions' test ids.
 */
function EditCells({
  id, label, row, quantity, scaleShown, judgedCaption, autoFocus, onRow, onQuantity, onDataType, onScale,
}: {
  id: number | 'draft';
  label: string;
  row: ModbusRegister;
  quantity: 1 | 2;
  scaleShown: string;
  judgedCaption: string | null;
  autoFocus?: boolean;
  onRow: (next: ModbusRegister) => void;
  onQuantity: (q: 1 | 2) => void;
  onDataType: (t: ModbusDataType) => void;
  onScale: (raw: string) => void;
}) {
  const typed = isDataType(row.dataType);
  return (
    <>
      <TableCell className={PAD}>
        <Input
          aria-label={`Key, ${label}`}
          className={W.key}
          autoFocus={autoFocus}
          value={row.key}
          onChange={(e) => onRow({ ...row, key: e.target.value })}
        />
        {judgedCaption && (
          <span data-testid={`map-judged-${id}`} className={CAPTION}>Judged as {judgedCaption}</span>
        )}
      </TableCell>
      <TableCell className={PAD}>
        <Input
          aria-label={`Register, ${label}`}
          className={W.register}
          inputMode="numeric"
          value={row.register}
          onChange={(e) => onRow({ ...row, register: e.target.value.trim() })}
        />
        <ReadsCaption id={id} row={row} quantity={quantity} />
      </TableCell>
      <TableCell data-testid={`map-quantity-${id}`} className={PAD}>
        <Select
          aria-label={`Quantity, ${label}`}
          className={W.quantity}
          value={String(quantity)}
          onChange={(e) => onQuantity(e.target.value === '1' ? 1 : 2)}
        >
          <option value="1">1</option>
          <option value="2">2</option>
        </Select>
      </TableCell>
      <TableCell className={PAD}>
        <Select
          aria-label={`Data type, ${label}`}
          className={W.dataType}
          value={typed ? row.dataType : ''}
          onChange={(e) => { if (isDataType(e.target.value)) onDataType(e.target.value); }}
        >
          {!typed && <option value="">Choose…</option>}
          {MODBUS_QUANTITY_TYPES[quantity].map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </TableCell>
      <TableCell data-testid={`map-byte-order-${id}`} className={cn(PAD, 'whitespace-nowrap')}>
        {quantity === 1 ? <span className="text-slate-400">—</span> : (
          <Select
            aria-label={`Byte order, ${label}`}
            className={W.byteOrder}
            value={row.byteOrder ?? ''}
            onChange={(e) => onRow(withByteOrder(row, e.target.value))}
          >
            <option value="">Choose…</option>
            {MODBUS_BYTE_ORDERS.map((o) => <option key={o} value={o}>{MODBUS_BYTE_ORDER_LABELS[o]}</option>)}
          </Select>
        )}
      </TableCell>
      <TableCell className={PAD}>
        <Input
          aria-label={`Scale, ${label}`}
          className={W.scale}
          type="number"
          step="any"
          value={scaleShown}
          onChange={(e) => onScale(e.target.value)}
        />
      </TableCell>
    </>
  );
}

/** One row of the read view: the same columns as text, plus Judged as. */
function ReadCells({
  index, row, quantity, judged,
}: {
  index: number;
  row: ModbusRegister;
  quantity: 1 | 2;
  judged: Record<string, JudgedAs> | undefined;
}) {
  return (
    <>
      <TableCell className={PAD}>
        {/* A long key wraps after its underscores rather than widening the table. */}
        <span className="font-medium text-slate-800 break-words">{softBreaks(row.key)}</span>
      </TableCell>
      <TableCell className={PAD}>
        <span className="tabular-nums">{row.register}</span>
        <ReadsCaption id={index} row={row} quantity={quantity} />
      </TableCell>
      <TableCell data-testid={`map-quantity-${index}`} className={PAD}>
        <span className="tabular-nums">{quantity}</span>
      </TableCell>
      <TableCell className={PAD}>{row.dataType}</TableCell>
      <TableCell data-testid={`map-byte-order-${index}`} className={cn(PAD, 'whitespace-nowrap')}>
        {quantity === 1 ? <span className="text-slate-400">—</span> : (row.byteOrder ? MODBUS_BYTE_ORDER_LABELS[row.byteOrder] : '—')}
      </TableCell>
      <TableCell className={PAD}>
        <span className="tabular-nums">× {scaleToText(row.scale)}</span>
      </TableCell>
      <TableCell data-testid={`map-judged-${index}`} className={cn(PAD, 'whitespace-nowrap')}>{judgedText(judged, row.key)}</TableCell>
    </>
  );
}

/** Under the Register: what it reads; may wrap after the "·" so it never widens the column. */
function ReadsCaption({ id, row, quantity }: { id: number | 'draft'; row: ModbusRegister; quantity: 1 | 2 }) {
  const reads = readsOf(row.register, isDataType(row.dataType) ? row.dataType : MODBUS_QUANTITY_TYPES[quantity][0]!);
  return (
    <span data-testid={`map-reads-${id}`} className={CAPTION}>
      {reads ? <>{reads.area} · <span className="whitespace-nowrap tabular-nums">{reads.range}</span></> : '—'}
    </span>
  );
}

/**
 * A row (or the draft); its per-key Test answer on the line beneath (Ruling
 * CR1-5); the shared schema's messages for it under that; and, for the draft,
 * a note on how it will be added.
 */
function MapRow({
  children, errors, answer, columns, id, note,
}: {
  children: React.ReactNode;
  errors: string[] | undefined;
  answer: TestOutcome | null;
  columns: number;
  id: number | 'draft';
  note?: string;
}) {
  return (
    <>
      <TableRow>{children}</TableRow>
      {answer && (
        <tr>
          <td colSpan={columns} data-testid={`map-test-${id}`} className="bg-slate-50/80 px-4 py-1.5 text-xs">
            <RowAnswer outcome={answer} />
          </td>
        </tr>
      )}
      {errors && errors.length > 0 && (
        <tr>
          <td colSpan={columns} data-testid={`map-errors-${id}`} className="bg-rose-50/60 px-4 py-1.5 text-xs text-rose-700">
            {errors.join(' · ')}
          </td>
        </tr>
      )}
      {note && (
        <tr>
          <td colSpan={columns} data-testid={`map-note-${id}`} className="px-4 py-1.5 text-right text-xs text-slate-500">
            {note}
          </td>
        </tr>
      )}
    </>
  );
}

/** One key's answer, in the server's words: the value read, why it was not readable, or why nothing was read. */
function RowAnswer({ outcome }: { outcome: TestOutcome }) {
  if (!isAnswered(outcome)) {
    const pill = pillFor(outcome as Failure);
    return (
      <span role="alert" className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={pill.tone} label={pill.word} />
        <span className="text-slate-800">{outcome.message}</span>
      </span>
    );
  }
  const value = outcome.values[0];
  if (value) {
    const word = judgedWord(value.judgedAs);
    return (
      <span role="status" className="text-slate-800">
        Read now: <span className="font-semibold tabular-nums">{String(value.value)}</span>
        {word && <span className="text-slate-600"> · judged as {word}</span>}
      </span>
    );
  }
  const rejected = outcome.rejected[0];
  return (
    <span role="status">
      <span className="font-medium text-rose-700">Not readable</span>
      <span className="text-slate-600"> — {rejected ? rejected.reason : 'the answer named no value for this key.'}</span>
    </span>
  );
}

/** A row's Quantity: its type's register count, else the Quantity chosen while the type is unset (else 2). */
function quantityFor(row: ModbusRegister, chosen: 1 | 2 | undefined): 1 | 2 {
  return isDataType(row.dataType) ? registersFor(row.dataType) : (chosen ?? 2);
}

/**
 * Another data type. A 16-bit type has no byte order (the schema refuses one).
 * A 32-bit type keeps the order the row had and is otherwise left for the
 * operator to CHOOSE: a wrong byte order reads a believable wrong number, never
 * an error, so the form does not pick one for them.
 */
function withDataType(row: ModbusRegister, dataType: ModbusDataType): ModbusRegister {
  const { byteOrder, ...rest } = row;
  return registersFor(dataType) === 2 && byteOrder ? { ...rest, dataType, byteOrder } : { ...rest, dataType };
}

/** Another Quantity: the type is CLEARED (Ruling CR1-1); one register drops the byte order. */
function withQuantity(row: ModbusRegister, q: 1 | 2): ModbusRegister {
  const { byteOrder, ...rest } = row;
  return q === 2 && byteOrder ? { ...rest, dataType: NO_TYPE, byteOrder } : { ...rest, dataType: NO_TYPE };
}

/** The byte order chosen; "" (Choose…) leaves none. */
function withByteOrder(row: ModbusRegister, raw: string): ModbusRegister {
  const { byteOrder: _old, ...rest } = row;
  return raw ? { ...rest, byteOrder: raw as ModbusByteOrder } : rest;
}

/** The Scale as typed while it still parses to the stored number, else the number. */
function scaleShownFor(row: ModbusRegister, typed: string | undefined): string {
  return typed !== undefined && sameNumber(parseScale(typed), row.scale) ? typed : scaleToText(row.scale);
}

/** The schema's issues, by row index; map-level issues (e.g. too many keys) apart. */
function mapIssues(map: ModbusRegisterMap): { rows: Map<number, string[]>; map: string[] } {
  const rows = new Map<number, string[]>();
  const whole: string[] = [];
  const parsed = modbusRegisterMapSchema.safeParse(map);
  if (parsed.success) return { rows, map: whole };
  for (const issue of parsed.error.issues) {
    const i = issue.path[0];
    if (typeof i === 'number') {
      const list = rows.get(i) ?? [];
      if (!list.includes(issue.message)) list.push(issue.message);
      rows.set(i, list);
    } else if (!whole.includes(issue.message)) {
      whole.push(issue.message);
    }
  }
  return { rows, map: whole };
}

/**
 * What a row reads: the area and the references, "40001–40002" (or "40001"
 * for one register), both pure parses of the reference typed. `null` when the
 * reference does not parse — the schema's message for it is printed under the
 * row, so the throw is the parse's answer, not a swallowed error. A span that
 * runs past its area's end names the area and "—" (the schema says why).
 */
function readsOf(ref: string, dataType: ModbusDataType): { area: string; range: string } | null {
  let area: string;
  try {
    area = parseModiconRef(ref).area === 'HOLDING' ? 'Holding' : 'Input';
  } catch {
    return null;
  }
  const r = registerRange(ref, dataType);
  return { area, range: !r ? '—' : r.first === r.last ? r.first : `${r.first}–${r.last}` };
}

/**
 * The response's answer for a key: the server parses the map with a schema
 * that TRIMS keys, so the lookup does too. `undefined` = no response covered
 * it; `null` = covered and not judged.
 */
function judgedOf(judged: Record<string, JudgedAs> | undefined, key: string): JudgedAs | undefined {
  const k = key.trim();
  if (!judged || !Object.prototype.hasOwnProperty.call(judged, k)) return undefined;
  return judged[k] ?? null;
}

/** The read view's Judged as cell: "—" when no response covered the key. */
function judgedText(judged: Record<string, JudgedAs> | undefined, key: string): string {
  const j = judgedOf(judged, key);
  return j === undefined ? '—' : judgedWord(j) ?? 'Not judged';
}

/**
 * A key with a line-break opportunity after each underscore, so
 * `Differential_Pressure_Corridor_to_Room_12` wraps between its words, never
 * mid-word. The text (and so its copy, search and accessible name) is unchanged.
 */
function softBreaks(key: string): React.ReactNode {
  const parts = key.split('_');
  return parts.map((p, i) => (i < parts.length - 1
    ? <span key={i}>{p}_<wbr /></span>
    : <span key={i}>{p}</span>));
}

/** "" is no scale (NaN — the schema says "Scale must be a number"), never 0. */
function parseScale(raw: string): number {
  return raw.trim() === '' ? Number.NaN : Number(raw);
}
function sameNumber(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}
function scaleToText(n: number): string {
  return Number.isNaN(n) ? '' : String(n);
}
