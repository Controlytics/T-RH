import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  MESSAGE_TYPE_SWITCH_LABELS, RULE_KEY_MAX, RULE_MESSAGE_TYPES, newRuleNodeConfig, visibleRuleNodeFields,
  type RuleNodeConfigField,
} from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useRowKeys } from '@/hooks/use-row-keys';
import { ScriptField, type TestScriptBody } from './script-field';
import { MASKED_SECRET } from './types';

/**
 * The node settings form (rule chains, 2026-11-04; spec section 11): ONE
 * generic form, rendered from a node type's field descriptors in the shared
 * catalogue (`packages/shared/src/types/rule-nodes.ts`) — the same list the
 * server's strict parse validates, so the form offers exactly what a save
 * accepts.
 *
 * - Render `visibleFieldsFor(type, config)`, never `spec.fields`: Create
 *   alarm lists `severity` twice (a select, or a template while
 *   `dynamicSeverity` is on), never both at once. Rows are keyed
 *   `${key}:${type}` for the same reason.
 * - A flag that is null or absent reads as ThingsBoard's default — an imported
 *   config may carry `dynamicSeverity: null`, which the shallow default merge
 *   would let hide BOTH severity fields.
 * - A value the server MASKED is shown as "•••• (stored)", never as text. Every
 *   rule chain response masks every stored credential as `"***"`, for EVERY
 *   caller (ruling T2-D), and a save that sends `"***"` back keeps the stored
 *   value (the server's merge). A text field shows the marker with Change; a
 *   JSON or map field shows it in place of the leaf and turns it back into
 *   `"***"` when it writes. Which keys are secret is the SERVER's decision —
 *   this form only reads its answer.
 * - Fields that edit through a LOCAL copy (a number being typed, map rows, JSON
 *   text) re-seed it whenever their config value changes from outside
 *   (`useSeeded`), never only once at mount.
 * - A config value the form cannot represent (an imported select value that is
 *   not an option, a message type outside this system's list) is shown and
 *   kept, never silently dropped.
 */

export interface ConfigFormContext {
  chains?: readonly { id: string; name: string }[];
  /** The chain being edited — a Rule chain node does not offer it. */
  currentChainId?: string;
  instruments?: readonly { id: string; code: string; name?: string | null }[];
  /** `null` = the list could not be read (a 403 for a holder who is not SUPER_ADMIN). */
  templates?: readonly { id: string; name: string }[] | null;
  roles?: readonly { name: string; displayName?: string | null }[];
  users?: readonly { id: string; username: string; fullName?: string | null }[];
  /** `POST /api/rule-chains/test-script`; resolves the script's result, rejects with `{ code, message }`. */
  testScript?: (body: TestScriptBody) => Promise<unknown>;
}

/** The config with null / undefined values dropped — what "absent = ThingsBoard's default" means. */
function withoutNulls(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null && v !== undefined));
}

/** The fields to render now, each `showWhen` judged with null / absent flags as their defaults. */
export function visibleFieldsFor(type: string, config: Record<string, unknown>): RuleNodeConfigField[] {
  return visibleRuleNodeFields(type, withoutNulls(config));
}

const isMasked = (v: unknown) => v === MASKED_SECRET;
const holdsMask = (v: unknown) => JSON.stringify(v ?? null).includes(`"${MASKED_SECRET}"`);

/** What a masked credential reads as, in every field type. */
export const MASK_DISPLAY = '•••• (stored)';

/** Every `"***"` leaf as the marker, for a JSON or map field's text. */
function maskForDisplay(v: unknown): unknown {
  if (v === MASKED_SECRET) return MASK_DISPLAY;
  if (Array.isArray(v)) return v.map(maskForDisplay);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskForDisplay(x)]));
  return v;
}

/** The inverse: a leaf left as the marker is written back as `"***"` (the server keeps the stored value). */
function unmaskFromDisplay(v: unknown): unknown {
  if (v === MASK_DISPLAY) return MASKED_SECRET;
  if (Array.isArray(v)) return v.map(unmaskFromDisplay);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmaskFromDisplay(x)]));
  return v;
}

/** Every path holding a `"***"` leaf, as display text (`a.b`, `list[2].c`). */
function maskedPaths(v: unknown, at = ''): string[] {
  if (v === MASKED_SECRET) return [at || '(the value)'];
  if (Array.isArray(v)) return v.flatMap((x, i) => maskedPaths(x, `${at}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => maskedPaths(x, at ? `${at}.${k}` : k));
  return [];
}

/**
 * The paths where `next` holds a `"***"` the current value does not hold THERE.
 * The server keeps a stored secret only for the same node, key and path (its
 * merge), so a marker that moved — a renamed key, an array element that shifted
 * — would be saved as the three characters `***` and the secret lost (review
 * I1 / M2, 2026-11-05). Such an edit is refused, never written.
 */
export function movedMasks(current: unknown, next: unknown): string[] {
  const had = new Set(maskedPaths(current));
  return maskedPaths(next).filter((p) => !had.has(p));
}

/**
 * A field's LOCAL copy of its value (the text being typed, the map rows), seeded
 * from the config value and RE-SEEDED whenever that value changes from OUTSIDE
 * — a value this field did not hand up itself (fix round 1: it used to be
 * seeded once at mount, so a form that mounted before its config arrived kept
 * showing, and writing, the wrong rows). `commit(local, value)` records what
 * the field hands up, so its own write does not re-seed it: a row whose key is
 * still blank, or JSON being typed, stays as typed. React's "adjust state while
 * rendering" pattern; the comparison is by identity, which the form preserves
 * (`{ ...config, [key]: v }` keeps every other value's reference).
 */
function useSeeded<T>(external: unknown, seed: () => T) {
  const [local, setLocal] = useState<T>(seed);
  const [from, setFrom] = useState<unknown>(external);
  if (!Object.is(external, from)) {
    setFrom(external);
    setLocal(seed());
  }
  const commit = (next: T, value: unknown) => {
    setLocal(next);
    setFrom(value);
  };
  return [local, setLocal, commit] as const;
}

const labelCls = 'block text-[0.8125rem] font-semibold text-slate-700';
const helpCls = 'text-[0.75rem] text-slate-500';

function Label({ htmlFor, field }: { htmlFor?: string; field: RuleNodeConfigField }) {
  const body = <>{field.label}{field.required && <span className="text-rose-600"> *</span>}</>;
  return htmlFor ? <label htmlFor={htmlFor} className={labelCls}>{body}</label> : <span className={labelCls}>{body}</span>;
}

function Help({ field, extra }: { field: RuleNodeConfigField; extra?: ReactNode }) {
  if (!field.help && !extra) return null;
  return <p className={helpCls}>{field.help}{field.help && extra ? ' ' : ''}{extra}</p>;
}

const MASK_NOTE = `${MASK_DISPLAY} is a stored secret: leave it as it is to keep it, or replace it with the new value.`;
/** Its key cannot change while it holds the stored value — the server keeps a secret only under its own key. */
const MASK_KEY_NOTE = 'A stored secret keeps its key: type a new value first to rename it.';

export function ConfigForm({ nodeType, fields, value, onChange, context = {}, readOnly = false }: {
  nodeType: string;
  fields: readonly RuleNodeConfigField[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  context?: ConfigFormContext;
  readOnly?: boolean;
}) {
  // Memoized: a field compares its value by identity, and an omitted key shows this default.
  const defaults = useMemo(() => newRuleNodeConfig(nodeType), [nodeType]);
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  const unset = (key: string) => {
    const { [key]: _gone, ...rest } = value;
    onChange(rest);
  };

  if (fields.length === 0) {
    return <p className="text-sm text-slate-500">This node has no settings.</p>;
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const raw = value[field.key];
        // What the form SHOWS for a key the config omits (or holds null for):
        // ThingsBoard's default, which is what the node will use.
        const shown = raw === undefined || raw === null ? defaults[field.key] : raw;
        return (
          <div key={`${field.key}:${field.type}`} data-testid={`field-${field.key}:${field.type}`} className="space-y-1.5">
            <FieldControl
              field={field}
              raw={raw}
              shown={shown}
              fallback={defaults[field.key]}
              readOnly={readOnly}
              context={context}
              set={(v) => set(field.key, v)}
              unset={() => unset(field.key)}
            />
          </div>
        );
      })}
    </div>
  );
}

function FieldControl({ field, raw, shown, fallback, readOnly, context, set, unset }: {
  field: RuleNodeConfigField;
  raw: unknown;
  shown: unknown;
  fallback: unknown;
  readOnly: boolean;
  context: ConfigFormContext;
  set: (v: unknown) => void;
  unset: () => void;
}) {
  const id = useId();
  switch (field.type) {
    case 'text':
    case 'template':
      return <TextField id={id} field={field} raw={raw} fallback={fallback} readOnly={readOnly} set={set} multiline={field.type === 'template'} />;
    case 'number':
      return <NumberField id={id} field={field} raw={raw} fallback={fallback} readOnly={readOnly} set={set} unset={unset} />;
    case 'boolean':
      return <Toggle label={field.label} helper={field.help} checked={shown === true} disabled={readOnly} onChange={() => set(!(shown === true))} />;
    case 'select':
      return (
        <>
          <Label htmlFor={id} field={field} />
          <OptionSelect id={id} value={shown} options={field.options ?? []} readOnly={readOnly} onPick={set} />
          <Help field={field} />
        </>
      );
    case 'multiselect':
      return <MultiField field={field} shown={shown} readOnly={readOnly} set={set} />;
    case 'keys':
    case 'relations':
      return <KeysField field={field} shown={shown} readOnly={readOnly} set={set} />;
    case 'map':
      return <MapField field={field} raw={raw} shown={shown} readOnly={readOnly} set={set} />;
    case 'json':
      return <JsonField id={id} field={field} raw={raw} shown={shown} readOnly={readOnly} set={set} unset={unset} />;
    case 'script':
      return <ScriptField field={field} value={typeof shown === 'string' ? shown : ''} readOnly={readOnly} onChange={set} testScript={context.testScript} />;
    case 'instrument': {
      const options = [...(context.instruments ?? [])]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((i) => ({ value: i.id, label: i.name && i.name !== i.code ? `${i.code} — ${i.name}` : i.code }));
      return (
        <>
          <Label htmlFor={id} field={field} />
          <OptionSelect id={id} value={shown} options={options} readOnly={readOnly} onPick={(v) => set(v === '' ? null : v)} none="No instrument" missing="not found" />
          <Help field={field} />
        </>
      );
    }
    case 'notification-template': {
      if (context.templates === null) {
        return (
          <>
            <Label field={field} />
            <p className="rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 px-3 py-2 text-[0.8125rem] text-amber-900">
              The notification templates could not be read. Stored: <span className="font-mono">{typeof shown === 'string' && shown ? shown : 'none'}</span>
            </p>
          </>
        );
      }
      const options = (context.templates ?? []).map((t) => ({ value: t.id, label: t.name }));
      return (
        <>
          <Label htmlFor={id} field={field} />
          <OptionSelect id={id} value={shown} options={options} readOnly={readOnly} onPick={(v) => set(v === '' ? null : v)} none="No template" missing="not found" />
          <Help field={field} />
        </>
      );
    }
    case 'targets':
      return <TargetsField field={field} shown={shown} readOnly={readOnly} context={context} set={set} />;
    case 'message-types':
      return <MessageTypesField field={field} shown={shown} readOnly={readOnly} set={set} />;
    case 'chain': {
      const options = (context.chains ?? [])
        .filter((c) => c.id !== context.currentChainId)
        .map((c) => ({ value: c.id, label: c.name }));
      return (
        <>
          <Label htmlFor={id} field={field} />
          <OptionSelect id={id} value={shown} options={options} readOnly={readOnly} onPick={(v) => set(v === '' ? null : v)} none="Choose a rule chain" missing="no such chain" />
          <Help field={field} />
        </>
      );
    }
    default:
      return <JsonField id={id} field={field} raw={raw} shown={shown} readOnly={readOnly} set={set} unset={unset} />;
  }
}

/** Text or a template. A masked credential reads "(stored)" until Change. */
function TextField({ id, field, raw, fallback, readOnly, set, multiline }: {
  id: string; field: RuleNodeConfigField; raw: unknown; fallback: unknown; readOnly: boolean; set: (v: unknown) => void; multiline: boolean;
}) {
  const [changing, setChanging] = useState(false);
  const masked = isMasked(raw) && !changing;
  const text = isMasked(raw) ? '' : typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
  const placeholder = typeof fallback === 'string' && fallback !== '' ? fallback : undefined;
  return (
    <>
      <Label htmlFor={masked ? undefined : id} field={field} />
      {masked ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex h-10 flex-1 items-center rounded-[var(--radius-control)] border border-slate-200 bg-slate-50 px-3 font-mono text-[0.875rem] text-slate-600">
            {MASK_DISPLAY}
          </span>
          {!readOnly && <Button type="button" variant="outline" onClick={() => setChanging(true)}>Change</Button>}
        </div>
      ) : (
        <div className="flex items-start gap-2">
          {multiline ? (
            <textarea id={id} rows={3} value={text} placeholder={placeholder} disabled={readOnly} onChange={(e) => set(e.target.value)} className="ctl w-full font-mono text-[0.8125rem]" />
          ) : (
            <Input id={id} value={text} placeholder={placeholder} disabled={readOnly} onChange={(e) => set(e.target.value)} />
          )}
          {changing && !readOnly && (
            <Button type="button" variant="outline" onClick={() => { setChanging(false); set(MASKED_SECRET); }}>Keep stored</Button>
          )}
        </div>
      )}
      <Help field={field} />
    </>
  );
}

/** A number. Blank REMOVES the key: ThingsBoard's default applies (shown as the placeholder). */
function NumberField({ id, field, raw, fallback, readOnly, set, unset }: {
  id: string; field: RuleNodeConfigField; raw: unknown; fallback: unknown; readOnly: boolean; set: (v: unknown) => void; unset: () => void;
}) {
  const [text, setText, commit] = useSeeded(raw, () => (typeof raw === 'number' ? String(raw) : ''));
  return (
    <>
      <Label htmlFor={id} field={field} />
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={text}
        min={field.min}
        max={field.max}
        placeholder={typeof fallback === 'number' ? `Default ${fallback}` : undefined}
        disabled={readOnly}
        onChange={(e) => {
          const t = e.target.value;
          if (t.trim() === '') { commit(t, undefined); unset(); return; }
          const n = Number(t);
          if (Number.isFinite(n)) { commit(t, n); set(n); } else setText(t);
        }}
      />
      <Help field={field} />
    </>
  );
}

/** A native select; a stored value that is not an option is shown and kept. */
function OptionSelect({ id, value, options, readOnly, onPick, none, missing = 'not in this list' }: {
  id: string;
  value: unknown;
  options: readonly { value: string; label: string }[];
  readOnly: boolean;
  onPick: (v: string) => void;
  none?: string;
  missing?: string;
}) {
  const current = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const known = options.some((o) => o.value === current);
  return (
    <Select id={id} value={current} disabled={readOnly} onChange={(e) => onPick(e.target.value)}>
      {(none !== undefined || current === '') && <option value="">{none ?? 'Choose…'}</option>}
      {!known && current !== '' && <option value={current}>{current} ({missing})</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  );
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function MultiField({ field, shown, readOnly, set }: { field: RuleNodeConfigField; shown: unknown; readOnly: boolean; set: (v: unknown) => void }) {
  const chosen = asStringArray(shown);
  const options = field.options ?? [];
  const extra = chosen.filter((v) => !options.some((o) => o.value === v));
  const toggle = (v: string) => set(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]);
  return (
    <fieldset className="space-y-2">
      <legend className={labelCls}>{field.label}{field.required && <span className="text-rose-600"> *</span>}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => <Checkbox key={o.value} label={o.label} checked={chosen.includes(o.value)} disabled={readOnly} onChange={() => toggle(o.value)} />)}
        {extra.map((v) => <Checkbox key={`x-${v}`} label={`${v} (not in this list)`} checked disabled={readOnly} onChange={() => toggle(v)} />)}
      </div>
      <Help field={field} />
    </fieldset>
  );
}

/** A list of names: chips, plus a box to add one. Shared by key lists and custom message types. */
function KeyAdder({ label, readOnly, onAdd }: { label: string; readOnly: boolean; onAdd: (k: string) => void }) {
  const [text, setText] = useState('');
  if (readOnly) return null;
  const add = () => {
    const k = text.trim();
    if (k === '') return;
    onAdd(k.slice(0, RULE_KEY_MAX));
    setText('');
  };
  return (
    <div className="flex gap-2">
      <Input
        aria-label={`New key for ${label}`}
        value={text}
        maxLength={RULE_KEY_MAX}
        placeholder="Add a key"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
      />
      <Button type="button" variant="outline" disabled={text.trim() === ''} onClick={add}>Add key</Button>
    </div>
  );
}

function Chips({ values, readOnly, onRemove, empty = 'None' }: { values: readonly string[]; readOnly: boolean; onRemove: (v: string) => void; empty?: string }) {
  if (values.length === 0) return <p className="text-[0.8125rem] italic text-slate-400">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v, i) => (
        <span key={`${v}-${i}`} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[0.8125rem] text-slate-800 ring-1 ring-inset ring-slate-200">
          {v}
          {!readOnly && <Button type="button" variant="ghost" size="chip" aria-label={`Remove ${v}`} onClick={() => onRemove(v)}>×</Button>}
        </span>
      ))}
    </div>
  );
}

function KeysField({ field, shown, readOnly, set }: { field: RuleNodeConfigField; shown: unknown; readOnly: boolean; set: (v: unknown) => void }) {
  const keys = asStringArray(shown);
  return (
    <div className="space-y-2">
      <Label field={field} />
      <Chips values={keys} readOnly={readOnly} onRemove={(k) => set(keys.filter((x) => x !== k))} />
      <KeyAdder label={field.label} readOnly={readOnly} onAdd={(k) => { if (!keys.includes(k)) set([...keys, k]); }} />
      <Help field={field} />
    </div>
  );
}

/**
 * Key → value rows. Rows are local while typed, so a key being retyped does not
 * vanish; they are re-seeded when the map changes from outside. A masked value
 * shows as the marker and is written back as `"***"`.
 */
function MapField({ field, raw, shown, readOnly, set }: { field: RuleNodeConfigField; raw: unknown; shown: unknown; readOnly: boolean; set: (v: unknown) => void }) {
  const [rows, setRows, commitRows] = useSeeded<{ k: string; v: string }[]>(raw, () =>
    shown && typeof shown === 'object' && !Array.isArray(shown)
      ? Object.entries(shown as Record<string, unknown>).map(([k, v]) => ({
        k, v: v === MASKED_SECRET ? MASK_DISPLAY : typeof v === 'string' ? v : JSON.stringify(v),
      }))
      : []);
  const keys = useRowKeys(rows.length);
  const commit = (next: { k: string; v: string }[]) => {
    const value = Object.fromEntries(next.filter((r) => r.k.trim() !== '').map((r) => [r.k.trim(), r.v === MASK_DISPLAY ? MASKED_SECRET : r.v]));
    commitRows(next, value);
    set(value);
  };
  const seen = new Map<string, number>();
  for (const r of rows) { const k = r.k.trim(); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
  const repeated = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  return (
    <div className="space-y-2">
      <Label field={field} />
      {rows.length === 0 && <p className="text-[0.8125rem] italic text-slate-400">No entries</p>}
      {rows.map((r, i) => (
        <div key={keys.at(i)} className="flex items-center gap-2">
          <Input
            aria-label={`Key ${i + 1}`}
            value={r.k}
            maxLength={RULE_KEY_MAX}
            disabled={readOnly || r.v === MASK_DISPLAY}
            title={r.v === MASK_DISPLAY ? MASK_KEY_NOTE : undefined}
            aria-invalid={repeated.includes(r.k.trim()) || undefined}
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
          />
          <span aria-hidden className="text-slate-400">→</span>
          <Input
            aria-label={`Value ${i + 1}`}
            value={r.v}
            disabled={readOnly}
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          {!readOnly && (
            <Button
              type="button" variant="ghost" size="icon-sm" aria-label={`Remove row ${i + 1}`}
              onClick={() => { keys.remove(i); commit(rows.filter((_, j) => j !== i)); }}
            >×</Button>
          )}
        </div>
      ))}
      {repeated.length > 0 && <p role="alert" className="text-[0.75rem] text-rose-700">Repeated key: {repeated.join(', ')} — the last one is kept.</p>}
      {!readOnly && <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { k: '', v: '' }])}>Add row</Button>}
      <Help field={field} extra={holdsMask(shown) ? `${MASK_NOTE} ${MASK_KEY_NOTE}` : undefined} />
    </div>
  );
}

/**
 * JSON text. Invalid JSON stays in the box and is NOT written to the config.
 * A masked leaf shows as the marker and is written back as `"***"`. The text
 * is re-seeded when the value changes from outside.
 */
function JsonField({ id, field, raw, shown, readOnly, set, unset }: {
  id: string; field: RuleNodeConfigField; raw: unknown; shown: unknown; readOnly: boolean; set: (v: unknown) => void; unset: () => void;
}) {
  const [state, setState, commit] = useSeeded<{ text: string; error: string | null }>(raw, () => ({
    text: shown === undefined ? '' : JSON.stringify(maskForDisplay(shown), null, 2),
    error: null,
  }));
  const { text, error } = state;
  return (
    <>
      <Label htmlFor={id} field={field} />
      <textarea
        id={id}
        rows={5}
        spellCheck={false}
        value={text}
        disabled={readOnly}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          const t = e.target.value;
          // Blank REMOVES the key, so ThingsBoard's default applies (as a blank number does).
          if (t.trim() === '') { commit({ text: t, error: null }, undefined); unset(); return; }
          let parsed: unknown;
          try {
            parsed = unmaskFromDisplay(JSON.parse(t));
          } catch (err) {
            setState({ text: t, error: `Not valid JSON — not applied. ${(err as Error).message}` });
            return;
          }
          const moved = movedMasks(raw, parsed);
          if (moved.length > 0) {
            setState({ text: t, error: `Not applied: a stored secret cannot move to ${moved.join(', ')}. Leave it where it was, or type a new value there.` });
            return;
          }
          commit({ text: t, error: null }, parsed);
          set(parsed);
        }}
        className="ctl w-full font-mono text-[0.8125rem]"
      />
      {error && <p role="alert" className="text-[0.75rem] text-rose-700">{error}</p>}
      <Help field={field} extra={holdsMask(shown) ? MASK_NOTE : undefined} />
    </>
  );
}

function TargetsField({ field, shown, readOnly, context, set }: {
  field: RuleNodeConfigField; shown: unknown; readOnly: boolean; context: ConfigFormContext; set: (v: unknown) => void;
}) {
  const isTbList = Array.isArray(shown);
  const obj = !isTbList && shown && typeof shown === 'object' ? (shown as { roles?: unknown; userIds?: unknown }) : {};
  const roles = asStringArray(obj.roles);
  const userIds = asStringArray(obj.userIds);
  const write = (r: string[], u: string[]) => set({ roles: r, userIds: u });
  const flip = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <fieldset className="space-y-2">
      <legend className={labelCls}>{field.label}{field.required && <span className="text-rose-600"> *</span>}</legend>
      {isTbList && (
        <p className="rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 px-3 py-2 text-[0.8125rem] text-amber-900">
          Imported ThingsBoard notification targets ({(shown as unknown[]).length}) have no counterpart here. Choose roles and users instead.
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-[var(--radius-control)] border border-slate-200 p-3">
          <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-slate-500">Roles</p>
          {(context.roles ?? []).map((r) => (
            <Checkbox key={r.name} label={r.displayName || r.name} checked={roles.includes(r.name)} disabled={readOnly} onChange={() => write(flip(roles, r.name), userIds)} />
          ))}
          {roles.filter((r) => !(context.roles ?? []).some((x) => x.name === r)).map((r) => (
            <Checkbox key={`x-${r}`} label={`${r} (not found)`} checked disabled={readOnly} onChange={() => write(flip(roles, r), userIds)} />
          ))}
        </div>
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-[var(--radius-control)] border border-slate-200 p-3">
          <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-slate-500">Users</p>
          {(context.users ?? []).map((u) => (
            <Checkbox key={u.id} label={u.fullName || u.username} checked={userIds.includes(u.id)} disabled={readOnly} onChange={() => write(roles, flip(userIds, u.id))} />
          ))}
          {userIds.filter((id) => !(context.users ?? []).some((x) => x.id === id)).map((id) => (
            <Checkbox key={`x-${id}`} label={`${id} (not found)`} checked disabled={readOnly} onChange={() => write(roles, flip(userIds, id))} />
          ))}
        </div>
      </div>
      <Help field={field} />
    </fieldset>
  );
}

function MessageTypesField({ field, shown, readOnly, set }: { field: RuleNodeConfigField; shown: unknown; readOnly: boolean; set: (v: unknown) => void }) {
  const chosen = asStringArray(shown);
  const known = RULE_MESSAGE_TYPES as readonly string[];
  const custom = chosen.filter((t) => !known.includes(t));
  const toggle = (t: string) => set(chosen.includes(t) ? chosen.filter((x) => x !== t) : [...chosen, t]);
  return (
    <fieldset className="space-y-2">
      <legend className={labelCls}>{field.label}{field.required && <span className="text-rose-600"> *</span>}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {known.map((t) => {
          const label = Object.prototype.hasOwnProperty.call(MESSAGE_TYPE_SWITCH_LABELS, t) ? `${MESSAGE_TYPE_SWITCH_LABELS[t]} (${t})` : t;
          return <Checkbox key={t} label={label} checked={chosen.includes(t)} disabled={readOnly} onChange={() => toggle(t)} />;
        })}
      </div>
      <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-slate-500">Other types</p>
      <Chips values={custom} readOnly={readOnly} onRemove={toggle} empty="None — a Script transform may set any type." />
      <KeyAdder label={field.label} readOnly={readOnly} onAdd={(t) => { if (!chosen.includes(t)) set([...chosen, t]); }} />
      <Help field={field} />
    </fieldset>
  );
}
