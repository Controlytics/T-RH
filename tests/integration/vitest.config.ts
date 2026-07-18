/**
 * Vitest project for end-to-end "windows-server-stack" integration tests.
 *
 * The whole suite is gated on `INTEGRATION_TEST=1` (each test uses
 * `describe.skipIf(...)`). When the gate is unset, vitest still discovers the
 * file, registers the suites as skipped, and exits clean — so a normal
 * `npx vitest run` from the repo root reports "0 failed | N skipped" instead
 * of crashing on missing infra.
 *
 * Phase 5 of the windows-friendly rewrite (docs/plans/2026-04-29-windows-friendly-rewrite.md
 * Task 5.1) — verifies the post-rewrite stack: the API boots in-process and
 * graphile-worker dispatches on Postgres.
 *
 * 2026-07-15 (M05): the MQTT (aedes) + TimescaleDB half was removed — Phase 7
 * deleted those subsystems, and the dead top-level `aedes`/`mqtt` imports broke
 * COLLECTION for every root-level `vitest run`, which `describe.skipIf` cannot
 * prevent. The puppeteer/Edge PDF half went with the 2026-07-04 reports
 * generate/sign tear-out. See the test file header for the full salvage note.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['*.test.ts'],
    // Reuse the API's per-file setup (loads apps/api/.env and shared JWT
    // fallbacks) so this suite picks up the same DATABASE_URL / JWT_SECRET the
    // e2e tests depend on.
    setupFiles: [path.resolve(here, '../../apps/api/vitest.setup.ts')],
    // The global setup is conditionalised on INTEGRATION_TEST=1; when the
    // gate is unset it's a no-op so this project is safe to include in the
    // workspace on machines that don't have Postgres.
    globalSetup: [path.resolve(here, './vitest.global-setup.ts')],
    // The graphile-worker poll consumes seconds of wall-clock.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Run integration files serially — they share the DB and the graphile-worker
    // runner singleton. Parallelism would just race on those.
    fileParallelism: false,
  },
});
