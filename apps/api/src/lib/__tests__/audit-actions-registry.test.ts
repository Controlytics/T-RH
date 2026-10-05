import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { AUDIT_ACTIONS } from '@digilog/shared';

/**
 * Every `action: '…'` literal the API writes is a key of `AUDIT_ACTIONS`
 * (audit 2026-10-03, DATA-10). The registry is the controlled vocabulary an
 * inspector reads; by 2026-10-05 eleven actions were being written that it
 * did not name and twenty-eight it named were written nowhere. This scan is
 * what keeps the two in step from now on: a new `auditLog({ action: 'X' })`
 * with no registry entry fails here, in the same commit.
 *
 * Scope: non-test source under `apps/api/src` (test files write deliberate
 * nonsense like `TAMPER_VICTIM`). Comments are stripped first — a reauth
 * example in a doc comment reads `action: 'DELETE_USER'` and is not a write.
 * Actions chosen by a ternary (`approved ? 'X' : 'Y'`) are not literals of
 * this shape and are covered by their own e2e tests.
 */
const SRC = resolve(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'e2e' || name === 'node_modules') continue;
      sourceFiles(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

describe('audit action literals written by the API', () => {
  it('are all keys of AUDIT_ACTIONS', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const unregistered = new Map<string, string[]>();
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/\baction:\s*'([A-Z][A-Z0-9_]+)'/g)) {
        const name = m[1];
        if (name in AUDIT_ACTIONS) continue;
        const rel = file.slice(SRC.length + 1).split(sep).join('/');
        unregistered.set(name, [...(unregistered.get(name) ?? []), rel]);
      }
    }
    expect(Object.fromEntries(unregistered)).toEqual({});
  });
});
