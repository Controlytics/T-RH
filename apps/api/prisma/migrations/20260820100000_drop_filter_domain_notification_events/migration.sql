-- Drop the filter-domain values from the two notification enums.
--
-- NotificationType loses 10 values (the three CHECKLIST_*, the two PM_OVERDUE_*,
-- PM_SCHEDULE_QNN, GUEST_CLEANING_REQUEST and the three STAGE_APPROVAL_* of the
-- cleaning-stage interlock); NotificationEventType loses the three CHECKLIST_*.
-- Every emitter went with the Phase 0 domain strip; the last consumers (the
-- dispatcher's subject/body/summary tables, the notification-rules catalog and
-- the QNN / guest-request visibility gates) are removed in the same commit.
--
-- Verified zero rows carry any doomed value, in BOTH databases, before writing:
--   SELECT count(*) FROM notifications WHERE type::text IN (...)            -> 0
--   SELECT count(*) FROM notification_rules WHERE event_type::text LIKE
--     'CHECKLIST%' OR EXISTS (SELECT 1 FROM unnest(event_types) e
--     WHERE e::text LIKE 'CHECKLIST%')                                      -> 0
--
-- HAND-AUTHORED from `prisma migrate diff`, with the SAME three statements
-- stripped that every migration in this repo has to strip. See the header of
-- 20260811120000_instrument_floorplans/migration.sql for the full reasoning:
--   1. DROP TABLE "instrument_telemetry_history" — a PARTITIONED table Prisma
--      cannot express and therefore reads as stray. It holds every reading.
--   2. ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL —
--      the 21 CFR §11 hash chain's position, backed by a manual sequence.
--   3. DROP/ADD of instrument_credentials_instrument_id_fkey — unchanged
--      constraint re-emitted as churn; the round trip takes a lock for nothing.
--
-- The `event_types` ARRAY column is why the DEFAULT is dropped before the cast
-- and re-set after: its udt is `_NotificationEventType`, so a search for columns
-- of type `NotificationEventType` misses it and the cast fails mid-transaction.

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationEventType_new" AS ENUM ('DEVICE_ONLINE', 'DEVICE_OFFLINE', 'DEVICE_INACTIVITY', 'USER_LOGIN', 'USER_CREATED', 'USER_LOCKED', 'SYSTEM_ERROR', 'ALARM_RAISED', 'ALARM_CLEARED');
ALTER TABLE "public"."notification_rules" ALTER COLUMN "event_types" DROP DEFAULT;
ALTER TABLE "notification_rules" ALTER COLUMN "event_type" TYPE "NotificationEventType_new" USING ("event_type"::text::"NotificationEventType_new");
ALTER TABLE "notification_rules" ALTER COLUMN "event_types" TYPE "NotificationEventType_new"[] USING ("event_types"::text::"NotificationEventType_new"[]);
ALTER TYPE "NotificationEventType" RENAME TO "NotificationEventType_old";
ALTER TYPE "NotificationEventType_new" RENAME TO "NotificationEventType";
DROP TYPE "public"."NotificationEventType_old";
ALTER TABLE "notification_rules" ALTER COLUMN "event_types" SET DEFAULT ARRAY[]::"NotificationEventType"[];
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('ACCOUNT_LOCKED', 'ACCOUNT_DISABLED', 'ACCOUNT_ENABLED', 'PASSWORD_RESET_REQUEST', 'PASSWORD_RESET_APPROVED', 'PASSWORD_RESET_REJECTED', 'USER_CREATED', 'USER_UPDATED', 'ROLE_CHANGED', 'USER_CREATION_REQUEST_SUBMITTED', 'USER_CREATION_REQUEST_APPROVED', 'USER_CREATION_REQUEST_REJECTED', 'DEVICE_ONLINE', 'DEVICE_OFFLINE', 'DEVICE_INACTIVITY', 'USER_LOGIN', 'USER_LOCKED', 'SYSTEM_ERROR', 'REPORT_REVIEW_REQUESTED', 'REPORT_REVIEW_APPROVED', 'REPORT_REVIEW_REJECTED', 'PASSWORD_EXPIRY_WARNING', 'PASSWORD_EXPIRED_NOTICE');
ALTER TABLE "notifications" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "public"."NotificationType_old";
COMMIT;
