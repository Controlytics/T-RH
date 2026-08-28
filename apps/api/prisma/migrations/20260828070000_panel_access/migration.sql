-- Panel assignment, per role and per user (2026-08-28).
--
-- HAND-AUTHORED. `prisma migrate diff` also emitted three statements that are
-- DELIBERATELY NOT HERE, the same three it always emits against this baseline
-- (see 20260811120000_instrument_floorplans/migration.sql's header):
--   * DROP TABLE "instrument_telemetry_history" — partitioned, invisible to the
--     datamodel, holds every reading in the system.
--   * ALTER "audit_trail"."chain_position" DROP NOT NULL — the 21 CFR Part 11
--     hash-chain position, sequence-backed out of band.
--   * a drop/recreate of an unchanged "instrument_credentials" foreign key.
-- Applying any of them would be destructive. Only the two ADD COLUMNs below are
-- part of this change.
--
-- Nullable with NO DEFAULT on purpose: NULL means "inherit", and a DEFAULT '[]'
-- would mean "no panels" and would blank every existing role's dashboard the
-- moment this ran.
ALTER TABLE "role_configs" ADD COLUMN "dashboard_cards" JSONB;
ALTER TABLE "user_configs" ADD COLUMN "dashboard_cards" JSONB;

-- Carry over the retiring system_config['dashboard-cards'] per-role map.
--
-- TWO deliberate transformations, both of which preserve what the operator
-- actually had:
--
--  1. The four INERT keys (total_users, audit_trail, notifications,
--     quick_actions) are dropped. They gated dashboard sections that no longer
--     exist, so they never affected what anyone saw.
--
--  2. Every TREND key is ADDED. Before this migration the trend page had no
--     governance at all, so everyone saw all five of its panels. Carrying only
--     the two dashboard keys would silently strip the whole trend page from
--     every role that had a row here — a narrowing nobody asked for, and one
--     that would look like a bug in the new feature rather than in this SQL.
--
-- A role PRESENT in the map but left with no surviving dashboard key gets '[]'
-- for that half, not NULL: it had a list, and the live cards were off in it.
-- A role ABSENT from the map is left NULL (inherit) and is untouched here.
UPDATE "role_configs" rc
SET "dashboard_cards" =
  COALESCE(
    (
      SELECT jsonb_agg(k)
      FROM jsonb_array_elements_text(sc.config_value -> 'roles' -> rc."role") AS k
      WHERE k IN ('telemetry_table', 'telemetry_floorplan')
    ),
    '[]'::jsonb
  )
  || '["trend_gauges","trend_charts","trend_summary","trend_historian_table","trend_alarms"]'::jsonb
FROM "system_config" sc
WHERE sc.config_key = 'dashboard-cards'
  AND sc.config_value -> 'roles' ? rc."role";

-- Roles NAMED in the legacy map that have NO role_configs row yet.
--
-- Found the hard way: on this installation only ADMIN and VIEWER had rows, while
-- the legacy map named six roles. The UPDATE above therefore silently skipped four
-- of them, leaving NULL = inherit = every panel. That happened to be harmless here
-- only because those four listed both live cards anyway — a role whose list held
-- NO live card would have been widened from "no cards" to "every panel" by the
-- omission. Preserving the stored intent cannot depend on that luck, so the row is
-- created.
--
-- The other columns take their schema defaults ('[]' / '[]' / '{}'), which is
-- exactly what configService.getMyConfig already substitutes for a missing row, so
-- creating one changes nothing else about these roles.
INSERT INTO "role_configs" ("role", "dashboard_cards", "updated_by")
SELECT
  r.key,
  COALESCE(
    (
      SELECT jsonb_agg(k)
      FROM jsonb_array_elements_text(r.value) AS k
      WHERE k IN ('telemetry_table', 'telemetry_floorplan')
    ),
    '[]'::jsonb
  )
  || '["trend_gauges","trend_charts","trend_summary","trend_historian_table","trend_alarms"]'::jsonb,
  'migration:panel_access'
FROM "system_config" sc,
     jsonb_each(sc.config_value -> 'roles') AS r(key, value)
WHERE sc.config_key = 'dashboard-cards'
  AND jsonb_typeof(r.value) = 'array'
  AND NOT EXISTS (SELECT 1 FROM "role_configs" rc WHERE rc."role" = r.key);

-- The old system_config row is NOT deleted here. It is deleted in the retirement
-- task, after this carry-over has been verified against it — per
-- docs/CONTRIBUTING.md's pre-deletion rule.
