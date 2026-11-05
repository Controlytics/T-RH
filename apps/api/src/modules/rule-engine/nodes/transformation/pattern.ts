import { REGEX_BUDGET_MS, REGEX_SNIPPET_MAX, regexWithBudget } from '../../../../lib/regex-budget.js';
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
/** `<source>\u0000<key>` → a DEFINITE budgeted answer (match / no match — never a time-out): a device sends the same key names again and again. */
const answers = new Map<string, boolean>();
const ANSWERS_MAX = 4_096;

/**
 * A key pattern that runs out its budget this many times is SWITCHED OFF for its node (FW-N3 follow-up c,
 * 2026-11-05): every later key is "no match" with no regex run — the way RE-3 switches off a script that keeps
 * timing out (script-vm.ts). One time-out holds the event loop for the whole budget, synchronously, INSIDE one node,
 * where the flow's between-node yield (review A C1) cannot help: 1,000 new key names would otherwise be 100 s.
 *
 * Counted in TOTAL, not in a row — a deliberate difference from the script rule's consecutive count: key names
 * alternating with harmless ones (a quick "no match" between two run-outs) would reset a consecutive count and
 * keep a catastrophic pattern alive for ever.
 *
 * Keyed `<chainId>:<nodeId>:<chain version>` + the pattern, as script-vm keys its switch-off, so a save that
 * changes the chain (a new version, `ctx.chain.version`) re-arms it. Logged once, when it trips.
 */
export const KEY_PATTERN_DISABLE_AFTER_TIMEOUTS = 3;
const TIMEOUTS_MAX_KEYS = 10_000;
/** `<scope>\u0000<source>` → time-outs so far. */
const timeouts = new Map<string, number>();

/** Where a matcher's run-outs are counted and said: `scope` = `<ctx.nodeKey>:<ctx.chain.version>`. */
export interface KeyPatternScope {
  scope: string;
  log: (text: string) => void;
}

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
 *  - a DEFINITE answer is remembered per pattern and key (4,096 at most), so a
 *    device's key names cost one budgeted test each, not one per message; a
 *    run-out is never remembered;
 *  - a pattern that runs out its budget `KEY_PATTERN_DISABLE_AFTER_TIMEOUTS`
 *    times is switched off for the node and chain version (see above).
 * A pattern with nested quantifiers (`(a+)+`) therefore costs at most three
 * budgets per node and chain version, instead of holding the event loop for
 * minutes.
 */
function matchesWithBudget(source: string, pattern: string, key: string, where: KeyPatternScope | undefined): boolean {
  if (key.length > REGEX_SNIPPET_MAX) return false;
  const strikeKey = where ? `${where.scope}\u0000${source}` : null;
  // Switched off for this node and chain version: "no match", no regex run (a remembered match included).
  if (strikeKey !== null && (timeouts.get(strikeKey) ?? 0) >= KEY_PATTERN_DISABLE_AFTER_TIMEOUTS) return false;
  const memo = `${source}\u0000${key}`;
  const known = answers.get(memo);
  if (known !== undefined) return known;
  const verdict = regexWithBudget(source, key, REGEX_SNIPPET_MAX, REGEX_BUDGET_MS);
  if (verdict === 'timeout') {
    // NEVER remembered: a run-out is no answer (a pause of the process could cause one), only a strike.
    if (strikeKey !== null && where) {
      const n = (timeouts.get(strikeKey) ?? 0) + 1;
      if (timeouts.size >= TIMEOUTS_MAX_KEYS && !timeouts.has(strikeKey)) timeouts.delete(timeouts.keys().next().value as string);
      timeouts.set(strikeKey, n);
      if (n === KEY_PATTERN_DISABLE_AFTER_TIMEOUTS) {
        where.log(`key pattern "${pattern}" ran out of its ${REGEX_BUDGET_MS} ms budget ${n} times — switched off for this node `
          + 'until its chain is saved with a change: every key is "no match" for it until then');
      }
    }
    return false;
  }
  const answer = verdict === 'match';
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
 * `where` is the node's scope for the pattern switch-off (Copy / Delete keys
 * always pass it); without one, every test still has its budget.
 */
export function keyMatcher(patterns: unknown, where?: KeyPatternScope): (key: string) => boolean {
  const list = Array.isArray(patterns) ? patterns : [];
  const literals = new Set<string>();
  const regexes: { pattern: string; source: string }[] = [];
  for (const p of list) {
    if (typeof p !== 'string') throw configError('a key pattern is not text');
    if (REGEX_META.test(p)) regexes.push({ pattern: p, source: compileKeyPattern(p) });
    else literals.add(p);
  }
  return (key) => literals.has(key) || regexes.some((r) => matchesWithBudget(r.source, r.pattern, key, where));
}

/** The pattern switch-off scope of a Copy / Delete keys node: its node key and chain version, its warnings to the node log. */
export function keyPatternScope(ctx: { nodeKey: string; chain: { version: number }; log: (level: 'warn', text: string) => void }): KeyPatternScope {
  return { scope: `${ctx.nodeKey}:${ctx.chain.version}`, log: (text) => ctx.log('warn', text) };
}
