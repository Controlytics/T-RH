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
 * Cell padding: nine columns of inputs have to fit a form card, so the table
 * is tighter than the shared default.
 */
const PAD = 'px-2 py-2';

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
  key: 'min-w-[9rem]',
  register: 'w-24',
  quantity: 'w-16',
  dataType: 'min-w-[7rem]',
  byteOrder: 'w-auto',
  scale: 'w-24',
} as const;

/**
 * Nine columns do not fit a 1240 px window with the sidebar open — the table
 * scrolls sideways inside its card (render check, CR-1). The actions column
 * (Test, Remove) is pinned to the right edge so it is never what scrolled out
 * of sight: a sticky cell needs an OPAQUE background, so the head cell takes the
 * band's solid end colour (the Alarms page's rule) and a body cell its row's.
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

/**
 * The register map of a TCP/IP (Modbus) instrument (spec §6, §12, §18 CR-1):
 * one row per key this server reads from the device — Key, Register, Quantity,
 * Reads, Data type, Byte order (two registers only), Scale, Judged as. No Unit
 * column (spec §6.1 ruling): a raw key's unit is set where it is shown, a
 * measured key's comes from its measurement.
 *
 * Everything this component says on its own is about the SHAPE of what was
 * typed, from the shared `modbusRegisterMapSchema` — the same schema the API
 * runs, so the words under a row are the words a 400 would carry. Quantity is
 * NOT stored (Ruling CR1-1): it is `registersFor` of the row's type, and only
 * while a changed Quantity has left the type unchosen is it held here, per row,
 * beside the map. Reads (area and the references read) is a pure parse of the
 * reference (`registerRange`). **Judged as is never decided here**: it is the
 * `judged` prop, the whole-map Test connection's `judgedAs`, and "—" for a key
 * no response covered (root CLAUDE.md "Never reconstruct server-side decision
 * logic").
 *
 * With a `testTarget`, every row has a Test button (Ruling CR1-2): the same
 * `POST /api/instruments/modbus/test` with a ONE-key map, its answer printed on
 * a line under the row (Ruling CR1-5 — it does not write Judged as). The answer
 * is dropped when the row or the target changes, the panel's signature rule.
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

  const issues = readOnly ? { rows: new Map<number, string[]>(), map: [] as string[] } : mapIssues(value);

  const quantityOf = (row: ModbusRegister, rk: string): 1 | 2 =>
    isDataType(row.dataType) ? registersFor(row.dataType) : (quantity[rk] ?? 2);

  /** What a per-key Test of this row would send, serialised — its answer's signature. */
  const signatureOf = (row: ModbusRegister): string => (testTarget ? JSON.stringify(testBody(testTarget, [row])) : '');
  const signatures = value.map((row, i) => [rowKeys.at(i), signatureOf(row)] as const);
  const live = useRef(new Map<string, string>());
  live.current = new Map(signatures);
  const signaturesKey = JSON.stringify(signatures);
  // A row (or the target) changed under its answer, or the row went: drop it.
  useEffect(() => {
    setAnswers((prev) => {
      let dropped = false;
      const next: typeof prev = {};
      for (const [k, a] of Object.entries(prev)) {
        if (live.current.get(k) === a.signature) next[k] = a;
        else dropped = true;
      }
      return dropped ? next : prev;
    });
  }, [signaturesKey]);

  const setRow = (i: number, next: ModbusRegister) => onChange(value.map((r, j) => (j === i ? next : r)));

  const setDataType = (i: number, dataType: ModbusDataType) => {
    const { byteOrder, ...rest } = value[i]!;
    const rk = rowKeys.at(i);
    setQuantity(({ [rk]: _gone, ...others }) => others);
    // A 16-bit type has no byte order (the schema refuses one). A 32-bit type
    // keeps the order the row had and is otherwise left for the operator to
    // CHOOSE: a wrong byte order reads a believable wrong number, never an
    // error, so the form does not pick one for them.
    setRow(i, registersFor(dataType) === 2 && byteOrder ? { ...rest, dataType, byteOrder } : { ...rest, dataType });
  };

  /** Quantity → the other value clears the type (Ruling CR1-1); one register drops the byte order. */
  const setRowQuantity = (i: number, q: 1 | 2) => {
    const row = value[i]!;
    const rk = rowKeys.at(i);
    if (q === quantityOf(row, rk)) return;
    setQuantity((m) => ({ ...m, [rk]: q }));
    const { byteOrder, ...rest } = row;
    setRow(i, q === 2 && byteOrder ? { ...rest, dataType: NO_TYPE, byteOrder } : { ...rest, dataType: NO_TYPE });
  };

  const setByteOrder = (i: number, raw: string) => {
    const { byteOrder: _old, ...rest } = value[i]!;
    setRow(i, raw ? { ...rest, byteOrder: raw as ModbusByteOrder } : rest);
  };

  const setScale = (i: number, raw: string) => {
    setScaleText((t) => ({ ...t, [rowKeys.at(i)]: raw }));
    setRow(i, { ...value[i]!, scale: parseScale(raw) });
  };

  const addRow = () => onChange([...value, { key: '', register: '', dataType: 'FLOAT32', scale: 1 }]);

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
  const columns = 8 + (actions ? 1 : 0);

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
          <Button type="button" size="sm" onClick={addRow} disabled={value.length >= MODBUS_MAX_KEYS}>
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
            {['Key', 'Register', 'Quantity', 'Reads', 'Data type', 'Byte order', 'Scale', 'Judged as'].map((h) => (
              <TableHead key={h} className={cn(PAD, 'whitespace-nowrap')}>{h}</TableHead>
            ))}
            {actions && (
              <TableHead className={cn(PAD, STICKY)} style={ALARM_BANNER_SOLID}><span className="sr-only">Actions</span></TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {value.length === 0 && <TableEmpty colSpan={columns} title="No keys" />}
          {value.map((row, i) => {
            const n = i + 1;
            const rk = rowKeys.at(i);
            const q = quantityOf(row, rk);
            const typed = isDataType(row.dataType);
            const rowIssues = issues.rows.get(i);
            const scaleTyped = scaleText[rk];
            const scaleShown = scaleTyped !== undefined && sameNumber(parseScale(scaleTyped), row.scale) ? scaleTyped : scaleToText(row.scale);
            const reads = readsOf(row.register, typed ? row.dataType : MODBUS_QUANTITY_TYPES[q][0]!);
            const answer = answers[rk];
            const shown = answer && answer.signature === signatureOf(row) ? answer.outcome : null;
            const testBlocked = targetBlocked
              ?? (rowIssues && rowIssues.length > 0 ? 'Fix this row first — see the message under it.' : null);
            return (
              <MapRow key={rk} errors={rowIssues} answer={shown} columns={columns} index={i}>
                <TableCell className={PAD}>
                  {/* A long key wraps (anywhere — keys have no spaces) rather than widening the table. */}
                  {readOnly ? <span className="font-medium text-slate-800 [overflow-wrap:anywhere]">{row.key}</span> : (
                    <Input
                      aria-label={`Key, row ${n}`}
                      className={W.key}
                      value={row.key}
                      onChange={(e) => setRow(i, { ...row, key: e.target.value })}
                    />
                  )}
                </TableCell>
                <TableCell className={PAD}>
                  {readOnly ? <span className="tabular-nums">{row.register}</span> : (
                    <Input
                      aria-label={`Register, row ${n}`}
                      className={W.register}
                      inputMode="numeric"
                      value={row.register}
                      onChange={(e) => setRow(i, { ...row, register: e.target.value.trim() })}
                    />
                  )}
                </TableCell>
                <TableCell data-testid={`map-quantity-${i}`} className={PAD}>
                  {readOnly ? <span className="tabular-nums">{q}</span> : (
                    <Select
                      aria-label={`Quantity, row ${n}`}
                      className={W.quantity}
                      value={String(q)}
                      onChange={(e) => setRowQuantity(i, e.target.value === '1' ? 1 : 2)}
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </Select>
                  )}
                </TableCell>
                <TableCell data-testid={`map-reads-${i}`} className={cn(PAD, 'whitespace-nowrap text-slate-600')}>
                  {reads ? (
                    <>
                      <span className="block text-xs text-slate-500">{reads.area}</span>
                      <span className="block text-sm tabular-nums">{reads.range}</span>
                    </>
                  ) : '—'}
                </TableCell>
                <TableCell className={PAD}>
                  {readOnly ? row.dataType : (
                    <Select
                      aria-label={`Data type, row ${n}`}
                      className={W.dataType}
                      value={typed ? row.dataType : ''}
                      onChange={(e) => { if (isDataType(e.target.value)) setDataType(i, e.target.value); }}
                    >
                      {!typed && <option value="">Choose…</option>}
                      {MODBUS_QUANTITY_TYPES[q].map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  )}
                </TableCell>
                <TableCell data-testid={`map-byte-order-${i}`} className={cn(PAD, 'whitespace-nowrap')}>
                  {q === 1 ? <span className="text-slate-400">—</span> : readOnly ? (row.byteOrder ? MODBUS_BYTE_ORDER_LABELS[row.byteOrder] : '—') : (
                    <Select
                      aria-label={`Byte order, row ${n}`}
                      className={W.byteOrder}
                      value={row.byteOrder ?? ''}
                      onChange={(e) => setByteOrder(i, e.target.value)}
                    >
                      <option value="">Choose…</option>
                      {MODBUS_BYTE_ORDERS.map((o) => <option key={o} value={o}>{MODBUS_BYTE_ORDER_LABELS[o]}</option>)}
                    </Select>
                  )}
                </TableCell>
                <TableCell className={PAD}>
                  {readOnly ? <span className="tabular-nums">× {scaleToText(row.scale)}</span> : (
                    <Input
                      aria-label={`Scale, row ${n}`}
                      className={W.scale}
                      type="number"
                      step="any"
                      value={scaleShown}
                      onChange={(e) => setScale(i, e.target.value)}
                    />
                  )}
                </TableCell>
                <TableCell data-testid={`map-judged-${i}`} className={cn(PAD, 'whitespace-nowrap')}>{judgedText(judged, row.key)}</TableCell>
                {actions && (
                  <TableCell className={cn(PAD, STICKY, 'whitespace-nowrap bg-inherit text-right')}>
                    {testTarget && (
                      // The title is on the wrapper too: a disabled button
                      // takes no pointer events, so its own title never shows.
                      <span title={testBlocked ?? undefined} className="inline-flex">
                        <Button
                          type="button" size="icon-sm" variant="ghost"
                          aria-label={`Test key, row ${n}`}
                          title={testBlocked ?? 'Read this key from the device now — nothing is stored.'}
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
 * A row; its per-key Test answer on the line beneath (Ruling CR1-5); and the
 * shared schema's messages for it under that.
 */
function MapRow({
  children, errors, answer, columns, index,
}: {
  children: React.ReactNode;
  errors: string[] | undefined;
  answer: TestOutcome | null;
  columns: number;
  index: number;
}) {
  return (
    <>
      <TableRow>{children}</TableRow>
      {answer && (
        <tr>
          <td colSpan={columns} data-testid={`map-test-${index}`} className="bg-slate-50/80 px-4 py-1.5 text-xs">
            <RowAnswer outcome={answer} />
          </td>
        </tr>
      )}
      {errors && errors.length > 0 && (
        <tr>
          <td colSpan={columns} data-testid={`map-errors-${index}`} className="bg-rose-50/60 px-4 py-1.5 text-xs text-rose-700">
            {errors.join(' · ')}
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
 * The response's word for a key: the server parses the map with a schema that
 * TRIMS keys, so the lookup does too. Absent = no response covered it ("—");
 * `null` = covered and not judged.
 */
function judgedText(judged: Record<string, JudgedAs> | undefined, key: string): string {
  const k = key.trim();
  if (!judged || !Object.prototype.hasOwnProperty.call(judged, k)) return '—';
  return judgedWord(judged[k] ?? null) ?? 'Not judged';
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
