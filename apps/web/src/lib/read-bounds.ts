/**
 * How long a READ may wait for the server (performance audit 2026-11-17, P-03).
 * The rule itself is documented on `bounded()` in `api-client.ts`.
 *
 * In a module of their own, NOT in `api-client.ts`: a hundred test files mock
 * `@/lib/api-client` with a factory that returns only `apiClient`, and Vitest
 * THROWS when code reads any other export of a factory mock — inside an SWR
 * fetcher that throw is swallowed into an error state, so a caller that imported
 * these from the client silently stopped fetching under test.
 *
 * - `READ_TIMEOUT_MS` — a page LOAD: every SWR read (`swr-config.ts`).
 * - `LONG_READ_TIMEOUT_MS` — an action the operator started (a report, a download)
 *   and the Data Report / time-series `telemetry-history` reads (12.6 s per page at
 *   27 instruments x 30 days, G1-05, growing with the selection).
 */
export const READ_TIMEOUT_MS = 30_000;
export const LONG_READ_TIMEOUT_MS = 5 * 60_000;
