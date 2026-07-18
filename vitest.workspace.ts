import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/api/vitest.config.ts',
  'apps/web/vitest.config.ts',
  'packages/shared/vitest.config.ts',
  // Phase 5 windows-server-stack end-to-end suite. The whole suite is gated
  // on INTEGRATION_TEST=1, so this project is cheap to include in the
  // workspace — when the env var is unset its suites register as skipped.
  'tests/integration/vitest.config.ts',
]);
