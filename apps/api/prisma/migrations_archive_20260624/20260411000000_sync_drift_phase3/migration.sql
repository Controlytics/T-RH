-- =============================================================================
-- Sync drift — Phase 3
-- =============================================================================
-- This migration captures all schema changes that had drifted between
-- prisma/migrations and the live schema.prisma. It was generated via
-- `prisma migrate diff --from-migrations ... --to-schema-datamodel ...` and
-- then hand-patched so the two destructive DROP/RECREATE column operations
-- are replaced with data-preserving ALTER ... USING casts.
--
-- Safe to run on a populated DB as long as:
--   * Existing values in password_reset_requests.user_id are valid UUIDs
--     (they should be — the column was only ever written with JWT user ids).
--   * Existing values in checklist_reviews.checklist_id do not exceed 255 chars.
--   * All FK columns already point at valid rows (otherwise AddForeignKey fails).
-- If any of these are violated the migration will ABORT cleanly — no partial
-- writes, no silent data loss.
-- =============================================================================

-- CreateEnum
CREATE TYPE "cleaning_profile_status" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "block_change_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "filter_event_type" ADD VALUE 'CYCLE_TERMINATED';

-- AlterTable: widen checklist_reviews.checklist_id from text to varchar(255)
ALTER TABLE "checklist_reviews" ALTER COLUMN "checklist_id" SET DATA TYPE VARCHAR(255);

-- AlterTable: add nullable dryer tracking columns
ALTER TABLE "cleaning_cycles"
    ADD COLUMN "dryer_duration_minutes" INTEGER,
    ADD COLUMN "dryer_started_at" TIMESTAMPTZ;

-- AlterTable: convert filter_cleaning_profiles.status from pm_schedule_status
-- enum to cleaning_profile_status enum. Both enums have identical values
-- (DRAFT, ACTIVE, ARCHIVED) so the cast via text is lossless.
ALTER TABLE "filter_cleaning_profiles" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "filter_cleaning_profiles"
    ALTER COLUMN "status" TYPE "cleaning_profile_status"
    USING "status"::text::"cleaning_profile_status";
ALTER TABLE "filter_cleaning_profiles" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- AlterTable: convert password_reset_requests.user_id from VARCHAR(50) to UUID.
-- Uses a USING cast so existing rows are preserved. Fails if any value is not
-- a valid UUID — that is the correct safety behavior.
ALTER TABLE "password_reset_requests"
    ALTER COLUMN "user_id" TYPE UUID USING "user_id"::uuid;

-- CreateTable
CREATE TABLE "block_change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "filter_id" UUID NOT NULL,
    "filter_name" VARCHAR(255) NOT NULL,
    "from_block_id" UUID NOT NULL,
    "from_block_name" VARCHAR(255) NOT NULL,
    "to_block_id" UUID NOT NULL,
    "to_block_name" VARCHAR(255) NOT NULL,
    "reason" TEXT,
    "status" "block_change_status" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "requested_by_name" VARCHAR(255) NOT NULL,
    "processed_by" UUID,
    "processed_by_name" VARCHAR(255),
    "processed_comment" TEXT,
    "processed_at" TIMESTAMPTZ,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "block_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "block_change_requests_filter_id_to_block_id_status_idx" ON "block_change_requests"("filter_id", "to_block_id", "status");

-- CreateIndex
CREATE INDEX "block_change_requests_status_organization_id_idx" ON "block_change_requests"("status", "organization_id");

-- CreateIndex
CREATE INDEX "block_change_requests_requested_by_idx" ON "block_change_requests"("requested_by");

-- CreateIndex
CREATE INDEX "asset_instances_organization_id_current_lifecycle_state_idx" ON "asset_instances"("organization_id", "current_lifecycle_state");

-- CreateIndex
CREATE INDEX "audit_trail_user_id_timestamp_idx" ON "audit_trail"("user_id", "timestamp" DESC);

-- (filter_cleaning_profiles_organization_id_status_idx is already created by
-- 20260327133758_sync_schema and preserved by our ALTER COLUMN TYPE above, so
-- we do NOT recreate it here — unlike Prisma's default DROP/ADD plan which
-- would have dropped and recreated it.)

-- CreateIndex
CREATE INDEX "notifications_for_user_id_is_read_created_at_idx" ON "notifications"("for_user_id", "is_read", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- AddForeignKey
ALTER TABLE "asset_instances" ADD CONSTRAINT "asset_instances_filter_profile_id_fkey" FOREIGN KEY ("filter_profile_id") REFERENCES "filter_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_instances" ADD CONSTRAINT "asset_instances_current_cycle_id_fkey" FOREIGN KEY ("current_cycle_id") REFERENCES "cleaning_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_profiles" ADD CONSTRAINT "filter_profiles_cleaning_profile_id_fkey" FOREIGN KEY ("cleaning_profile_id") REFERENCES "filter_cleaning_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_profiles" ADD CONSTRAINT "filter_profiles_default_pm_schedule_id_fkey" FOREIGN KEY ("default_pm_schedule_id") REFERENCES "pm_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_cycles" ADD CONSTRAINT "cleaning_cycles_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "filter_cleaning_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
