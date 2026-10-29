-- WIDGET DATA KEYS, phase 3 (2026-10-29): the trend page's extra keys, per profile.
-- Spec: docs/superpowers/specs/2026-10-28-widget-data-keys-design.md §7
--
-- Hand-authored. One nullable JSONB column, no data change: NULL reads as "no extra
-- keys" (coerceProfileDisplayKeys), so every existing profile and trend page is
-- exactly as before.
--
-- Nothing else: no DROP of the partitioned instrument_telemetry_history (Prisma
-- cannot see it), no audit-chain or FK noise.

ALTER TABLE "instrument_profiles" ADD COLUMN "display_keys" JSONB;
