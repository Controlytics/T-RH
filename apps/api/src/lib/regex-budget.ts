import vm from 'node:vm';

/**
 * Test an OPERATOR-TYPED regular expression against a response body, bounded in
 * both input and time. Shared by the alarm-webhook success check and the SMS
 * http-gateway success check, so the two cannot drift (audit 2026-10-12 #12).
 *
 * A nested quantifier (`(a+)+$`) against a body it does not match backtracks
 * exponentially. V8's regexp engine is interruptible, so a `vm` time budget turns
 * a stalled worker into an ordinary "did not match". Only the first
 * `maxChars` characters are judged: a device's acknowledgement is a few bytes,
 * and the delivery record stores no more than that anyway.
 *
 * Returns 'invalid' when the pattern does not compile, so each caller keeps its
 * own documented policy for a bad pattern; a pattern that runs out its budget
 * is `false` (fail closed).
 *
 * `regexWithBudget` tells the four outcomes apart (FW-N3 follow-up c,
 * 2026-11-05): a TIMEOUT is not a "no match" for a caller that remembers
 * answers (Copy / Delete keys must never cache a run-out as a definite no) or
 * counts run-outs (they switch a pattern off). `testRegexWithBudget` is that,
 * folded back into its original contract.
 */
export const REGEX_BUDGET_MS = 100;
export const REGEX_SNIPPET_MAX = 1000;

export type RegexBudgetVerdict = 'match' | 'no-match' | 'timeout' | 'invalid';

/**
 * The pattern against the first `maxChars` of `text`, within `budgetMs`:
 * 'match' / 'no-match'; 'invalid' when it does not compile; 'timeout' when
 * the budget ran out — recognised by the vm's own error code
 * (`ERR_SCRIPT_EXECUTION_TIMEOUT`), never by message text. Any other throw is
 * a 'no-match', as it always was a `false`.
 */
export function regexWithBudget(
  pattern: string,
  text: string,
  maxChars: number = REGEX_SNIPPET_MAX,
  budgetMs: number = REGEX_BUDGET_MS,
): RegexBudgetVerdict {
  try {
    new RegExp(pattern);
  } catch {
    return 'invalid';
  }
  try {
    return vm.runInNewContext(
      'new RegExp(pattern).test(text)',
      { pattern, text: text.slice(0, maxChars) },
      { timeout: budgetMs },
    ) === true ? 'match' : 'no-match';
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : 'no-match';
  }
}

export function testRegexWithBudget(
  pattern: string,
  text: string,
  maxChars: number = REGEX_SNIPPET_MAX,
  budgetMs: number = REGEX_BUDGET_MS,
): boolean | 'invalid' {
  const verdict = regexWithBudget(pattern, text, maxChars, budgetMs);
  return verdict === 'invalid' ? 'invalid' : verdict === 'match';
}
