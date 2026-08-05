import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainTsx = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

/**
 * Routes that render WITHOUT a <RequireRole> wrapper, and why each is legitimate:
 *
 *   /login, /forgot-password, /change-password, /contact-admin
 *       Pre-authentication surfaces. A permission gate here would lock out the
 *       very users who need them.
 *   /                Dashboard. Visible to every authenticated user.
 *   /home            Module Guide. Has no PERMISSION_TREE group by design —
 *                    governed on the Sidebar tab only (see apps/web/CLAUDE.md).
 *   /profile         The user's own profile. Self-scoped, not permission-scoped.
 *   *                Catch-all / not-found.
 *
 * This list is a LOCK, not an endorsement: it records what is unguarded today so
 * that a NEW unguarded route fails this test and has to be justified here.
 * `/quality-notifications` used to be on it — it was not "closed", the page was
 * deleted in the 2026-07-18 domain strip.
 */
const KNOWN_OPEN = [
  '/login',
  '/forgot-password',
  '/change-password',
  '/contact-admin',
  '/',
  '/home',
  '/profile',
  '*',
];

/** Every <Route …/> or <Route …>…</Route> element, with its path and guard state. */
function parseRoutes(source: string): { path: string; guarded: boolean }[] {
  const out: { path: string; guarded: boolean }[] = [];
  for (const m of source.matchAll(/<Route\b[\s\S]*?(?:\/>|<\/Route>)/g)) {
    const path = /path="([^"]+)"/.exec(m[0])?.[1];
    if (!path) continue;
    out.push({ path, guarded: m[0].includes('RequireRole') });
  }
  return out;
}

describe('route-guard coverage', () => {
  const routes = parseRoutes(mainTsx);

  it('parses every route in main.tsx', () => {
    // Cross-check the element parser against a plain count of path="…" strings.
    // If these disagree the regex has swallowed a nested route and every other
    // assertion in this file is reading an incomplete picture.
    const rawPathCount = [...mainTsx.matchAll(/path="([^"]+)"/g)].length;
    expect(routes).toHaveLength(rawPathCount);

    // Floor, not a tripwire. Deliberately far below the real count so that
    // deleting a page does not fail this test for the wrong reason — the
    // previous `> 50` was set when the app had more pages and became a
    // permanent failure after the domain strip took main.tsx down to 40.
    expect(routes.length).toBeGreaterThan(20);
  });

  it('no route renders without a guard except the documented ones', () => {
    const open = routes.filter(r => !r.guarded).map(r => r.path).sort();
    expect(open).toEqual([...KNOWN_OPEN].sort());
  });
});
