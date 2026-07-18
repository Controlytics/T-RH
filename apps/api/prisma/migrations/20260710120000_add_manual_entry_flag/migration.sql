-- Manual-entry marker for records inserted via the SUPER_ADMIN Filter Data
-- Management "Create" tool (back-/future-dated rows). Drives a "Manual entry"
-- badge so they are visually distinguishable from natively-captured records.
-- NOT NULL DEFAULT false → every existing row is (correctly) a native record.

ALTER TABLE "cleaning_cycles"       ADD COLUMN "manual_entry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "filter_events"         ADD COLUMN "manual_entry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pm_schedule_entries"   ADD COLUMN "manual_entry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notifications"         ADD COLUMN "manual_entry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "admin_requests"        ADD COLUMN "manual_entry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "block_change_requests" ADD COLUMN "manual_entry" BOOLEAN NOT NULL DEFAULT false;
