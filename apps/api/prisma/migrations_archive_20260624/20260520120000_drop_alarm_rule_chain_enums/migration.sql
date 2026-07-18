-- Drop unused alarm + rule-chain enum values from NotificationType and NotificationEventType.
--
-- The alarm + rule-chain subsystems were torn out on 2026-05-17 (Phase 6, see
-- tasks/REMOVE-RULECHAIN-ALARM-PLAN.md). The Notification* enum values for those
-- subsystems were retained at that time on caution; this delta-audit follow-up
-- confirms zero callers remain in apps/api/src (workers/notification.worker.ts
-- only references string-literal task-payload types, not enum values).
--
-- Values dropped:
--   NotificationType:      ALARM_CREATED, ALARM_ACKNOWLEDGED, ALARM_CLEARED, RULE_CHAIN_TRIGGERED
--   NotificationEventType: ALARM_CREATED, ALARM_ACKNOWLEDGED, ALARM_CLEARED, RULE_CHAIN_TRIGGERED
--
-- Postgres does not support DROP VALUE on enum types directly. Strategy:
--   1. Verify no row uses the values (any historic row WAS deleted with the alarm/rule-chain rows on 2026-05-17).
--   2. Recreate the enum without the values; cast usages over.
--
-- This migration is idempotent — guarded by IF EXISTS on every step. Safe on
-- a populated DB if and only if no surviving row references the dropped values
-- (verified at step 1; raises if not).

DO $$
DECLARE
  bad_nt INT;
  bad_net INT;
BEGIN
  -- Step 1: Pre-flight — verify no live row references the dropped values.
  SELECT COUNT(*) INTO bad_nt FROM notifications
    WHERE type::text IN ('ALARM_CREATED', 'ALARM_ACKNOWLEDGED', 'ALARM_CLEARED', 'RULE_CHAIN_TRIGGERED');
  SELECT COUNT(*) INTO bad_net FROM notification_rules
    WHERE 'ALARM_CREATED' = ANY(event_types::text[])
       OR 'ALARM_ACKNOWLEDGED' = ANY(event_types::text[])
       OR 'ALARM_CLEARED' = ANY(event_types::text[])
       OR 'RULE_CHAIN_TRIGGERED' = ANY(event_types::text[]);
  IF bad_nt > 0 OR bad_net > 0 THEN
    RAISE EXCEPTION 'Cannot drop enum values — % notification rows and % notification_rule rows still reference them. Investigate before re-running.', bad_nt, bad_net;
  END IF;
END $$;

-- Step 2: Recreate NotificationType without the four dropped values.
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
CREATE TYPE "NotificationType" AS ENUM (
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_ENABLED',
  'PASSWORD_RESET_REQUEST',
  'PASSWORD_RESET_APPROVED',
  'PASSWORD_RESET_REJECTED',
  'USER_CREATED',
  'USER_UPDATED',
  'ROLE_CHANGED',
  'USER_CREATION_REQUEST_SUBMITTED',
  'USER_CREATION_REQUEST_APPROVED',
  'USER_CREATION_REQUEST_REJECTED',
  'DEVICE_ONLINE',
  'DEVICE_OFFLINE',
  'DEVICE_INACTIVITY',
  'USER_LOGIN',
  'USER_LOCKED',
  'CHECKLIST_SUBMITTED',
  'CHECKLIST_APPROVED',
  'CHECKLIST_REJECTED',
  'SYSTEM_ERROR'
);
ALTER TABLE notifications ALTER COLUMN type TYPE "NotificationType" USING type::text::"NotificationType";
DROP TYPE "NotificationType_old";

-- Step 3: Recreate NotificationEventType without the four dropped values.
ALTER TYPE "NotificationEventType" RENAME TO "NotificationEventType_old";
CREATE TYPE "NotificationEventType" AS ENUM (
  'DEVICE_ONLINE',
  'DEVICE_OFFLINE',
  'DEVICE_INACTIVITY',
  'USER_LOGIN',
  'USER_CREATED',
  'USER_LOCKED',
  'CHECKLIST_SUBMITTED',
  'CHECKLIST_APPROVED',
  'CHECKLIST_REJECTED',
  'SYSTEM_ERROR'
);
-- notification_rules.event_types is the only column carrying this type.
ALTER TABLE notification_rules
  ALTER COLUMN event_types TYPE "NotificationEventType"[] USING event_types::text[]::"NotificationEventType"[];
DROP TYPE "NotificationEventType_old";
