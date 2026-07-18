-- Cleanse stale runtime rows that still reference deleted rule-chain / alarm artifacts.
-- Generated 2026-05-17 by Phase 6 of tasks/REMOVE-RULECHAIN-ALARM-PLAN.md
-- Pre-phase counts (Phase 0.5):
--   roles with stale perms: 3
--   role_configs with stale sidebar items: 1
--   system_config rows: 1

BEGIN;

-- 1. Strip ALARM_*/RULE_CHAIN_* strings from roles.permissions JSONB arrays
UPDATE roles
SET permissions = COALESCE((
  SELECT jsonb_agg(p)
  FROM jsonb_array_elements_text(permissions) p
  WHERE p !~ '^(ALARM_|RULE_CHAIN_)'
), '[]'::jsonb)
WHERE permissions::text ~ '(ALARM_|RULE_CHAIN_)';

-- 2. Strip 'alarms' + 'rule-chains' from role_configs.sidebar_items JSONB arrays
UPDATE role_configs
SET sidebar_items = COALESCE((
  SELECT jsonb_agg(s)
  FROM jsonb_array_elements_text(sidebar_items) s
  WHERE s NOT IN ('alarms', 'rule-chains')
), '[]'::jsonb)
WHERE sidebar_items::text ~ '(alarms|rule-chains)';

-- 3. Delete the orphaned alarm-columns system_config row(s)
DELETE FROM system_config
WHERE config_key ILIKE 'alarm%' OR config_key ILIKE '%.alarm%';

-- Note: audit_trail rows with inert UUID strings in before_value/after_value JSON
-- are RETAINED per 21 CFR §11 user direction (hard-delete accepted; UUIDs orphan but
-- the hash-chained audit record stays intact).

COMMIT;
