import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    // Many integration/e2e suites share the digilog_db `admin` test user and
    // its session row. Running files in parallel makes them stomp on each
    // other's sessions. Until each suite owns its own login, run files
    // serially.
    fileParallelism: false,
    testTimeout: 30000,
    /**
     * Hooks get the same budget as tests. They did not until 2026-09-01, when
     * `testTimeout` was 30s and `hookTimeout` was still on its 10s default.
     *
     * That gap failed `src/e2e/instruments.test.ts` as a SUITE while all 36 of
     * its own tests passed — its `afterAll` deletes each instrument it created
     * over HTTP, one at a time, and every DELETE writes a hash-chained audit
     * row. A dozen-plus of those plus `app.close()` does not fit in 10s.
     *
     * It was misdiagnosed first as accumulated rows in the shared test database
     * (518 orphaned instruments were cleaned out on the same day, which was
     * worth doing but changed nothing here): the hook only ever deletes what its
     * OWN run created, so the table's size never entered into it. A teardown
     * that does N audited round-trips needs a budget scaled to N, not the
     * default meant for a setup that opens a connection.
     */
    hookTimeout: 30000,
  },
});
