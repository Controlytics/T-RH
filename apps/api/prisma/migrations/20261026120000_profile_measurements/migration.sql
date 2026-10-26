-- Profile measurements (2026-10-26).
-- Spec: docs/superpowers/specs/2026-10-26-profile-measurements-design.md
--
-- Every key mapping that was GLOBAL (system_config rows `telemetry-slots`,
-- `alarm-limits`, `sensor-range-alarms`, `sensor-offsets`) moves onto each
-- instrument profile as `measurements`, plus the measurement-type registry.
--
-- HAND-AUTHORED. `prisma migrate diff` also emitted DROP TABLE
-- "instrument_telemetry_history" (partitioned, invisible to the datamodel),
-- DROP TABLE "audit_chain_counter", ALTER "audit_trail"."chain_position" DROP
-- NOT NULL, a DROP INDEX on notification_rule_recipients and a drop/re-add of
-- the instrument_credentials FK — all out-of-band noise, all STRIPPED.

ALTER TABLE "instrument_profiles" ADD COLUMN "measurements" JSONB;

CREATE TABLE "measurement_types" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "measurement_types_pkey" PRIMARY KEY ("code")
);

INSERT INTO "measurement_types" ("code", "name", "unit", "sort_order", "updated_at") VALUES
  ('TEMPERATURE', 'Temperature', '°C', 1, CURRENT_TIMESTAMP),
  ('HUMIDITY', 'Humidity', '%RH', 2, CURRENT_TIMESTAMP);

-- ─── Backfill ────────────────────────────────────────────────────────────────
--
-- Every existing profile gets TEMPERATURE + HUMIDITY built from THIS install's
-- own config rows, read EXACTLY the way the loaders read them until today, so
-- not one instrument changes on the day this ships (spec G4):
--   * a list setting that is absent (or not a string) → the shipped default the
--     loader fell back to (the literals below are those constants verbatim);
--   * a list setting present → split on newlines, trimmed, blanks dropped — an
--     empty list when it was blank, as the loaders read it;
--   * EXCEPT the offset keys, where `coerceSensorOffsetConfig` read a blank list
--     as the default too (blank_is_default = true);
--   * decimals fallback: the number when it is one, clamped 0..10, else 1.
-- NMT / NLT switches start ON (enforcement was decided only per instrument);
-- MKT: temperature asks `isMktCalculationEnabled` (the one fixed key it always
-- read), humidity never had MKT.
--
-- `pg_temp` functions live for this session only — nothing persists, so there
-- is no raw object to mirror into prisma/sql/*.
--
-- Review-focus check (2026-10-26): run against a scratch database holding one
-- profile and NONE of the four config rows, every list came out equal to the
-- shipped default and non-empty — recorded in the plan ledger.

CREATE FUNCTION pg_temp.mm_keys(cfg jsonb, k text, dflt text, blank_is_default boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(btrim(t.x) ORDER BY t.n), '[]'::jsonb)
  FROM regexp_split_to_table(
         CASE
           WHEN cfg IS NULL OR jsonb_typeof(cfg -> k) IS DISTINCT FROM 'string' THEN dflt
           WHEN blank_is_default AND btrim(cfg ->> k) = '' THEN dflt
           ELSE cfg ->> k
         END,
         E'\n') WITH ORDINALITY AS t(x, n)
  WHERE btrim(t.x) <> ''
$$;

CREATE FUNCTION pg_temp.mm_decimals(cfg jsonb, k text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN cfg IS NOT NULL AND jsonb_typeof(cfg -> k) = 'number'
      THEN LEAST(GREATEST(trunc((cfg ->> k)::numeric), 0), 10)::int
    ELSE 1
  END
$$;

WITH c AS (
  SELECT
    (SELECT "config_value" FROM "system_config" WHERE "config_key" = 'telemetry-slots')     AS ts,
    (SELECT "config_value" FROM "system_config" WHERE "config_key" = 'alarm-limits')        AS al,
    (SELECT "config_value" FROM "system_config" WHERE "config_key" = 'sensor-range-alarms') AS sr,
    (SELECT "config_value" FROM "system_config" WHERE "config_key" = 'sensor-offsets')      AS so
)
UPDATE "instrument_profiles"
SET "measurements" = (
  SELECT jsonb_build_array(
    jsonb_build_object(
      'code', 'TEMPERATURE',
      'deviceKeys', pg_temp.mm_keys(c.ts, 'temperatureKeys', E'temperature\ntemp\nt', false),
      'decimals', jsonb_build_object(
        'attributeKeys', pg_temp.mm_keys(c.ts, 'temperatureDecimalsKeys', 'temp_decimals', false),
        'fallback', pg_temp.mm_decimals(c.ts, 'temperatureDecimals')),
      'high', jsonb_build_object(
        'enabled', true,
        'limitKeys', pg_temp.mm_keys(c.al, 'temperatureHighKeys', E'High Temperature Limit\nHigh Temperature\nTemp High', false),
        'enableKeys', pg_temp.mm_keys(c.al, 'temperatureHighEnableKeys', 'Enable_Temp_NMT', false)),
      'low', jsonb_build_object(
        'enabled', true,
        'limitKeys', pg_temp.mm_keys(c.al, 'temperatureLowKeys', E'Low Temperature Limit\nLow Temperature\nTemp Low', false),
        'enableKeys', pg_temp.mm_keys(c.al, 'temperatureLowEnableKeys', 'Enable_Temp_NLT', false)),
      'range', jsonb_build_object(
        'highKeys', pg_temp.mm_keys(c.sr, 'temperatureHighKeys', 'High Temperature Range', false),
        'lowKeys', pg_temp.mm_keys(c.sr, 'temperatureLowKeys', 'Low Temperature Range', false)),
      'offsetKeys', pg_temp.mm_keys(c.so, 'temperatureKeys', 'Temp Off set', true),
      'mkt', jsonb_build_object('enabled', true, 'attributeKeys', jsonb_build_array('isMktCalculationEnabled'))
    ),
    jsonb_build_object(
      'code', 'HUMIDITY',
      'deviceKeys', pg_temp.mm_keys(c.ts, 'humidityKeys', E'humidity\nrh\nhum', false),
      'decimals', jsonb_build_object(
        'attributeKeys', pg_temp.mm_keys(c.ts, 'humidityDecimalsKeys', 'humid_decimals', false),
        'fallback', pg_temp.mm_decimals(c.ts, 'humidityDecimals')),
      'high', jsonb_build_object(
        'enabled', true,
        'limitKeys', pg_temp.mm_keys(c.al, 'humidityHighKeys', E'High Humidity Limit\nHigh Humidity\nRH High', false),
        'enableKeys', pg_temp.mm_keys(c.al, 'humidityHighEnableKeys', 'Enable_Humid_NMT', false)),
      'low', jsonb_build_object(
        'enabled', true,
        'limitKeys', pg_temp.mm_keys(c.al, 'humidityLowKeys', E'Low Humidity Limit\nLow Humidity\nRH Low', false),
        'enableKeys', pg_temp.mm_keys(c.al, 'humidityLowEnableKeys', 'Enable_Humid_NLT', false)),
      'range', jsonb_build_object(
        'highKeys', pg_temp.mm_keys(c.sr, 'humidityHighKeys', 'High Humidity Range', false),
        'lowKeys', pg_temp.mm_keys(c.sr, 'humidityLowKeys', 'Low Humidity Range', false)),
      'offsetKeys', pg_temp.mm_keys(c.so, 'humidityKeys', 'Humid Off set', true),
      'mkt', jsonb_build_object('enabled', false, 'attributeKeys', '[]'::jsonb)
    )
  )
  FROM c
)
WHERE "measurements" IS NULL;
