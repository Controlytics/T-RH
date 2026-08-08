-- Per-profile instrument attribute keys.
-- Spec: docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md

ALTER TABLE "instrument_profiles" ADD COLUMN "attribute_keys" TEXT;

-- Every existing profile starts as an exact copy of the list that was global
-- until now, so day-one behaviour is identical and a profile diverges only when
-- an admin edits it.
--
-- Reads the LIVE config row, NOT the code default: this install's list is 12
-- keys and INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT is 6, so seeding from the constant
-- would quietly reset every profile to a list nobody configured. The literal
-- below is only the fresh-install fallback, for a database where the config row
-- has not been seeded yet.
UPDATE "instrument_profiles"
SET "attribute_keys" = COALESCE(
  (SELECT c."config_value"->>'keys'
     FROM "system_config" c
    WHERE c."config_key" = 'instrument-attributes'),
  E'Block\nArea\nLocation\nRoom\nCalibration Due\nAsset Tag'
)
WHERE "attribute_keys" IS NULL;
