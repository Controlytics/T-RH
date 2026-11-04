import { JSONPath } from 'jsonpath-plus';
import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { copyMessage } from '../../message.js';

/**
 * JSON path — ThingsBoard's `TbJsonPathNode` (spec §7), on `jsonpath-plus`
 * (ThingsBoard uses Jayway JsonPath). The message data is REPLACED by what
 * `jsonPath` selects; id, type, originator and metadata are kept; `Success`.
 *
 * Jayway's rules, kept:
 *  - `$` (the default) passes the SAME message untouched;
 *  - a path not starting with `$` is read from the root (`values.t` = `$.values.t`);
 *  - a DEFINITE path (no wildcard, deep scan, filter, union or slice) gives the
 *    value itself; when it selects nothing → `Failure`
 *    "No results for path: <path>" (Jayway's PathNotFoundException);
 *  - an INDEFINITE path gives the list of matches, `[]` when there are none.
 * jsonpath-plus accepts malformed paths (`$[` reads the whole document), so a
 * path is checked first — balanced brackets and quotes, no trailing `.`, no
 * space outside brackets — and a malformed one is a `Failure`
 * "Invalid JSON path …" (Jayway's InvalidPathException, at init).
 * Filter expressions run on jsonpath-plus's own `safe` evaluator, never
 * JavaScript `eval`.
 */
export const JSON_PATH = 'tb:transformation:json-path';

export interface JsonPathConfig {
  jsonPath: string;
}

const DEFAULT_JSON_PATH = '$';

function invalid(raw: string, why: string): Error {
  return new Error(`Invalid JSON path "${raw}": ${why}`);
}

/** The path as Jayway reads it, or an error naming what is wrong with it. */
export function normaliseJsonPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw invalid(raw, 'the path is empty');
  const path = trimmed.startsWith('$') ? trimmed : trimmed.startsWith('[') ? `$${trimmed}` : `$.${trimmed}`;
  if (path.length > 1 && path[1] !== '.' && path[1] !== '[') throw invalid(raw, "'$' must be followed by '.' or '['");
  if (path.endsWith('.')) throw invalid(raw, "it ends with '.' or '..'");
  let depth = 0;
  let quote: string | null = null;
  for (let i = 1; i < path.length; i++) {
    const c = path[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (depth > 0 && (c === "'" || c === '"')) quote = c;
    else if (c === '[') depth += 1;
    else if (c === ']') {
      if (depth === 0) throw invalid(raw, "a ']' without its '['");
      depth -= 1;
    } else if (depth === 0 && /\s/.test(c)) throw invalid(raw, 'a space outside brackets');
  }
  if (quote) throw invalid(raw, 'an unterminated quote');
  if (depth > 0) throw invalid(raw, "a '[' without its ']'");
  return path;
}

/** Jayway's "definite" path: no wildcard, deep scan, filter, union or slice. */
export function isDefiniteJsonPath(path: string): boolean {
  return JSONPath.toPathArray(path).slice(1).every((s) =>
    s !== '*' && s !== '..' && s !== '^' && s !== '~' && !s.startsWith('?(') && !s.includes(',') && !s.includes(':'));
}

export const jsonPathNode: RuleNodeHandler<JsonPathConfig> = (ctx, msg) => {
  const raw = typeof ctx.config.jsonPath === 'string' ? ctx.config.jsonPath : DEFAULT_JSON_PATH;
  if (raw === DEFAULT_JSON_PATH) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  const path = normaliseJsonPath(raw);
  const found = JSONPath({ path, json: msg.data === undefined ? null : msg.data, wrap: true, eval: 'safe' });
  const matches = Array.isArray(found) ? found : [];
  let data: unknown;
  if (isDefiniteJsonPath(path)) {
    if (matches.length === 0) throw new Error(`No results for path: ${path}`);
    data = matches[0];
  } else {
    data = matches;
  }
  ctx.tellNext(copyMessage(msg, { data }), RULE_RELATION_SUCCESS);
};
