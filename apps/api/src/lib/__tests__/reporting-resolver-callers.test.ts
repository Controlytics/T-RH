import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * "Reporting" has ONE definition, and its interval has ONE resolver
 * (`effectiveExpectedIntervalSec`, plan ruling P3). A caller that passes the
 * bare `expectedIntervalSec` column quietly reads a silent TCP/IP instrument as
 * "reporting" for a whole day (the site fallback window), so this pins every
 * call, and pins WHICH files may call at all: a new caller must be added here
 * consciously, not by copy-paste.
 */
const SRC = join(__dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'e2e' || name === 'test-support') continue;
      sources(p, out);
    } else if (p.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

/** The text of the second argument of the call whose `(` is at `open`. */
function secondArgument(src: string, open: number): string {
  let depth = 0;
  let commas = 0;
  let start = -1;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return start < 0 ? '' : src.slice(start, i).trim();
    } else if (c === ',' && depth === 1) {
      commas += 1;
      if (commas === 1) start = i + 1;
      else if (commas === 2) return src.slice(start, i).trim();
    }
  }
  return '';
}

const EXPECTED_CALLERS = [
  'modules/functional-locations/routes.ts',
  'modules/instruments/routes.ts',
  'modules/instruments/telemetry-overview.ts',
];

describe('isInstrumentReporting callers', () => {
  const calls: { file: string; second: string }[] = [];
  for (const file of sources(SRC)) {
    const src = readFileSync(file, 'utf8');
    const re = /\bisInstrumentReporting\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // Skip the definition and prose mentions in comments.
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const line = src.slice(lineStart, src.indexOf('\n', m.index));
      const before = src.slice(lineStart, m.index);
      if (/^\s*\*|\/\/|\/\*/.test(before) || /function\s+isInstrumentReporting/.test(line)) continue;
      calls.push({
        file: relative(SRC, file).split(sep).join('/'),
        second: secondArgument(src, m.index + m[0].length - 1),
      });
    }
  }

  it('finds the callers (the scan is not vacuous)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(EXPECTED_CALLERS.length);
  });

  it('passes the resolver, never a bare column, as the interval', () => {
    for (const c of calls) {
      expect(c.second, `${c.file}: ${c.second}`).toMatch(/^effectiveExpectedIntervalSec\(/);
    }
  });

  it('is called from exactly the known files', () => {
    expect([...new Set(calls.map((c) => c.file))].sort()).toEqual(EXPECTED_CALLERS);
  });
});

/**
 * The browser never decides "reporting": the API sends `reporting` and
 * `effectiveExpectedIntervalSec` on every instrument (root CLAUDE.md "never
 * reconstruct server-side decisions in the client"). A web call to
 * `isInstrumentReporting(` would read a silent TCP/IP instrument as reporting.
 */
describe('the web does not decide reporting', () => {
  const WEB = join(SRC, '..', '..', 'web', 'src');
  function webSources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        webSources(p, out);
      } else if (/\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.(ts|tsx)$/.test(p)) {
        out.push(p);
      }
    }
    return out;
  }

  it('no non-test file under apps/web/src calls isInstrumentReporting', () => {
    const files = webSources(WEB);
    expect(files.length).toBeGreaterThan(50);
    const callers: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const re = /\bisInstrumentReporting\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*\*|\/\/|\/\*/.test(src.slice(lineStart, m.index))) continue;
        callers.push(relative(WEB, file).split(sep).join('/'));
      }
    }
    expect(callers).toEqual([]);
  });
});
