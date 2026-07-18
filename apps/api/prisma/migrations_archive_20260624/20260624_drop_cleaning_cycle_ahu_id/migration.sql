-- Drop the vestigial cleaning_cycles.ahu_id column + its index.
--
-- The column was never populated: every write path (start-cycle, manual-cycle,
-- tape generation) hardcoded `ahuId: null`, and nothing read it for display or
-- logic. AHU scoping is derived through filter -> AssetInstance.parentId, never
-- this denormalized column. The only reachable reference was a latent filter in
-- getCycles (`where.ahuId = query.ahuId`) that, when fed the /cycles route's
-- ahuId querystring param, silently returned zero rows (it matched an
-- always-null column). Both the filter and the route param are removed alongside
-- this drop.
--
-- Pre-verified: cleaning_cycles.ahu_id is NULL for every row.
-- DROP COLUMN auto-drops cleaning_cycles_ahu_id_status_idx; the explicit
-- DROP INDEX is convention, not load-bearing.

BEGIN;

DROP INDEX IF EXISTS "cleaning_cycles_ahu_id_status_idx";
ALTER TABLE "cleaning_cycles" DROP COLUMN IF EXISTS "ahu_id";

COMMIT;

-- Verification: should return zero rows.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'cleaning_cycles' AND column_name = 'ahu_id';
