-- Retire the four spec-limit instrument attributes from the REGISTRATION PROMPTS.
--
-- Limits now live on floorplan_rooms: a cleanroom's specification belongs to the
-- room, not to whichever probe is bolted to its wall. Replacing a probe must not
-- discard the spec, and two probes in one room must not be able to assert two
-- different specs. See
-- docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md §3.
--
-- THIS MIGRATION DESTROYS NO OPERATOR DATA. It edits only
-- `instrument_profiles.attribute_keys`, which is the list of fields the New
-- Instrument form ASKS FOR — a prompt, not a record. Existing
-- `instrument_attributes` rows are left exactly as they are.
--
-- Moving those recorded VALUES onto rooms, and deleting the rows once moved, is
-- a separate, explicitly-run, audited step:
--     npx tsx scripts/retire-limit-attributes.ts --apply
-- It is not done here because a value deletion is a 21 CFR §11 record change and
-- must carry an attributable audit entry, which raw SQL in a migration cannot
-- write (the audit trail is a hash chain computed in application code).
--
-- The `* Range` keys are deliberately NOT touched: those describe the DEVICE's
-- measurement capability, which genuinely is a per-instrument fact and is not
-- what colours a room.

UPDATE instrument_profiles
SET attribute_keys = COALESCE((
  SELECT string_agg(line, E'\n' ORDER BY ord)
  FROM unnest(string_to_array(attribute_keys, E'\n')) WITH ORDINALITY AS t(line, ord)
  WHERE btrim(line) NOT IN (
    'Low Temperature Limit', 'High Temperature Limit',
    'Low Humidity Limit', 'High Humidity Limit'
  )
), '')
WHERE attribute_keys IS NOT NULL
  AND attribute_keys ~ '(Low|High) (Temperature|Humidity) Limit';
