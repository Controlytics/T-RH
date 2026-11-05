import { RULE_SCRIPT_KEYS, ruleNodeScript, ruleNodeScriptKey } from '@digilog/shared';
import type { RuleMessage } from '../../message.js';

/**
 * Helpers the node handlers share (rule chains, Task 5, 2026-11-04; final fix
 * wave 2026-11-05): THE template rule (`processPattern`, ruling TP-1 — every
 * group's callers, the three earlier copies folded into it), the script a node
 * runs (`nodeScriptOf`, ruling TB-L), the metadata-ts reader (`metadataTs`,
 * M-1) and Java's number text. It lives here because the Java text helpers it
 * needs do; no node module may import back into this file.
 */

export type JsonObject = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

// ─── templates (ruling TP-1: ONE rule for every caller) ─────────────────────

export interface PatternOptions {
  /**
   * JSON-escape each `${key}` / `$[key]` value — ThingsBoard's
   * `processPattern(pattern, msg, escapeJsonValues)`, which the REST API call's
   * `requestBodyTemplate` uses so a value lands inside a JSON string intact.
   * `${*}` / `$[*]` are JSON already and go in as they are (ThingsBoard does
   * not escape them either), so `{"meta": ${*}}` stays a JSON object.
   */
  escapeJson?: boolean;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Java's `.` without DOTALL stops at these, so ThingsBoard's `$[…]` pattern never spans one. */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

const JSON_NAMED_ESCAPES: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };

/**
 * Jackson's `JsonStringEncoder.quoteAsString` (jackson-core 2.21.7, the
 * version ThingsBoard master pins): `"` and `\` escaped, `\b \t \n \f \r` by
 * name, any other control character below U+0020 as `\u00XX` in UPPER-case
 * hex; nothing else (no `/`, no non-ASCII, no surrounding quotes).
 */
export function jsonEscape(text: string): string {
  return text.replace(/["\\\u0000-\u001f]/g, (c) => JSON_NAMED_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * The text of a data VALUE as ThingsBoard's `JsonNode.asText()` prints one: a
 * string as is, a boolean as `true` / `false`, JSON null as `null`, a number
 * as `javaValueText` (a whole number as is — Jackson's IntNode / LongNode —
 * any other by Java's `Double.toString`: `1.0E-4`). `undefined` for an object,
 * an array or nothing — those leave the placeholder as written.
 */
function valueText(v: unknown): string | undefined {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return javaValueText(v);
  return undefined;
}

/** `$[path]`'s value: dot steps over OWN keys of JSON objects; Java's `split` drops trailing empty steps (`a.` reads `a`). */
function dataValue(data: unknown, path: string): string | undefined {
  if (!isPlainObject(data) || LINE_BREAK.test(path)) return undefined;
  const steps = path.split('.');
  while (steps.length > 0 && steps[steps.length - 1] === '') steps.pop();
  if (steps.length === 0) return undefined;
  let node: unknown = data;
  for (const step of steps) {
    if (step === '' || !isPlainObject(node) || !own(node, step)) return undefined;
    node = node[step];
  }
  return valueText(node);
}

/**
 * THE template rule of every node (ruling TP-1, 2026-11-05) — ThingsBoard's
 * `TbNodeUtils.processPattern` (master e48b5780), with ONE deliberate
 * difference. The placeholders:
 *  - `${key}` → the metadata value of `key`; `${*}` → the whole metadata as
 *    JSON (`{}` when empty);
 *  - `$[path]` → the message DATA value at a dot path (`$[a.b]`), only when
 *    the data is a JSON object and the path ends on a VALUE (string, number,
 *    boolean, null → `null`); a trailing dot is dropped as Java's
 *    `String.split` drops it (`$[a.]` reads `a`); `$[*]` → the whole data as
 *    JSON;
 *  - OWN keys only (`$[constructor]` is not a value); a placeholder that does
 *    not resolve is LEFT AS WRITTEN, and the text after it is still read.
 * THE DIFFERENCE: ONE PASS over the pattern — a substituted value is never
 * expanded again, and a placeholder a substitution would BUILD (`$[${k}]`)
 * is not one. ThingsBoard replaces key by key and then the data, so it
 * re-expands; one pass keeps a value a DEVICE controls (a telemetry value, an
 * attribute, a response header) from pulling other message content into a
 * URL, an email or an alarm type. Not reproduced either: a metadata key
 * containing `}` (ThingsBoard replaces it literally), and Jackson's text of a
 * number that arrived as `20.0` (JSON gave this system the number 20).
 * Used by every node that fills a template — the action, enrichment,
 * transformation and external groups alike; there is no second one.
 */
export function processPattern(pattern: string, msg: Pick<RuleMessage, 'metadata' | 'data'>, opts: PatternOptions = {}): string {
  if (typeof pattern !== 'string') return '';
  const metadata = msg.metadata ?? {};
  const fill = opts.escapeJson === true ? jsonEscape : (s: string) => s;
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const at = pattern.indexOf('$', i);
    if (at < 0) {
      out += pattern.slice(i);
      break;
    }
    out += pattern.slice(i, at);
    const hit = placeholderAt(pattern, at, msg.data, metadata, fill);
    if (hit) {
      out += hit.text;
      i = hit.end;
    } else {
      out += '$';
      i = at + 1;
    }
  }
  return out;
}

function placeholderAt(
  pattern: string, at: number, data: unknown, metadata: Record<string, string>, fill: (s: string) => string,
): { text: string; end: number } | null {
  const open = pattern[at + 1];
  if (open === '{') {
    if (pattern.startsWith('${*}', at)) return { text: JSON.stringify(metadata), end: at + 4 };
    const close = pattern.indexOf('}', at + 2);
    if (close < 0) return null;
    const key = pattern.slice(at + 2, close);
    return own(metadata, key) ? { text: fill(metadata[key]), end: close + 1 } : null;
  }
  if (open === '[') {
    if (pattern.startsWith('$[*]', at)) return { text: JSON.stringify(data === undefined ? null : data), end: at + 4 };
    const close = pattern.indexOf(']', at + 2);
    if (close < 0) return null;
    const value = dataValue(data, pattern.slice(at + 2, close));
    return value === undefined ? null : { text: fill(value), end: close + 1 };
  }
  return null;
}

/** `processPattern` over a key list: blank results dropped, duplicates kept once (in order). */
export function processPatterns(patterns: readonly string[] | null | undefined, msg: Pick<RuleMessage, 'metadata' | 'data'>): string[] {
  const out: string[] = [];
  for (const p of patterns ?? []) {
    const k = processPattern(p, msg).trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

// ─── the message body ────────────────────────────────────────────────────────

/**
 * The object a node reads and writes message-BODY keys on: the data itself
 * when it is a JSON object, else null. POST_TELEMETRY_REQUEST is ThingsBoard's
 * FLAT shape here (`{ key: value }`, the instant in `metadata.ts` — the
 * engine's ruling M-1), so `temperature` is a top-level key, as in ThingsBoard.
 */
export function bodyFields(data: unknown): JsonObject | null {
  return isPlainObject(data) ? data : null;
}

/** The time in a UUID v7 message id (`newMessageId`), else null. */
function idTime(id: string): number | null {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32 || hex[12] !== '7') return null;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * ThingsBoard's `TbMsg.getMetaDataTs()`: `metadata.ts` when it is a whole
 * number, else the time the message was made (here, the time in its id), else now.
 */
export function metadataTs(msg: Pick<RuleMessage, 'id' | 'metadata'>): number {
  const raw = msg.metadata.ts;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return idTime(msg.id) ?? Date.now();
}

/** A number from a JSON value: a finite number, or a string that parses to one; else null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Java's `BigDecimal.valueOf(x).setScale(places, RoundingMode.HALF_UP)`: half
 * away from zero, on the shortest decimal text of `x` (what `BigDecimal.valueOf`
 * reads), so 1.005 rounds to 1.01 as it does in ThingsBoard.
 */
export function roundHalfUp(x: number, places: number): number {
  if (!Number.isFinite(x)) return x;
  const p = Math.max(0, Math.min(15, Math.floor(places)));
  const sign = x < 0 ? -1 : 1;
  const text = String(Math.abs(x));
  if (/e/i.test(text)) return sign * (Math.round(Math.abs(x) * 10 ** p) / 10 ** p);
  const [int, frac = ''] = text.split('.');
  if (frac.length <= p) return x;
  const kept = `${int}${frac.slice(0, p)}`;
  const up = Number(frac[p]) >= 5;
  const scaled = BigInt(kept) + (up ? 1n : 0n);
  const digits = scaled.toString().padStart(p + 1, '0');
  const out = p === 0 ? digits : `${digits.slice(0, digits.length - p)}.${digits.slice(digits.length - p)}`;
  const n = Number(out) * sign;
  return Object.is(n, -0) ? 0 : n;
}

// ─── Java's number text and parsing (TB-P, 2026-11-05) ──────────────────────

/**
 * Java's `Double.toString(double)`: a plain decimal with at least one fraction
 * digit for 10⁻³ ≤ |x| < 10⁷ (`5.0`, `0.001`), otherwise `d.dddE±n` (`1.0E7`,
 * `1.0E-4`); `NaN`, `Infinity`, `-0.0`. The digits are the shortest that read
 * back as `x` — JDK 19+'s rule; an older JDK can print longer digits for rare
 * values (not reproduced).
 */
export function javaDoubleToString(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(x);
  if (abs >= 1e-3 && abs < 1e7) {
    const s = String(x);
    return s.includes('.') ? s : `${s}.0`;
  }
  const [mantissa, exponent] = x.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}

const LONG_MAX = 9223372036854775807n;
const LONG_MIN = -9223372036854775808n;

/** Java's `(long) x` as text: toward zero, NaN → 0, beyond the long range → Long.MAX / MIN_VALUE. */
export function javaLongText(x: number): string {
  if (Number.isNaN(x)) return '0';
  if (x >= 9223372036854775807) return LONG_MAX.toString();
  if (x <= -9223372036854775808) return LONG_MIN.toString();
  return BigInt(Math.trunc(x)).toString();
}

/** Java's `(long) x` as a JSON number (exact up to 2^53, as any JSON number here). */
export const javaLong = (x: number): number => Number(javaLongText(x));

/** Java's `String.trim()`: every char ≤ U+0020 off both ends. */
const javaTrim = (s: string) => s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
const JAVA_DOUBLE = /^[+-]?(NaN|Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?)$/;

/**
 * Java's `Double.parseDouble(text)` — null where Java throws NumberFormatException.
 * Trimmed; decimal digits with an optional exponent and float / double suffix;
 * `NaN` / `Infinity` with a sign. Hexadecimal floating-point text (`0x1p3`) is
 * not read (null) — Java reads it; no instrument sends it.
 */
export function javaParseDouble(text: string): number | null {
  const t = javaTrim(text);
  const m = JAVA_DOUBLE.exec(t);
  if (!m) return null;
  const negative = t.startsWith('-');
  if (m[1] === 'NaN') return NaN;
  if (m[1] === 'Infinity') return negative ? -Infinity : Infinity;
  return Number(t.replace(/[fFdD]$/, ''));
}

/**
 * Jackson's `JsonNode.asDouble()` for a message value: a number as is; text
 * through `NumberInput.parseAsDouble` (trimmed, empty or unparseable → 0); a
 * boolean 1 / 0 (`BooleanNode`); null, an object or an array → 0.
 */
export function javaAsDouble(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return javaParseDouble(v) ?? 0;
  return 0;
}

/**
 * ThingsBoard's `KvEntry.getValueAsString()` for a stored reading: a string as
 * is; a whole number as a long (`22`); any other number by `Double.toString`;
 * a boolean `true` / `false`; an object or array as JSON.
 */
export function javaValueText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : javaDoubleToString(v);
  if (typeof v === 'boolean') return String(v);
  if (v === undefined) return '';
  return JSON.stringify(v);
}

/** A metadata value as ThingsBoard writes one: a string as is, anything else as JSON. */
export function metadataText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return JSON.stringify(v);
}

// ─── originators, scopes, scripts ───────────────────────────────────────────

/** The originator's instrument id, or a thrown error naming what the node needs. */
export function instrumentIdOf(msg: Pick<RuleMessage, 'originator'>, node: string): string {
  if (msg.originator.type !== 'INSTRUMENT') {
    throw new Error(`ORIGINATOR_NOT_INSTRUMENT: ${node} works on an instrument; this message's originator is ${msg.originator.type} (use Change originator first)`);
  }
  return msg.originator.id;
}

export const ATTRIBUTE_SCOPES = ['SERVER_SCOPE', 'SHARED_SCOPE', 'CLIENT_SCOPE'] as const;

/** ThingsBoard reads the scope from `metadata.scope` when the message carries one, else the node's own. */
export function scopeOf(msg: Pick<RuleMessage, 'metadata'>, configured: unknown): string {
  const md = msg.metadata.scope;
  if (typeof md === 'string' && (ATTRIBUTE_SCOPES as readonly string[]).includes(md)) return md;
  return typeof configured === 'string' && (ATTRIBUTE_SCOPES as readonly string[]).includes(configured) ? configured : 'SERVER_SCOPE';
}

/**
 * The script a node RUNS, to run through `ctx.runScript` (never script-vm's
 * `runScript` directly — the context's is keyed to the node, so a script that
 * keeps timing out is disabled). ONE rule for every script node — Filter
 * script, Switch, Script transform, Log, Generator, Create / Clear alarm —
 * and it is `@digilog/shared`'s `ruleNodeScript` (ruling TB-L, 2026-11-05),
 * the same rule the editor's script field, the import and the export read:
 * `scriptLang: 'TBEL'` with a non-blank TBEL script (a document stored before
 * TB-L) runs THAT text as JavaScript; anything else runs the JavaScript key.
 * TBEL itself is not built (spec §3); nothing refuses a TBEL node any more.
 */
export function nodeScriptOf(type: string, config: object): string {
  const cfg = config as JsonObject;
  const script = ruleNodeScript(type, cfg);
  if (typeof script !== 'string' || script.trim() === '') {
    throw new Error(`SCRIPT_REQUIRED: the node has no script (${ruleNodeScriptKey(type, cfg) ?? type})`);
  }
  return script;
}

/** The node type of each JavaScript script key — every type sharing a key shares its TBEL twin, so the key alone decides. */
const SCRIPT_TYPE_BY_JS_KEY: ReadonlyMap<string, string> = new Map(Object.entries(RULE_SCRIPT_KEYS).map(([type, [js]]) => [js, type]));

/** `nodeScriptOf` for a caller that names the JavaScript KEY (`alarm-support.ts`: `alarmDetailsBuildJs`). */
export function jsScriptOf(config: object, key: string): string {
  const type = SCRIPT_TYPE_BY_JS_KEY.get(key);
  if (type === undefined) throw new Error(`SCRIPT_REQUIRED: "${key}" is not a script key`);
  return nodeScriptOf(type, config);
}
