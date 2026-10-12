-- In-app ALARM notifications (audit 2026-10-12, alarms follow-up).
--
-- Rule-driven in-app notifications are stored in `notifications.type`
-- (enum "NotificationType") under the EVENT TYPE that triggered them. The
-- notification-rule event types ALARM_RAISED / ALARM_CLEARED (enum
-- "NotificationEventType", 2026-08-14) were never added here, so every in-app
-- row for an alarm rule failed at insert — swallowed per recipient until
-- 2026-10-12, then skipped with a warning. This adds the two values the
-- dispatcher writes (`type: eventType`), spelled exactly as NotificationEventType
-- spells them.
--
-- HAND-AUTHORED. Its OWN migration on purpose: Postgres refuses to USE an enum
-- value in the transaction that added it, so nothing else goes in this file.
-- `prisma migrate diff` would also emit DROP TABLE "instrument_telemetry_history"
-- (partitioned, invisible to the datamodel) — stripped, as in every migration
-- since 2026-08-08; migration-guard.ts enforces it.
--
-- A new VALUE on an existing enum: no new enum, no new model.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ALARM_RAISED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ALARM_CLEARED';
