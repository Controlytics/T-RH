import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainTsx = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

// Routes intentionally open today (auth handled inside component). Phase 2 closes these.
const KNOWN_OPEN = ['/quality-notifications'];

describe('route-guard coverage', () => {
  it('documents the known open routes (loose Phase-1 lock)', () => {
    // LOOSE LOCK (Phase 1): this only extracts every path="..." string and asserts
    // main.tsx parsed + the two known-open routes still exist. It does NOT detect a
    // newly-added unguarded route — it does not parse RequireRole wrapping at all.
    // Phase 2 replaces this body with a real guard check that asserts KNOWN_OPEN is
    // empty (both routes wrapped) and that no other route renders without a guard.
    const routeMatches = [...mainTsx.matchAll(/path="([^"]+)"/g)].map(m => m[1]);
    expect(routeMatches.length).toBeGreaterThan(50); // sanity: main.tsx parsed
    for (const open of KNOWN_OPEN) {
      expect(routeMatches, `expected known-open route ${open} to still exist`).toContain(open);
    }
  });
});
