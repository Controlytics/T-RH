import { RULE_SCRIPT_KEYS, ruleNodeScript, ruleNodeScriptKey } from '@digilog/shared';
import type { RuleMessage } from '../../message.js';

/**
 * Helpers the Enrichment and Action node handlers share (rule chains, Task 5,
 * 2026-11-04). Written in parallel with Task 6's `nodes/external/template.ts`,
 * which has its own `processPattern`; the two follow the same ThingsBoard rule
 * and should be folded into ONE shared helper.
 */

export type JsonObject = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

// ─── templates ───────────────────────────────────────────────────────────────

const METADATA_VAR = /\$\{([^}]*)\}/g;
const DATA_VAR = /\$\[(.*?)\]/g;

/**
 * ThingsBoard's `TbNodeUtils.processPattern`: `${key}` → the metadata value,
 * then `$[path]` → the message data's value at a dot path (`$[a.b]`). Only a
 * VALUE (string, number, boolean, null) is substituted; a missing key, an
 * object or an array leaves the pattern as written. Data patterns are read only
 * when the data is a JSON object.
 */
export function processPattern(pattern: string, msg: Pick<RuleMessage, 'metadata' | 'data'>): string {
  if (typeof pattern !== 'string' || pattern === '') return pattern ?? '';
  const withMetadata = pattern.replace(METADATA_VAR, (whole, key: string) =>
    (Object.prototype.hasOwnProperty.call(msg.metadata, key) ? msg.metadata[key] : whole));
  if (!isPlainObject(msg.data)) return withMetadata;
  const data = msg.data;
  return withMetadata.replace(DATA_VAR, (whole, path: string) => {
    let node: unknown = data;
    for (const key of path.split('.')) {
      if (key === '' || !isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return whole;
      node = node[key];
    }
    if (node === null) return 'null';
    if (typeof node === 'string') return node;
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    return whole;
  });
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
