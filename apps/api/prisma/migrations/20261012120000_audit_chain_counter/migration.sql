-- audit_chain_counter — a TRANSACTIONAL source for audit_trail.chain_position
-- (audit 2026-10-12 #5; lead decision "option c").
--
-- chain_position was filled by its BIGSERIAL default
-- (audit_trail_chain_position_seq). A sequence never gives a value back, so
-- every audit insert inside a transaction that ROLLED BACK (e.g.
-- auth/session-sweep.ts) burned a position, and verify-chain reported the gap
-- as an interior row deletion. A gap could not simply be excused when the next
-- row still links to its predecessor: deleting the NEWEST rows and then writing
-- leaves exactly that shape (four of the seven local gaps from the 2026-07-25
-- incident are such deletions), so the excuse would hide real deletions.
--
-- Instead the writer (apps/api/src/lib/audit.ts) now takes the next position
-- from this one-row counter, with an UPDATE ... RETURNING inside its own
-- transaction and under the chain's advisory lock. A rollback rolls the
-- counter back with the row, so positions are dense and a gap only ever means
-- a deletion. The counter is never derived from max(chain_position) at write
-- time: after a tail deletion that would hand the deleted position out again
-- with an intact link and leave no trace at all.
--
-- Seeded from the current max(chain_position). The BIGSERIAL default and the
-- sequence are KEPT (Prisma's datamodel declares the default; backup restore
-- resyncs the sequence); the application no longer relies on either, and
-- nothing else inserts audit rows.
--
-- No Prisma model, on purpose (like instrument_telemetry_history): listed in
-- lib/migration-guard.ts UNMODELLED_TABLES and PROTECTED_TABLES. Backup does
-- not export it; restore re-derives it from the restored trail.
CREATE TABLE "audit_chain_counter" (
  "id"            SMALLINT PRIMARY KEY CHECK ("id" = 1),
  "last_position" BIGINT NOT NULL
);

-- Apply with the API stopped (as every deploy does): a row written between the
-- MAX and the first counter-allocated write would be given the same position.
INSERT INTO "audit_chain_counter" ("id", "last_position")
SELECT 1, COALESCE(MAX("chain_position"), 0) FROM "audit_trail";
