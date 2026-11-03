/**
 * Registers every built rule node's handler (rule chains, 2026-11-03).
 * `engine.start()` calls `registerAllNodes()` once per start.
 *
 * Task 3 created this file EMPTY so the engine has its one registration
 * point; Task 4 owns it from here (filter / flow / transformation and the
 * `tb:unsupported` handler), and Tasks 5 and 6 add their imports.
 *
 * Until a type is registered, the engine sends its messages to `Failure` with
 * `metadata.error = "UNSUPPORTED_NODE: …"` (engine.ts) — so the shipped root
 * chain's four nodes do exactly that until Tasks 4 and 5 land.
 */
export function registerAllNodes(): void {
  // Tasks 4-6 register their handlers here.
}
