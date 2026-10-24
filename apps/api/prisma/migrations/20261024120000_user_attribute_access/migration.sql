-- Per-USER instrument attribute access (2026-10-24). Combined with the role's
-- rule by `effectiveAttributeAccess` (@digilog/shared): the user may change a
-- key if either rule allows it. NULL = no user rule. Nullable with NO default,
-- so adding it changes nobody's access.
-- HAND-AUTHORED; any DROP TABLE "instrument_telemetry_history" prisma emits is
-- stripped, as in every migration since 2026-08-08.
ALTER TABLE "user_configs" ADD COLUMN "attribute_access" JSONB;
