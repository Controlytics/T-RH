-- Audit 2026-05-04 fix C3: tamper-evident audit-trail hash chain.
--
-- Adds two columns to audit_trail:
--   previous_checksum (VARCHAR(64), NULL) — links each row to its predecessor.
--     Existing rows get NULL (pre-chain era — verified by per-row checksum
--     only). New rows written by lib/audit.ts will be chained.
--   chain_position (BIGSERIAL) — monotonic insert order for verification
--     walks. Backfilled in timestamp+id order so existing rows have a stable
--     position even though they're not chained.
--
-- The migration is non-destructive and idempotent.

ALTER TABLE audit_trail
  ADD COLUMN IF NOT EXISTS previous_checksum VARCHAR(64),
  ADD COLUMN IF NOT EXISTS chain_position BIGSERIAL;

-- Index on chain_position so verification walks are O(rows) not O(rows^2).
CREATE INDEX IF NOT EXISTS idx_audit_trail_chain_position
  ON audit_trail (chain_position);

-- Backfill chain_position for existing rows in timestamp+id order so they
-- have a stable, deterministic ordering even though they're not chained.
-- BIGSERIAL would have already assigned values during the ADD COLUMN, but
-- those values are insertion-order-dependent on Postgres's internal scan
-- order and not deterministic on re-run. Re-stamp via a window function so
-- the sequence reflects historical timestamp order.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY timestamp ASC, id ASC) AS pos
  FROM audit_trail
)
UPDATE audit_trail a
SET chain_position = ranked.pos
FROM ranked
WHERE a.id = ranked.id;

-- Reset the sequence so future inserts continue from max(chain_position)+1.
SELECT setval(
  pg_get_serial_sequence('audit_trail', 'chain_position'),
  COALESCE((SELECT MAX(chain_position) FROM audit_trail), 0) + 1,
  false
);
