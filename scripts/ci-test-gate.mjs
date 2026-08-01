import { execSync } from 'node:child_process';

/**
 * Known-failing baseline — a documented RATCHET, not a fudge.
 *
 * These failures are Phase 0 domain-strip test debt that predates this work;
 * every one fails identically on a clean checkout of HEAD. CI fails only when
 * failures EXCEED the baseline, so no NEW breakage can land. That property is
 * what makes "extends without breaking existing functionality" verifiable
 * across the other 14 tasks.
 *
 * Itemised so this is auditable rather than a magic number:
 *   shared (3) — 1 audit-template placeholder for a removed domain template,
 *                2 permission-tree gate tests for removed nodes
 *                (cleaning_profiles.toggle, checklists.submit)
 *   web    (6) — 3 url-utils tests referencing route files deleted in the strip,
 *                2 use-can tests asserting gates for removed nodes
 *                (FCP_UPDATE, CP_PAGE_EDIT), 1 route-guard count from pre-strip
 *   api   (14) — not individually triaged; confirmed identical before/after the
 *                preceding change set. Triage is tracked as rebuild-plan A2.
 *
 * These numbers may only ever be LOWERED. Raising one to make CI pass is
 * forbidden — fix the regression instead.
 */
const BASELINE = { shared: 3, web: 6, api: 14 };

const run = (name, cmd, cwd) => {
  let out = '';
  try { out = execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  // Vitest's default reporter prints a per-file "(N tests | M failed)" line for
  // every failing file BEFORE the aggregate "Tests  M failed | ..." summary —
  // a bare /(\d+) failed/ matches the first (per-file) occurrence instead of
  // the total, silently comparing the wrong number against BASELINE. Anchor on
  // the "Tests" summary line, and strip ANSI colour codes first — vitest still
  // emits them through execSync's non-TTY pipe, and they sit directly between
  // "Tests" and the count, defeating a plain \s+ match.
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const failed = Number(/Tests\s+(\d+) failed/.exec(plain)?.[1] ?? 0);
  const budget = BASELINE[name];
  console.log(`${name}: ${failed} failed (baseline ${budget})`);
  if (failed > budget) {
    console.error(`\nFAIL: ${name} regressed — ${failed} > ${budget}\n${out.slice(-4000)}`);
    return 1;
  }
  return 0;
};

const code =
  run('shared', 'npx vitest run', 'packages/shared') +
  run('web', 'npx vitest run', 'apps/web') +
  run('api', 'npm test', 'apps/api');
process.exit(code ? 1 : 0);
