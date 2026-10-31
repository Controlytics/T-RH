import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  MODBUS_BYTE_ORDERS, MODBUS_DATA_TYPES, MODBUS_MAX_KEYS,
  fromDesktopKeysFile, modbusRegisterMapSchema, parseModiconRef, registersFor,
  type ModbusByteOrder, type ModbusDataType, type ModbusRegister, type ModbusRegisterMap,
} from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRowKeys } from '@/hooks/use-row-keys';
import { CopyMapDialog } from './copy-map-dialog';

/** What the SERVER said a key is judged as (Test connection's `judgedAs`). */
export type JudgedAs = 'TEMPERATURE' | 'HUMIDITY' | null;

/**
 * The register map of a TCP/IP (Modbus) instrument (spec §6, §12): one row per
 * key this server reads from the device — Key, Register, Area, Data type, Byte
 * order (32-bit only), Scale, Judged as. No Unit column (spec §6.1 ruling): a
 * raw key's unit is set where it is shown, a measured key's comes from its
 * measurement.
 *
 * Everything this component says on its own is about the SHAPE of what was
 * typed, from the shared `modbusRegisterMapSchema` — the same schema the API
 * runs, so the words under a row are the words a 400 would carry. The Area is
 * a pure parse of the reference (`parseModiconRef`). **Judged as is never
 * decided here**: it is the `judged` prop, the Test-connection response's
 * `judgedAs`, and "—" for a key no response covered. A key named
 * "Temperature" is not thereby judged; only the server's measurements know
 * (root CLAUDE.md "Never reconstruct server-side decision logic").
 *
 * Shared by New Instrument and the instrument page (`readOnly` there until a
 * super admin edits), so nothing page-specific lives here.
 */
export function RegisterMapEditor({
  value, onChange, judged, readOnly = false,
}: {
  value: ModbusRegisterMap;
  onChange: (next: ModbusRegisterMap) => void;
  judged?: Record<string, JudgedAs>;
  readOnly?: boolean;
}) {
  const rowKeys = useRowKeys(value.length);
  /**
   * The Scale text as typed, per row. The map holds a NUMBER, and an input
   * driven from it would turn "0." into "0" and "" into "0" mid-keystroke. The
   * text is shown only while it still parses to the stored number, so a map
   * replaced by an import or a copy shows its own scales.
   */
  const [scaleText, setScaleText] = useState<Record<string, string>>({});
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [copyOpen, setCopyOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const issues = readOnly ? { rows: new Map<number, string[]>(), map: [] as string[] } : mapIssues(value);

  const setRow = (i: number, next: ModbusRegister) => onChange(value.map((r, j) => (j === i ? next : r)));

  const setDataType = (i: number, dataType: ModbusDataType) => {
    const { byteOrder, ...rest } = value[i]!;
    // A 16-bit type has no byte order (the schema refuses one). A 32-bit type
    // keeps the order the row had and is otherwise left for the operator to
    // CHOOSE: a wrong byte order reads a believable wrong number, never an
    // error, so the form does not pick one for them.
    setRow(i, registersFor(dataType) === 2 && byteOrder ? { ...rest, dataType, byteOrder } : { ...rest, dataType });
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
    rowKeys.remove(i);
    onChange(value.filter((_, j) => j !== i));
  };

  /** Import and Copy REPLACE the map; rows already typed are not dropped unasked. */
  const replace = (next: ModbusRegisterMap): boolean => {
    if (value.length > 0 && !window.confirm(
      `Replace the ${value.length} key${value.length === 1 ? '' : 's'} in this register map?`,
    )) return false;
    onChange(next);
    return true;
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

  const columns = readOnly ? 7 : 8;

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
            <TableHead>Key</TableHead>
            <TableHead>Register</TableHead>
            <TableHead>Area</TableHead>
            <TableHead>Data type</TableHead>
            <TableHead>Byte order</TableHead>
            <TableHead>Scale</TableHead>
            <TableHead>Judged as</TableHead>
            {!readOnly && <TableHead><span className="sr-only">Remove</span></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {value.length === 0 && <TableEmpty colSpan={columns} title="No keys" />}
          {value.map((row, i) => {
            const n = i + 1;
            const thirtyTwo = registersFor(row.dataType) === 2;
            const rowIssues = issues.rows.get(i);
            const rk = rowKeys.at(i);
            const typed = scaleText[rk];
            const scaleShown = typed !== undefined && sameNumber(parseScale(typed), row.scale) ? typed : scaleToText(row.scale);
            return (
              <MapRow key={rk} errors={rowIssues} columns={columns} index={i}>
                <TableCell className="min-w-[10rem]">
                  {readOnly ? <span className="font-medium text-slate-800">{row.key}</span> : (
                    <Input
                      aria-label={`Key, row ${n}`}
                      value={row.key}
                      onChange={(e) => setRow(i, { ...row, key: e.target.value })}
                    />
                  )}
                </TableCell>
                <TableCell className="min-w-[7rem]">
                  {readOnly ? <span className="tabular-nums">{row.register}</span> : (
                    <Input
                      aria-label={`Register, row ${n}`}
                      inputMode="numeric"
                      value={row.register}
                      onChange={(e) => setRow(i, { ...row, register: e.target.value.trim() })}
                    />
                  )}
                </TableCell>
                <TableCell data-testid={`map-area-${i}`} className="text-slate-600">{areaOf(row.register)}</TableCell>
                <TableCell className="min-w-[8rem]">
                  {readOnly ? row.dataType : (
                    <Select
                      aria-label={`Data type, row ${n}`}
                      selectSize="sm"
                      value={row.dataType}
                      onChange={(e) => setDataType(i, e.target.value as ModbusDataType)}
                    >
                      {MODBUS_DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  )}
                </TableCell>
                <TableCell className="min-w-[7rem]">
                  {!thirtyTwo ? <span className="text-slate-400">—</span> : readOnly ? (row.byteOrder ?? '—') : (
                    <Select
                      aria-label={`Byte order, row ${n}`}
                      selectSize="sm"
                      value={row.byteOrder ?? ''}
                      onChange={(e) => setByteOrder(i, e.target.value)}
                    >
                      <option value="">Choose…</option>
                      {MODBUS_BYTE_ORDERS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  )}
                </TableCell>
                <TableCell className="min-w-[6rem]">
                  {readOnly ? <span className="tabular-nums">× {scaleToText(row.scale)}</span> : (
                    <Input
                      aria-label={`Scale, row ${n}`}
                      type="number"
                      step="any"
                      value={scaleShown}
                      onChange={(e) => setScale(i, e.target.value)}
                    />
                  )}
                </TableCell>
                <TableCell data-testid={`map-judged-${i}`}>{judgedText(judged, row.key)}</TableCell>
                {!readOnly && (
                  <TableCell className="w-10 text-right">
                    <Button
                      type="button" size="icon-sm" variant="ghost"
                      aria-label={`Remove row ${n}`}
                      onClick={() => removeRow(i)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
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

/** A row, and the shared schema's messages for it on the line beneath. */
function MapRow({
  children, errors, columns, index,
}: { children: React.ReactNode; errors: string[] | undefined; columns: number; index: number }) {
  return (
    <>
      <TableRow>{children}</TableRow>
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
 * Holding / Input from the reference. A reference that does not parse shows
 * "—"; the schema's message for it is printed under the row, so the throw is
 * the parse's answer, not a swallowed error.
 */
function areaOf(ref: string): string {
  try {
    return parseModiconRef(ref).area === 'HOLDING' ? 'Holding' : 'Input';
  } catch {
    return '—';
  }
}

/**
 * The response's word for a key: the server parses the map with a schema that
 * TRIMS keys, so the lookup does too. Absent = no response covered it ("—");
 * `null` = covered and not judged.
 */
function judgedText(judged: Record<string, JudgedAs> | undefined, key: string): string {
  const k = key.trim();
  if (!judged || !Object.prototype.hasOwnProperty.call(judged, k)) return '—';
  const v = judged[k];
  if (v === 'TEMPERATURE') return 'Temperature';
  if (v === 'HUMIDITY') return 'Humidity';
  return 'Not judged';
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
