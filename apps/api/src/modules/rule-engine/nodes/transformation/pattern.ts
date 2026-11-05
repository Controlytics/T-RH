import { configError } from '../filter/support.js';

/**
 * ThingsBoard's KEY-PATTERN rule, shared by Copy / Delete key-value pairs:
 * `Pattern.compile(key).matcher(k).matches()` (ThingsBoard master
 * `TbCopyKeysNode` / `TbDeleteKeysNode`, read 2026-11-04). The TEMPLATE rule
 * that used to live here too is `processPattern` in `../action/support.ts`
 * (ruling TP-1, 2026-11-05: one template rule for every node).
 */

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
