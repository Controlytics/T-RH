/**
 * What the External nodes share besides the template rule. The template rule
 * itself — `${key}`, `$[path]`, `${*}`, `$[*]`, one pass — is
 * `processPattern` in `../action/support.ts` (ruling TP-1, 2026-11-05: the
 * three copies, this file's among them, folded into one).
 */

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
