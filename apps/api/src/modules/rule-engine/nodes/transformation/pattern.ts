import type { RuleMessage } from '../../message.js';
import { configError, isPlainObject } from '../filter/support.js';

/**
 * ThingsBoard's TEMPLATE and KEY-PATTERN rules, shared by Task 4's nodes
 * (Change originator, To email; Copy / Delete key-value pairs). Read off
 * ThingsBoard master `TbNodeUtils.processPattern` and the key nodes'
 * `Pattern.compile(key).matcher(k).matches()`, 2026-11-04.
 *
 * Task 5 / 6 nodes that fill templates (Create alarm's type, Send SMS …)
 * should use `processPattern` too, so a template means one thing everywhere.
 */

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const replaceAll = (s: string, find: string, by: string) => s.split(find).join(by);

/**
 * `${key}` → the metadata value, literal key match (no nesting); `${*}` → the
 * whole metadata as JSON (`{}` when empty). A key the metadata lacks stays as
 * written. `${*}` is replaced first, then each key, as ThingsBoard does.
 */
export function processMetadataPattern(pattern: string, metadata: Record<string, string>): string {
  let result = pattern;
  if (result.includes('${*}')) result = replaceAll(result, '${*}', JSON.stringify(metadata));
  for (const [key, value] of Object.entries(metadata)) result = replaceAll(result, `\${${key}}`, value);
  return result;
}

/** A data path's value as ThingsBoard's `JsonNode.asText()` prints a VALUE node; undefined for a missing key, an object or an array. */
function dataValue(data: Record<string, unknown>, path: string): string | undefined {
  const keys = path.split('.');
  // Java's String.split drops trailing empty strings: `$[a.]` reads `a`.
  while (keys.length > 1 && keys[keys.length - 1] === '') keys.pop();
  let node: unknown = data;
  for (const key of keys) {
    if (key === '' || !isPlainObject(node) || !has(node, key)) return undefined;
    node = node[key];
  }
  if (node === null) return 'null';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  return undefined;
}

const DATA_VAR = /\$\[(.*?)]/g;

/**
 * ThingsBoard's `TbNodeUtils.processPattern(pattern, msg)`:
 *  1. the metadata placeholders (`${key}`, `${*}`);
 *  2. `$[*]` → the whole message data as JSON;
 *  3. when the data is a JSON OBJECT, `$[key]` / `$[a.b]` → that data value
 *     (strings raw, numbers / booleans as text, JSON null as `null`); a
 *     missing key, an object or an array leaves the placeholder as written.
 */
export function processPattern(pattern: string, msg: Pick<RuleMessage, 'data' | 'metadata'>): string {
  let result = processMetadataPattern(pattern, msg.metadata);
  if (result.includes('$[*]')) result = replaceAll(result, '$[*]', JSON.stringify(msg.data === undefined ? null : msg.data));
  if (isPlainObject(msg.data)) {
    const data = msg.data;
    const paths = new Set<string>();
    for (const m of result.matchAll(DATA_VAR)) paths.add(m[1]);
    for (const path of paths) {
      const value = dataValue(data, path);
      if (value !== undefined) result = replaceAll(result, `$[${path}]`, value);
    }
  }
  return result;
}

const REGEX_META = /[\\^$.|?*+()[\]{}]/;
const COMPILED_MAX = 256;
const compiled = new Map<string, RegExp>();

function compileKeyPattern(pattern: string): RegExp {
  const hit = compiled.get(pattern);
  if (hit) return hit;
  let re: RegExp;
  try {
    // Java's `matches()`: the WHOLE key must match.
    re = new RegExp(`^(?:${pattern})$`);
  } catch {
    throw configError(`key pattern "${pattern}" is not a valid regular expression`);
  }
  compiled.set(pattern, re);
  if (compiled.size > COMPILED_MAX) compiled.delete(compiled.keys().next().value as string);
  return re;
}

/**
 * A matcher for the key list of Copy / Delete key-value pairs: each entry is
 * a regular expression the WHOLE key must match (Java `matches()`); an entry
 * with no regular-expression character is compared as text. An invalid
 * expression → CONFIG_INVALID (ThingsBoard refuses it at init).
 *
 * Not time-boxed — the same as ThingsBoard's Java regex; patterns are written
 * by RULE_CHAIN_MANAGE holders, the trust the script nodes assume.
 */
export function keyMatcher(patterns: unknown): (key: string) => boolean {
  const list = Array.isArray(patterns) ? patterns : [];
  const literals = new Set<string>();
  const regexes: RegExp[] = [];
  for (const p of list) {
    if (typeof p !== 'string') throw configError('a key pattern is not text');
    if (REGEX_META.test(p)) regexes.push(compileKeyPattern(p));
    else literals.add(p);
  }
  return (key) => literals.has(key) || regexes.some((re) => re.test(key));
}
