import type { RuleMessage } from '../../message.js';

/**
 * ThingsBoard's `TbNodeUtils.processPattern` (rule chains, 2026-11-03; read
 * from ThingsBoard v3.6.4 / master source):
 *  - `${key}` is replaced by the message METADATA value of `key`;
 *  - then `$[path]` by the message DATA value at `path` (dots walk objects:
 *    `$[a.b]`), only when the data is an object and the path ends on a plain
 *    value (string, number, boolean, null) — never an object or an array;
 *  - a placeholder that does not resolve is LEFT AS WRITTEN (ThingsBoard does
 *    not blank it), so a missing key shows in the output instead of vanishing.
 * Numbers print as JavaScript prints them (`20`, `21.5`); Jackson would print a
 * double that came in as `20.0` as `20.0` — the one difference.
 *
 * Tasks 4 and 5 template the same way (To email, Create alarm's type…); this
 * is exported so the three groups can be folded into one helper after the
 * parallel wave.
 */
const DATA_PATTERN = /\$\[(.*?)\]/g;

export function processPattern(pattern: string, msg: Pick<RuleMessage, 'metadata' | 'data'>): string {
  let result = pattern;
  for (const [key, value] of Object.entries(msg.metadata ?? {})) {
    result = result.split(`\${${key}}`).join(value);
  }
  const data = msg.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
  return result.replace(DATA_PATTERN, (whole, path: string) => {
    let node: unknown = data;
    for (const key of path.split('.')) {
      if (!key || node === null || typeof node !== 'object' || Array.isArray(node)) return whole;
      node = (node as Record<string, unknown>)[key];
      if (node === undefined) return whole;
    }
    if (node !== null && typeof node === 'object') return whole;
    return String(node);
  });
}

/**
 * ThingsBoard's `JacksonUtil.toFlatMap`: every plain value of the data under
 * its path — `a.b` for objects, `a[0]` for arrays. A non-object, non-array
 * value has no path and gives `{}`.
 */
export function toFlatMap(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (node !== null && typeof node === 'object') {
      const prefix = path ? `${path}.` : '';
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${prefix}${k}`);
    } else if (path && node !== undefined) {
      out[path] = String(node);
    }
  };
  walk(data, '');
  return out;
}

/**
 * The message data as the text ThingsBoard sends it (its data IS JSON text):
 * JSON, except a STRING with `parseToPlainText` on, which goes unquoted
 * (ThingsBoard's `parseJsonStringToPlainText`). No data at all is `{}`.
 */
export function messageText(data: unknown, parseToPlainText: boolean): string {
  if (typeof data === 'string' && parseToPlainText) return data;
  return data === undefined ? '{}' : JSON.stringify(data);
}
