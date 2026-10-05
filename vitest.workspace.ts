import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/api/vitest.config.ts',
  'apps/web/vitest.config.ts',
  'packages/shared/vitest.config.ts',
  // Added 2026-10-05 (audit DOCS-21): the queue package has four test files
  // (connection, crontab-handlers, graphile-worker-bootstrap, job-runner) that
  // a root `npx vitest` never ran; `turbo run test` ran them via the package script.
  'packages/queue/vitest.config.ts',
  // Phase 5 windows-server-stack end-to-end suite. The whole suite is gated
  // on INTEGRATION_TEST=1, so this project is cheap to include in the
  // workspace — when the env var is unset its suites register as skipped.
  'tests/integration/vitest.config.ts',
]);
