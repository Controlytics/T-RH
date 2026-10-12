import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Cancelling the password dialog is a silent no-op on every screen (audit
 * 2026-10-12, finding 10 and its follow-up).
 *
 * `useReauth` calls `onCancel` when the operator cancels. A caller that passes
 * none falls back to `onError` with the REAUTH_CANCELLED sentinel — kept as a
 * safety net so a caller that clears its busy flag only in `onError` cannot
 * wedge — and every such caller rendered that sentinel as a red "Cancelled —
 * password confirmation was not completed." The fallback cannot simply be made
 * silent in the hook: `onError` both clears flags and shows the message, and
 * the hook cannot do one without the other. So the rule is enforced here
 * instead: any `reauth.execute(...)` that handles errors must also say what a
 * cancel does.
 *
 * KNOWN_OUTSIDE_AREA lists callers in folders another fixer owned when this
 * test was written; each still shows the red message on cancel and is reported
 * to the lead. Remove an entry once that file declares `onCancel`.
 */
const SRC = join(__dirname, '..', '..');
const KNOWN_OUTSIDE_AREA = new Set<string>(['routes/config/ldap.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** The text of each `reauth.execute(` call, bracket-matched. */
function executeCalls(src: string): { line: number; text: string }[] {
  const calls: { line: number; text: string }[] = [];
  const re = /\breauth\.execute\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (depth && i < src.length) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      i++;
    }
    calls.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i) });
  }
  return calls;
}

describe('every reauth.execute caller that handles errors also handles a cancel', () => {
  it('finds the callers at all (the scan can match)', () => {
    const total = walk(SRC).reduce((n, f) => n + executeCalls(readFileSync(f, 'utf-8')).length, 0);
    expect(total).toBeGreaterThan(30);
  });

  it('declares onCancel wherever onError is declared', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (KNOWN_OUTSIDE_AREA.has(rel)) continue;
      for (const c of executeCalls(readFileSync(file, 'utf-8'))) {
        if (c.text.includes('onError') && !c.text.includes('onCancel')) offenders.push(`${rel}:${c.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
