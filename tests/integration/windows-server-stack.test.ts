/**
 * Windows-server-stack integration suite (Phase 5, Task 5.1).
 *
 * Verifies the post-rewrite stack works as a coherent whole:
 *   1. Phase 0 — Fastify boots in-process via the existing e2e test helper
 *   2. Phase 2 — graphile-worker (Postgres-backed) enqueue + dispatch
 *
 * Gating
 *   The whole suite is gated on `INTEGRATION_TEST=1`. A normal
 *   `npx vitest run` from the repo root therefore registers the suites as
 *   skipped and exits clean — we never accidentally hit Postgres in CI.
 *
 * Real infra
 *   When the gate is on, this suite hits the same Postgres the dev stack uses
 *   (`DATABASE_URL`, rewritten onto `digilog_test_db` by apps/api/vitest.env.ts).
 *   No mocks. Cleanup runs in `afterAll` keyed by a per-run UUID so leftover
 *   rows from a crash don't pollute the next dev run. Cleanup steps log their
 *   failures rather than swallow them (per CLAUDE.md "Never swallow exceptions").
 *
 * ─── 2026-07-15 (M05): the MQTT / TimescaleDB half was DELETED, not disabled ──
 *   This file used to import `aedes` + `mqtt` at the top level and assert an
 *   MQTT → mqtt-handler → `ts_telemetry` round-trip. Phase 7 (2026-06-11..17)
 *   tore that entire subsystem out, so the imports resolved to nothing and
 *   **module resolution failed before `describe.skipIf` could skip anything** —
 *   poisoning every root-level `npx vitest run` regardless of the gate.
 *
 *   Removed as unrecoverable (each dependency is gone, not merely disabled):
 *     - `aedes` + `mqtt` — uninstalled; absent from every package.json.
 *     - `apps/api/src/transport/mqtt-client.ts`, `workers/ingestion.worker.ts`,
 *       `packages/db/` (telemetry-batcher) — all deleted.
 *     - `ts_telemetry` — the `digilog_tsdb` database was dropped outright;
 *       `to_regclass('ts_telemetry')` is NULL.
 *     - Prisma models `Organization`, `UnsMapping`, `ConnectivityStatus`,
 *       `DeviceCredential` — all dropped, so the DB fixture cannot be built.
 *   Reinstating any of it would mean reintroducing MQTT/TimescaleDB, which is a
 *   deliberate non-goal. Test 4 (puppeteer PDF render) was already removed on
 *   2026-07-04 with the reports generate/sign tear-out.
 *
 *   KEPT — these assert live subsystems and still earn their place:
 *     - Test 1: the API boots in-process and serves /api/health.
 *     - Test 2: graphile-worker addJob → task handler dispatch (`packages/queue`
 *       is very much alive; it backs notification / pm_overdue_check /
 *       session_sweep).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const GATED = process.env.INTEGRATION_TEST === '1';

// ─── Per-run marker ────────────────────────────────────────────────────────
// The queue payload we enqueue gets stamped with this UUID so a concurrent run
// can't satisfy our assertion. Computed at module load so all cases agree.
const RUN_ID = randomUUID();

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Wait for a predicate up to `timeoutMs`, polling every `pollMs`. */
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 30_000, pollMs = 250 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe.skipIf(!GATED)('windows-server-stack (Phase 5 end-to-end)', () => {
  // Lazy imports so the file is parseable even when DB/queue env is missing
  // (we only resolve these inside `beforeAll`, which is itself skipped when
  // the gate is off — the bare describe.skipIf isn't enough because vitest
  // imports the module body unconditionally).
  let app: FastifyInstance;

  // graphile-worker handles
  let runner: import('graphile-worker').Runner | null = null;
  let producer: import('graphile-worker').WorkerUtils | null = null;

  // Buffer for Test 2 — populated by the phase5_verification_ping task.
  // Declared here (above beforeAll) so the closure inside startJobRunner
  // captures the correct binding at the point the task list is built.
  const phase5PingPayloads: unknown[] = [];

  beforeAll(async () => {
    // ─── 1. Boot the in-process Fastify (same pattern as e2e/audit.test) ──
    const { buildApp } = (await import('../../apps/api/src/e2e/test-helper.js')) as {
      buildApp: () => Promise<FastifyInstance>;
    };
    app = await buildApp();

    // ─── 2. graphile-worker: bootstrap schema, get producer ──────────────
    // We DON'T start the API's full job runner here — we want a tight task
    // list for the Phase 2 verification test (a custom ping task).
    const { getProducer, startJobRunner } = await import('../../packages/queue/src/index.js');
    producer = await getProducer();
    // Single Runner per process — the queue package guards against double-start.
    runner = await startJobRunner({
      taskList: {
        // Custom verifier — see Test 2.
        phase5_verification_ping: async (payload, helpers) => {
          helpers.logger.info(`phase5 ping received: ${JSON.stringify(payload)}`);
          // No-op success — the test asserts that addJob → handler invocation works.
          phase5PingPayloads.push(payload);
        },
      },
      concurrency: 5,
    });
  }, 120_000);

  afterAll(async () => {
    // Close in reverse order: queue runner → app. Every step logs its own
    // failure (CLAUDE.md "Never swallow exceptions") but doesn't rethrow — we
    // WANT the remaining cleanup steps to run even if an earlier one bombs.
    try {
      const { stopJobRunner, closeProducer } = await import('../../packages/queue/src/index.js');
      await stopJobRunner();
      await closeProducer();
    } catch (err) {
      console.error('[phase5-cleanup] stop graphile-worker failed:', err);
    }

    if (app) {
      try {
        await app.close();
      } catch (err) {
        console.error('[phase5-cleanup] app.close() failed:', err);
      }
    }
    // No DB fixture cleanup needed: this suite no longer creates rows. The
    // graphile-worker job it enqueues is consumed and reaped by the runner.
  }, 60_000);

  // ─── Test 1 — Boot API (Phase 0 sanity) ──────────────────────────────────
  it('API boots in test mode and serves /api/health', async () => {
    expect(app).toBeDefined();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe('ok');
  });

  // ─── Test 2 — graphile-worker enqueue + dispatch (Phase 2) ─────────────
  it('graphile-worker: addJob → custom task handler runs to completion', async () => {
    expect(producer, 'producer must be initialised').not.toBeNull();
    expect(runner, 'runner must be initialised').not.toBeNull();

    const probePayload = { kind: 'phase5-verify', runId: RUN_ID, ts: Date.now() };
    await producer!.addJob('phase5_verification_ping', probePayload);

    const ran = await waitFor(
      async () =>
        phase5PingPayloads.some(
          (p) => (p as { runId?: string } | null)?.runId === RUN_ID,
        ),
      { timeoutMs: 15_000, pollMs: 100 },
    );

    expect(ran, 'phase5_verification_ping handler should have been invoked within 15s').toBe(true);
  }, 30_000);
});
