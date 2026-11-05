import { describe, it, expect } from 'vitest';
import { regexWithBudget, testRegexWithBudget, REGEX_BUDGET_MS, REGEX_SNIPPET_MAX } from '../regex-budget.js';

/**
 * lib/regex-budget.ts — an operator-typed regular expression against text
 * someone else chose, bounded in input and time (audit 2026-10-12 #12).
 * `regexWithBudget` tells the four outcomes apart (FW-N3 follow-up c,
 * 2026-11-05: Copy / Delete keys must never remember a TIMEOUT as "no match");
 * `testRegexWithBudget` keeps its contract for the alarm webhooks and the SMS
 * gateway.
 */

/** `(a+)+` backtracks exponentially on "aaa…ab" — far beyond any budget at 40 a's. */
const CATASTROPHIC = '^(?:(a+)+)$';
const SLOW_TEXT = `${'a'.repeat(40)}b`;

describe('regexWithBudget — four outcomes', () => {
  it('match', () => {
    expect(regexWithBudget('"status"\\s*:\\s*"ok"', '{"status": "ok"}')).toBe('match');
  });

  it('no-match', () => {
    expect(regexWithBudget('^OK$', 'FAILED')).toBe('no-match');
  });

  it('invalid: the pattern does not compile', () => {
    expect(regexWithBudget('t(', 'anything')).toBe('invalid');
  });

  it('timeout: the budget ran out — recognised by the vm\'s own error code, never as a no-match', () => {
    const started = Date.now();
    expect(regexWithBudget(CATASTROPHIC, SLOW_TEXT, REGEX_SNIPPET_MAX, 50)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('only the first maxChars characters are judged', () => {
    expect(regexWithBudget('^a{5}$', 'aaaaaaaaaa', 5)).toBe('match');
  });
});

describe('testRegexWithBudget — the contract its callers rely on, unchanged', () => {
  it('true for a match, false for a no-match AND for a timeout (fail closed), "invalid" for a bad pattern', () => {
    expect(testRegexWithBudget('^OK', 'OK 123')).toBe(true);
    expect(testRegexWithBudget('^OK$', 'FAILED')).toBe(false);
    expect(testRegexWithBudget(CATASTROPHIC, SLOW_TEXT, REGEX_SNIPPET_MAX, 50)).toBe(false);
    expect(testRegexWithBudget('(', 'x')).toBe('invalid');
  });

  it('the defaults are the documented budget and snippet', () => {
    expect(REGEX_BUDGET_MS).toBe(100);
    expect(REGEX_SNIPPET_MAX).toBe(1000);
  });
});
