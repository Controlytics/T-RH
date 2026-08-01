import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Frontend↔backend route parity.
 *
 * This gap has already shipped bugs: a dead `/api/filters/dashboard-stats`
 * poll 404'd every 20s for months, unnoticed, because nothing asserted that
 * the paths the SPA calls actually exist on the server.
 */
const WEB_SRC = resolve(__dirname, '../../../web/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Extract `/api/...` string literals, normalising `${...}` interpolation to `:param`. */
export function extractApiPaths(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/['"`](\/api\/[^'"`\s?]*)/g)) {
    const path = m[1].replace(/\$\{[^}]*\}/g, ':param').replace(/\/+$/, '');
    if (path.length > 5) found.add(path);
  }
  return [...found];
}

describe('frontend↔backend route parity', () => {
  it('extracts and normalises interpolated paths', () => {
    expect(extractApiPaths('fetch(`/api/users/${id}/lock`)')).toEqual(['/api/users/:param/lock']);
  });

  it('every /api path the SPA calls exists on the server', async () => {
    const { buildApp } = await import('./test-helper.js');
    const app = await buildApp();
    const spec = app.swagger() as { paths: Record<string, unknown> };
    // Server paths as regexes: /api/users/:id → ^/api/users/[^/]+$
    // Trailing slash is stripped to match the SPA-side normalisation below —
    // Fastify's router treats `/api/roles` and `/api/roles/` as the same route
    // (verified via app.inject: both return the same status), but the raw
    // swagger path for a bare-prefix GET is registered with the slash.
    //
    // modules/config/dynamic-routes.ts registers one literal Fastify route per
    // config def's moduleKey (`/dynamic/${def.moduleKey}`) — a data-driven family
    // of N single-segment routes, not one OpenAPI `{moduleKey}` param. The SPA
    // calls them through a single interpolated path, which normalises to
    // `/api/config/dynamic/:param`. Collapse that literal family into one
    // wildcard shape so the comparison checks what's actually verifiable
    // statically: "does a dynamic-config route exist at this shape."
    //
    // DELIBERATE COARSENING, NOT AN OVERSIGHT: this is the one path family
    // where this test's precision is intentionally lower than everywhere
    // else. extractApiPaths() only sees the SPA source text, so a call like
    // `/api/config/dynamic/${moduleKey}` loses the real runtime moduleKey and
    // becomes the generic `:param` — there is no way to statically recover
    // which literal config key was actually requested. Because of that, this
    // check CANNOT catch a SPA call to a moduleKey that doesn't exist as a
    // registered config def (e.g. a typo'd or removed key) — it only confirms
    // that *some* dynamic-config route exists at this shape. Every other path
    // in this test still gets exact literal-vs-literal (or literal-vs-{param})
    // matching; only this family is widened, and only because the SPA-side
    // extraction makes anything narrower structurally impossible.
    const rawServerPaths = Object.keys(spec.paths).map(p => p.replace(/\/+$/, ''));
    const serverPaths = [...new Set(rawServerPaths.map(
      p => (/^\/api\/config\/dynamic\/[^/]+$/.test(p) ? '/api/config/dynamic/:param' : p),
    ))];
    const serverMatchers = serverPaths.map(
      p => new RegExp('^' + p.replace(/\{[^}]+\}/g, '[^/]+').replace(/:param/g, '[^/]+').replace(/\//g, '\\/') + '$'),
    );
    const called = walk(WEB_SRC).flatMap(f => extractApiPaths(readFileSync(f, 'utf8')));
    const orphans = [...new Set(called)].filter(
      c => !serverMatchers.some(rx => rx.test(c.replace(/:param/g, 'x'))),
    );
    expect(orphans, `SPA calls endpoints that do not exist:\n${orphans.join('\n')}`).toEqual([]);
    await app.close();
  });
});
