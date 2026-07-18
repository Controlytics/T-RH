-- Migration: Remove rule_chains, rule_nodes, rule_chain_versions, rule_node_connections, alarms
-- Plus drop FK + JSONB columns on asset_templates and notification_logs that referenced them.
--
-- Created 2026-05-17 per tasks/REMOVE-RULECHAIN-ALARM-PLAN.md
-- User accepted hard-delete (no archive) on 2026-05-17. Phase 0.5 of the plan
-- verified no external FKs point at these tables and that audit_trail's hash
-- chain is unaffected (only 4 historic rows hold inert UUID strings in JSON
-- details — those rows are retained; the UUIDs become orphan references).
--
-- This migration is irreversible. The pre-removal state is tagged in git as
-- `pre-rulechain-alarm-drop` for source-side rollback.

-- 1. Drop FKs that point at the tables we're removing
ALTER TABLE "asset_templates" DROP CONSTRAINT IF EXISTS "asset_templates_default_rule_chain_id_fkey";

-- 2. Drop columns on retained tables
ALTER TABLE "asset_templates" DROP COLUMN IF EXISTS "default_rule_chain_id";
ALTER TABLE "asset_templates" DROP COLUMN IF EXISTS "alarm_rules";

DROP INDEX IF EXISTS "notification_logs_rule_chain_id_idx";
DROP INDEX IF EXISTS "notification_logs_alarm_id_idx";
ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "rule_chain_id";
ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "alarm_id";

-- 3. Drop tables in FK-dependency order (children first)
DROP TABLE IF EXISTS "rule_node_connections" CASCADE;
DROP TABLE IF EXISTS "rule_nodes" CASCADE;
DROP TABLE IF EXISTS "rule_chain_versions" CASCADE;
DROP TABLE IF EXISTS "alarms" CASCADE;
DROP TABLE IF EXISTS "rule_chains" CASCADE;
