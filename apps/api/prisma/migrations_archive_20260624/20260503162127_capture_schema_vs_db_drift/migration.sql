-- =============================================================================
-- Migration: capture_schema_vs_db_drift
-- Generated: 2026-05-03 (Phase 8.7 cutover preparation, agent C)
--
-- Purpose: Captures the schema-vs-migration drift introduced via
--          `prisma db push` between roughly 2026-04-XX and 2026-05-02.
--          Closes "Kind B" drift inventoried in
--          tasks/MIGRATION-DRIFT-2026-05-02.md § 3.
--
-- Source : `prisma migrate diff --from-migrations apps/api/prisma/migrations
--          --to-schema-datamodel apps/api/prisma/schema.prisma --script`
--          run against a transient shadow Postgres DB.
--
-- WARNING: Safe to apply ONLY against a fresh DB, OR after running
--          `prisma migrate resolve --applied 20260503162127_capture_schema_vs_db_drift`
--          on environments that already have the tables via `db push`.
--          Applying against a populated DB will fail on at least:
--            - filter_cleaning_profiles.lineage_id NOT NULL (no default backfill)
--            - asset_instances column drops (no migration of data into
--              filter_details sidecar)
--          The audit's § 5 / § 6 recommendation calls for hand-edits before
--          any deploy to a populated DB.
--
-- DO NOT amend without re-running `prisma migrate diff` and confirming the
-- result is empty (or only header comments).
-- =============================================================================

-- CreateEnum
CREATE TYPE "relationship_type_enum" AS ENUM ('CONTAINS', 'CONTAINED_IN', 'CONNECTED_TO', 'FEEDS', 'FED_BY', 'DEPENDS_ON', 'DEPENDED_ON_BY', 'BACKS_UP', 'BACKED_UP_BY', 'MONITORS', 'MONITORED_BY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "pm_entry_approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReportTemplateStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DRAFT');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED', 'EXPIRED');

-- AlterEnum
BEGIN;
CREATE TYPE "AssigneeType_new" AS ENUM ('USER', 'ROLE');
ALTER TABLE "template_assignments" ALTER COLUMN "assignee_type" TYPE "AssigneeType_new" USING ("assignee_type"::text::"AssigneeType_new");
ALTER TABLE "entity_assignments" ALTER COLUMN "assignee_type" TYPE "AssigneeType_new" USING ("assignee_type"::text::"AssigneeType_new");
ALTER TABLE "dashboard_assignments" ALTER COLUMN "assignee_type" TYPE "AssigneeType_new" USING ("assignee_type"::text::"AssigneeType_new");
ALTER TYPE "AssigneeType" RENAME TO "AssigneeType_old";
ALTER TYPE "AssigneeType_new" RENAME TO "AssigneeType";
DROP TYPE "public"."AssigneeType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "RoleScope_new" AS ENUM ('GLOBAL');
ALTER TABLE "public"."roles" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TABLE "roles" ALTER COLUMN "scope" TYPE "RoleScope_new" USING ("scope"::text::"RoleScope_new");
ALTER TYPE "RoleScope" RENAME TO "RoleScope_old";
ALTER TYPE "RoleScope_new" RENAME TO "RoleScope";
DROP TYPE "public"."RoleScope_old";
ALTER TABLE "roles" ALTER COLUMN "scope" SET DEFAULT 'GLOBAL';
COMMIT;

-- DropForeignKey
ALTER TABLE "asset_instances" DROP CONSTRAINT "asset_instances_current_cycle_id_fkey";

-- DropForeignKey
ALTER TABLE "asset_instances" DROP CONSTRAINT "asset_instances_filter_profile_id_fkey";

-- DropForeignKey
ALTER TABLE "entity_assignments" DROP CONSTRAINT "entity_assignments_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_parent_org_id_fkey";

-- DropForeignKey
ALTER TABLE "template_assignments" DROP CONSTRAINT "template_assignments_organization_id_fkey";

-- DropIndex
DROP INDEX "asset_instances_organization_id_current_lifecycle_state_idx";

-- DropIndex
DROP INDEX "block_change_requests_status_organization_id_idx";

-- DropIndex
DROP INDEX "checklist_profiles_organization_id_is_active_idx";

-- DropIndex
DROP INDEX "dashboard_assignments_organization_id_idx";

-- DropIndex
DROP INDEX "entity_assignments_organization_id_idx";

-- DropIndex
DROP INDEX "equipment_groups_organization_id_is_active_idx";

-- DropIndex
DROP INDEX "filter_cleaning_profiles_organization_id_status_idx";

-- DropIndex
DROP INDEX "filter_profiles_organization_id_is_active_idx";

-- DropIndex
DROP INDEX "template_assignments_organization_id_idx";

-- DropIndex
DROP INDEX "users_organization_id_idx";

-- AlterTable
ALTER TABLE "asset_instances" DROP COLUMN "current_cycle_id",
DROP COLUMN "current_lifecycle_state",
DROP COLUMN "filter_profile_id",
DROP COLUMN "filter_set",
DROP COLUMN "organization_id";

-- AlterTable
ALTER TABLE "asset_relationships" DROP COLUMN "relationship_type",
ADD COLUMN     "relationship_type" "relationship_type_enum" NOT NULL;

-- AlterTable
ALTER TABLE "asset_templates" DROP COLUMN "organization_id",
ADD COLUMN     "template_kind" VARCHAR(50) NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "block_change_requests" DROP COLUMN "organization_id";

-- AlterTable
ALTER TABLE "checklist_profiles" DROP COLUMN "organization_id",
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "cleaning_cycles" ADD COLUMN     "checklist_version_pins" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "dryer_readings_submitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "equipment_group_version_pin" INTEGER;

-- AlterTable
ALTER TABLE "dashboard_assignments" DROP COLUMN "organization_id";

-- AlterTable
ALTER TABLE "entity_assignments" DROP COLUMN "organization_id";

-- AlterTable
ALTER TABLE "equipment_groups" DROP COLUMN "organization_id",
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "filter_cleaning_profiles" DROP COLUMN "organization_id",
ADD COLUMN     "lineage_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "filter_profiles" DROP COLUMN "applicable_templates",
DROP COLUMN "organization_id",
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "pm_schedule_entries" ADD COLUMN     "approval_remarks" TEXT,
ADD COLUMN     "approval_status" "pm_entry_approval_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "approved_at" TIMESTAMPTZ,
ADD COLUMN     "approved_by" UUID,
ADD COLUMN     "approved_by_name" VARCHAR(255),
ADD COLUMN     "pending_edit_at" TIMESTAMPTZ,
ADD COLUMN     "pending_edit_by" UUID,
ADD COLUMN     "pending_planned_date" DATE,
ADD COLUMN     "pending_tolerance_days" INTEGER,
ADD COLUMN     "submitted_by" UUID,
ADD COLUMN     "submitted_by_name" VARCHAR(255);

-- AlterTable
ALTER TABLE "roles" ALTER COLUMN "scope" SET DEFAULT 'GLOBAL';

-- AlterTable
ALTER TABLE "template_assignments" DROP COLUMN "organization_id";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "organization_id";

-- DropTable
DROP TABLE "organizations";

-- CreateTable
CREATE TABLE "template_kinds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),
    "updated_by" VARCHAR(50),

    CONSTRAINT "template_kinds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_details" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "asset_instance_id" UUID NOT NULL,
    "filter_profile_id" UUID,
    "current_lifecycle_state" VARCHAR(100),
    "current_cycle_id" UUID,
    "filter_set" "filter_set_label",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "filter_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_profile_applicable_templates" (
    "profile_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "filter_profile_applicable_templates_pkey" PRIMARY KEY ("profile_id","template_id")
);

-- CreateTable
CREATE TABLE "filter_profile_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "change_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "filter_profile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_group_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "change_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "equipment_group_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_profile_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "change_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "checklist_profile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "status" "ReportTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_template_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "changelog" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "name" VARCHAR(500) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "time_range_start" TIMESTAMPTZ,
    "time_range_end" TIMESTAMPTZ,
    "entity_slots" JSONB,
    "resolved_data" JSONB,
    "pdf_path" VARCHAR(1000),
    "pdf_size" INTEGER,
    "page_count" INTEGER,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "report_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_signatures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "signer_role" VARCHAR(50) NOT NULL,
    "signer_label" VARCHAR(100) NOT NULL,
    "user_id" UUID NOT NULL,
    "meaning" VARCHAR(500) NOT NULL,
    "signed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),

    CONSTRAINT "report_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_kinds_code_key" ON "template_kinds"("code");

-- CreateIndex
CREATE INDEX "template_kinds_is_active_sort_order_idx" ON "template_kinds"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "filter_details_asset_instance_id_key" ON "filter_details"("asset_instance_id");

-- CreateIndex
CREATE INDEX "filter_details_current_lifecycle_state_idx" ON "filter_details"("current_lifecycle_state");

-- CreateIndex
CREATE INDEX "filter_details_current_cycle_id_idx" ON "filter_details"("current_cycle_id");

-- CreateIndex
CREATE INDEX "filter_details_filter_profile_id_idx" ON "filter_details"("filter_profile_id");

-- CreateIndex
CREATE INDEX "filter_profile_applicable_templates_template_id_idx" ON "filter_profile_applicable_templates"("template_id");

-- CreateIndex
CREATE INDEX "filter_profile_versions_profile_id_idx" ON "filter_profile_versions"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "filter_profile_versions_profile_id_version_number_key" ON "filter_profile_versions"("profile_id", "version_number");

-- CreateIndex
CREATE INDEX "equipment_group_versions_group_id_idx" ON "equipment_group_versions"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_group_versions_group_id_version_number_key" ON "equipment_group_versions"("group_id", "version_number");

-- CreateIndex
CREATE INDEX "checklist_profile_versions_profile_id_idx" ON "checklist_profile_versions"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_profile_versions_profile_id_version_number_key" ON "checklist_profile_versions"("profile_id", "version_number");

-- CreateIndex
CREATE INDEX "report_templates_status_idx" ON "report_templates"("status");

-- CreateIndex
CREATE INDEX "report_template_versions_template_id_idx" ON "report_template_versions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_template_versions_template_id_version_key" ON "report_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "report_instances_template_id_idx" ON "report_instances"("template_id");

-- CreateIndex
CREATE INDEX "report_instances_status_idx" ON "report_instances"("status");

-- CreateIndex
CREATE INDEX "report_instances_generated_at_idx" ON "report_instances"("generated_at");

-- CreateIndex
CREATE INDEX "report_signatures_report_id_idx" ON "report_signatures"("report_id");

-- CreateIndex
CREATE INDEX "report_signatures_user_id_idx" ON "report_signatures"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_signatures_report_id_signer_role_key" ON "report_signatures"("report_id", "signer_role");

-- CreateIndex
CREATE INDEX "asset_relationships_relationship_type_idx" ON "asset_relationships"("relationship_type");

-- CreateIndex
CREATE UNIQUE INDEX "asset_relationships_source_asset_id_target_asset_id_relatio_key" ON "asset_relationships"("source_asset_id", "target_asset_id", "relationship_type");

-- CreateIndex
CREATE INDEX "asset_templates_template_kind_idx" ON "asset_templates"("template_kind");

-- CreateIndex
CREATE INDEX "block_change_requests_status_idx" ON "block_change_requests"("status");

-- CreateIndex
CREATE INDEX "checklist_profiles_is_active_idx" ON "checklist_profiles"("is_active");

-- CreateIndex
CREATE INDEX "equipment_groups_is_active_idx" ON "equipment_groups"("is_active");

-- CreateIndex
CREATE INDEX "filter_cleaning_profiles_status_idx" ON "filter_cleaning_profiles"("status");

-- CreateIndex
CREATE INDEX "filter_cleaning_profiles_lineage_id_idx" ON "filter_cleaning_profiles"("lineage_id");

-- CreateIndex
CREATE UNIQUE INDEX "filter_cleaning_profiles_lineage_id_version_key" ON "filter_cleaning_profiles"("lineage_id", "version");

-- CreateIndex
CREATE INDEX "filter_profiles_is_active_idx" ON "filter_profiles"("is_active");

-- CreateIndex
CREATE INDEX "pm_schedule_entries_approval_status_idx" ON "pm_schedule_entries"("approval_status");

-- AddForeignKey
ALTER TABLE "asset_templates" ADD CONSTRAINT "asset_templates_template_kind_fkey" FOREIGN KEY ("template_kind") REFERENCES "template_kinds"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_details" ADD CONSTRAINT "filter_details_asset_instance_id_fkey" FOREIGN KEY ("asset_instance_id") REFERENCES "asset_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_details" ADD CONSTRAINT "filter_details_filter_profile_id_fkey" FOREIGN KEY ("filter_profile_id") REFERENCES "filter_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_details" ADD CONSTRAINT "filter_details_current_cycle_id_fkey" FOREIGN KEY ("current_cycle_id") REFERENCES "cleaning_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_profile_applicable_templates" ADD CONSTRAINT "filter_profile_applicable_templates_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "filter_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_profile_applicable_templates" ADD CONSTRAINT "filter_profile_applicable_templates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "asset_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_profile_versions" ADD CONSTRAINT "filter_profile_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "filter_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_group_versions" ADD CONSTRAINT "equipment_group_versions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "equipment_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_profile_versions" ADD CONSTRAINT "checklist_profile_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "checklist_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template_versions" ADD CONSTRAINT "report_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template_versions" ADD CONSTRAINT "report_template_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_instances" ADD CONSTRAINT "report_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_instances" ADD CONSTRAINT "report_instances_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_signatures" ADD CONSTRAINT "report_signatures_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "report_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_signatures" ADD CONSTRAINT "report_signatures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

