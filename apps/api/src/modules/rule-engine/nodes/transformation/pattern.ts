import { REGEX_BUDGET_MS, REGEX_SNIPPET_MAX, testRegexWithBudget } from '../../../../lib/regex-budget.js';
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
/** Whole-key sources (`^(?:…)$`) of the patterns that compiled, by pattern. */
const compiled = new Map<string, string>();
/** `<source>\u0000<key>` → the budgeted answer: a device sends the same key names again and again. */
const answers = new Map<string, boolean>();
const ANSWERS_MAX = 4_096;

function compileKeyPattern(pattern: string): string {
  const hit = compiled.get(pattern);
  if (hit !== undefined) return hit;
  // Java's `matches()`: the WHOLE key must match.
  const source = `^(?:${pattern})$`;
  try {
    new RegExp(source);
  } catch {
    throw configError(`key pattern "${pattern}" is not a valid regular expression`);
  }
  compiled.set(pattern, source);
  if (compiled.size > COMPILED_MAX) compiled.delete(compiled.keys().next().value as string);
  return source;
}

/**
 * Does `key` match the whole-key `source`? Through `lib/regex-budget.ts` (M-5,
 * 2026-11-05), the 2026-10-12 audit #12 rule for an operator-typed expression
 * against text someone else chose — here a key name a DEVICE chose, of any
 * length (ingest caps the number of keys, not their length):
 *  - each test has `REGEX_BUDGET_MS`; one that runs out is "no match" — the
 *    budget's own fail-closed answer: Copy keys does not copy that key, Delete
 *    keys KEEPS it;
 *  - a key longer than `REGEX_SNIPPET_MAX` (1,000 characters) never matches a
 *    pattern: the budget judges that much text, and `matches()` is about the
 *    WHOLE key;
 *  - the answer is remembered per pattern and key (4,096 at most), so a
 *    device's key names cost one budgeted test each, not one per message.
 * A pattern with nested quantifiers (`(a+)+`) therefore costs at most the
 * budget per NEW key name, instead of holding the event loop for minutes.
 */
function matchesWithBudget(source: string, key: string): boolean {
  if (key.length > REGEX_SNIPPET_MAX) return false;
  const memo = `${source}\u0000${key}`;
  const known = answers.get(memo);
  if (known !== undefined) return known;
  const answer = testRegexWithBudget(source, key, REGEX_SNIPPET_MAX, REGEX_BUDGET_MS) === true;
  answers.set(memo, answer);
  if (answers.size > ANSWERS_MAX) answers.delete(answers.keys().next().value as string);
  return answer;
}

/**
 * A matcher for the key list of Copy / Delete key-value pairs: each entry is
 * a regular expression the WHOLE key must match (Java `matches()`), tested
 * under the regex budget (`matchesWithBudget`); an entry with no
 * regular-expression character is compared as text, with no budget needed. An
 * invalid expression → CONFIG_INVALID (ThingsBoard refuses it at init).
 */
export function keyMatcher(patterns: unknown): (key: string) => boolean {
  const list = Array.isArray(patterns) ? patterns : [];
  const literals = new Set<string>();
  const sources: string[] = [];
  for (const p of list) {
    if (typeof p !== 'string') throw configError('a key pattern is not text');
    if (REGEX_META.test(p)) sources.push(compileKeyPattern(p));
    else literals.add(p);
  }
  return (key) => literals.has(key) || sources.some((source) => matchesWithBudget(source, key));
}
