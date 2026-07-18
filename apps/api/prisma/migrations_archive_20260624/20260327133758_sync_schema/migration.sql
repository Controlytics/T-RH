/*
  Warnings:

  - The primary key for the `audit_trail` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `audit_trail` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('GLOBAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "DashboardScope" AS ENUM ('TENANT', 'ORGANIZATION', 'USER');

-- CreateEnum
CREATE TYPE "AssigneeType" AS ENUM ('USER', 'ORGANIZATION', 'ROLE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'IN_APP', 'TELEGRAM', 'WHATSAPP', 'SLACK');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('ALARM_CREATED', 'ALARM_ACKNOWLEDGED', 'ALARM_CLEARED', 'DEVICE_ONLINE', 'DEVICE_OFFLINE', 'DEVICE_INACTIVITY', 'USER_LOGIN', 'USER_CREATED', 'USER_LOCKED', 'RULE_CHAIN_TRIGGERED', 'CHECKLIST_SUBMITTED', 'CHECKLIST_APPROVED', 'CHECKLIST_REJECTED', 'SYSTEM_ERROR');

-- CreateEnum
CREATE TYPE "pm_schedule_status" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "pm_execution_status" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'MISSED');

-- CreateEnum
CREATE TYPE "filter_set_label" AS ENUM ('SET_A', 'SET_B');

-- CreateEnum
CREATE TYPE "pipeline_flow_mode" AS ENUM ('STRICT', 'BYPASS_ENABLED');

-- CreateEnum
CREATE TYPE "pipeline_node_type" AS ENUM ('STAGE', 'START', 'END', 'CHECKLIST', 'REMARKS', 'DURATION_INTERLOCK', 'PARAM_CAPTURE', 'CUSTOM_SCRIPT', 'APPROVAL', 'EQUIPMENT_LINK');

-- CreateEnum
CREATE TYPE "cleaning_cycle_status" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "filter_event_type" AS ENUM ('STATE_TRANSITION', 'PARAMETER_CAPTURE', 'CHECKLIST_COMPLETED', 'BYPASS_DEVIATION', 'EQUIPMENT_LINKED', 'REMARK_ADDED', 'APPROVAL_GRANTED', 'SCRIPT_EXECUTED', 'CYCLE_STARTED', 'CYCLE_COMPLETED');

-- CreateEnum
CREATE TYPE "block_restriction" AS ENUM ('OWN_BLOCK_ONLY', 'ANY_BLOCK', 'SPECIFIC_BLOCKS');

-- CreateEnum
CREATE TYPE "checklist_question_type" AS ENUM ('YES_NO', 'PASS_FAIL', 'YES_NO_NA', 'TEXT', 'NUMERIC', 'DROPDOWN', 'MULTI_SELECT', 'DATE_TIME', 'PHOTO', 'SIGNATURE', 'CALCULATED', 'CONDITIONAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'USER_CREATION_REQUEST_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'USER_CREATION_REQUEST_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'USER_CREATION_REQUEST_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'ALARM_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'ALARM_ACKNOWLEDGED';
ALTER TYPE "NotificationType" ADD VALUE 'ALARM_CLEARED';
ALTER TYPE "NotificationType" ADD VALUE 'DEVICE_ONLINE';
ALTER TYPE "NotificationType" ADD VALUE 'DEVICE_OFFLINE';
ALTER TYPE "NotificationType" ADD VALUE 'DEVICE_INACTIVITY';
ALTER TYPE "NotificationType" ADD VALUE 'USER_LOGIN';
ALTER TYPE "NotificationType" ADD VALUE 'USER_LOCKED';
ALTER TYPE "NotificationType" ADD VALUE 'RULE_CHAIN_TRIGGERED';
ALTER TYPE "NotificationType" ADD VALUE 'CHECKLIST_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'CHECKLIST_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'CHECKLIST_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'SYSTEM_ERROR';

-- AlterTable
ALTER TABLE "alarms" ADD COLUMN     "clear_details" JSONB;

-- AlterTable
ALTER TABLE "asset_instances" ADD COLUMN     "current_cycle_id" UUID,
ADD COLUMN     "current_lifecycle_state" VARCHAR(100),
ADD COLUMN     "filter_profile_id" UUID,
ADD COLUMN     "filter_set" "filter_set_label",
ADD COLUMN     "organization_id" UUID;

-- AlterTable
ALTER TABLE "asset_templates" ADD COLUMN     "organization_id" UUID;

-- AlterTable
ALTER TABLE "audit_trail" DROP CONSTRAINT "audit_trail_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "scope" "RoleScope" NOT NULL DEFAULT 'ORGANIZATION';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "auth_source" VARCHAR(10) NOT NULL DEFAULT 'local',
ADD COLUMN     "ldap_dn" TEXT,
ADD COLUMN     "organization_id" UUID;

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "parent_org_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "assignee_type" "AssigneeType" NOT NULL,
    "user_id" UUID,
    "organization_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(50),

    CONSTRAINT "template_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "assignee_type" "AssigneeType" NOT NULL,
    "user_id" UUID,
    "organization_id" UUID,
    "role_value" VARCHAR(50),
    "permissions" JSONB NOT NULL DEFAULT '{"view":true,"control":false,"configure":false}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(50),

    CONSTRAINT "entity_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "layout" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "scope" "DashboardScope" NOT NULL DEFAULT 'TENANT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dashboard_id" UUID NOT NULL,
    "widget_type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" JSONB NOT NULL DEFAULT '{"x":0,"y":0,"w":4,"h":3}',
    "data_source" JSONB NOT NULL DEFAULT '{}',
    "refresh_interval" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dashboard_id" UUID NOT NULL,
    "assignee_type" "AssigneeType" NOT NULL,
    "user_id" UUID,
    "organization_id" UUID,
    "role_value" VARCHAR(50),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_queue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" TEXT NOT NULL,
    "entity_id" UUID,
    "message_type" VARCHAR(50) NOT NULL,
    "payload" JSONB NOT NULL,
    "error_message" TEXT NOT NULL,
    "error_stage" VARCHAR(50) NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "dead_letter_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel" "NotificationChannel" NOT NULL,
    "recipient" VARCHAR(500) NOT NULL,
    "subject" VARCHAR(500),
    "message" TEXT NOT NULL,
    "template_id" VARCHAR(100),
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "next_retry_at" TIMESTAMPTZ,
    "error_message" TEXT,
    "metadata" JSONB,
    "triggered_by" VARCHAR(100),
    "rule_chain_id" UUID,
    "alarm_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" VARCHAR(500),
    "body_template" TEXT NOT NULL,
    "description" VARCHAR(500),
    "variables" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "event_type" "NotificationEventType" NOT NULL,
    "event_types" "NotificationEventType"[] DEFAULT ARRAY[]::"NotificationEventType"[],
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_template_id" UUID,
    "sms_template_id" UUID,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rule_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule_id" UUID NOT NULL,
    "recipient_type" VARCHAR(20) NOT NULL,
    "role_value" VARCHAR(50),
    "group_id" UUID,
    "user_id" UUID,

    CONSTRAINT "notification_rule_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pm_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "pm_schedule_status" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pm_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pm_schedule_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schedule_id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "planned_date" DATE NOT NULL,
    "tolerance_days" INTEGER NOT NULL DEFAULT 0,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "notes" TEXT,

    CONSTRAINT "pm_schedule_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pm_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schedule_entry_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "status" "pm_execution_status" NOT NULL DEFAULT 'SCHEDULED',
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "performed_by" UUID,
    "is_within_window" BOOLEAN NOT NULL DEFAULT true,
    "filter_set" "filter_set_label",
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pm_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_cleaning_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "organization_id" UUID NOT NULL,
    "flow_mode" "pipeline_flow_mode" NOT NULL DEFAULT 'STRICT',
    "alarm_on_forward_skip" BOOLEAN NOT NULL DEFAULT true,
    "alarm_on_backward_jump" BOOLEAN NOT NULL DEFAULT true,
    "alarm_on_out_of_sequence" BOOLEAN NOT NULL DEFAULT true,
    "cleaning_reasons" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "pm_schedule_status" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "filter_cleaning_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "state_key" VARCHAR(100),
    "node_type" "pipeline_node_type" NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "position_x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "filter_pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_pipeline_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "from_stage_id" UUID NOT NULL,
    "to_stage_id" UUID NOT NULL,
    "label" VARCHAR(100) DEFAULT 'Next',

    CONSTRAINT "filter_pipeline_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "cleaning_profile_id" UUID NOT NULL,
    "applicable_templates" JSONB NOT NULL DEFAULT '[]',
    "default_pm_schedule_id" UUID,
    "block_restriction" "block_restriction" NOT NULL DEFAULT 'OWN_BLOCK_ONLY',
    "allowed_blocks" JSONB,
    "max_cleaning_cycles" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "filter_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleaning_cycles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cycle_code" VARCHAR(100) NOT NULL,
    "filter_id" UUID NOT NULL,
    "ahu_id" UUID,
    "profile_id" UUID NOT NULL,
    "profile_version" INTEGER NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "status" "cleaning_cycle_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "terminated_at" TIMESTAMPTZ,
    "termination_reason" TEXT,
    "cleaning_area_id" UUID,
    "pm_execution_id" UUID,
    "cleaning_reason_key" VARCHAR(100) NOT NULL,
    "cleaning_reason_label" VARCHAR(255) NOT NULL,
    "cleaning_justification" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cleaning_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "filter_id" UUID NOT NULL,
    "cycle_id" UUID,
    "event_type" "filter_event_type" NOT NULL,
    "from_state" VARCHAR(100),
    "to_state" VARCHAR(100),
    "performed_by" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleaning_area_id" UUID,
    "equipment_id" UUID,
    "block_id" UUID,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "telemetry_snapshot" JSONB NOT NULL DEFAULT '{}',
    "remarks" TEXT,
    "deviation_details" JSONB,
    "checksum" VARCHAR(64) NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "filter_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "organization_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "checklist_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "question_type" "checklist_question_type" NOT NULL DEFAULT 'YES_NO',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "section" VARCHAR(255),
    "description" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "validation" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "checklist_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organizations_is_active_idx" ON "organizations"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "template_assignments_template_id_idx" ON "template_assignments"("template_id");

-- CreateIndex
CREATE INDEX "template_assignments_organization_id_idx" ON "template_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "template_assignments_user_id_idx" ON "template_assignments"("user_id");

-- CreateIndex
CREATE INDEX "entity_assignments_entity_id_idx" ON "entity_assignments"("entity_id");

-- CreateIndex
CREATE INDEX "entity_assignments_user_id_idx" ON "entity_assignments"("user_id");

-- CreateIndex
CREATE INDEX "entity_assignments_organization_id_idx" ON "entity_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "dashboards_is_active_idx" ON "dashboards"("is_active");

-- CreateIndex
CREATE INDEX "dashboard_widgets_dashboard_id_idx" ON "dashboard_widgets"("dashboard_id");

-- CreateIndex
CREATE INDEX "dashboard_assignments_dashboard_id_idx" ON "dashboard_assignments"("dashboard_id");

-- CreateIndex
CREATE INDEX "dashboard_assignments_user_id_idx" ON "dashboard_assignments"("user_id");

-- CreateIndex
CREATE INDEX "dashboard_assignments_organization_id_idx" ON "dashboard_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "dead_letter_queue_status_idx" ON "dead_letter_queue"("status");

-- CreateIndex
CREATE INDEX "dead_letter_queue_created_at_idx" ON "dead_letter_queue"("created_at");

-- CreateIndex
CREATE INDEX "notification_logs_channel_idx" ON "notification_logs"("channel");

-- CreateIndex
CREATE INDEX "notification_logs_status_idx" ON "notification_logs"("status");

-- CreateIndex
CREATE INDEX "notification_logs_recipient_idx" ON "notification_logs"("recipient");

-- CreateIndex
CREATE INDEX "notification_logs_created_at_idx" ON "notification_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_logs_rule_chain_id_idx" ON "notification_logs"("rule_chain_id");

-- CreateIndex
CREATE INDEX "notification_logs_alarm_id_idx" ON "notification_logs"("alarm_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_name_key" ON "notification_templates"("name");

-- CreateIndex
CREATE INDEX "notification_templates_channel_idx" ON "notification_templates"("channel");

-- CreateIndex
CREATE INDEX "notification_templates_is_active_idx" ON "notification_templates"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "user_groups_name_key" ON "user_groups"("name");

-- CreateIndex
CREATE INDEX "user_group_members_group_id_idx" ON "user_group_members"("group_id");

-- CreateIndex
CREATE INDEX "user_group_members_user_id_idx" ON "user_group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_members_group_id_user_id_key" ON "user_group_members"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "notification_rules_event_type_idx" ON "notification_rules"("event_type");

-- CreateIndex
CREATE INDEX "notification_rules_is_active_idx" ON "notification_rules"("is_active");

-- CreateIndex
CREATE INDEX "notification_rule_recipients_rule_id_idx" ON "notification_rule_recipients"("rule_id");

-- CreateIndex
CREATE INDEX "pm_schedules_entity_id_status_idx" ON "pm_schedules"("entity_id", "status");

-- CreateIndex
CREATE INDEX "pm_schedules_year_idx" ON "pm_schedules"("year");

-- CreateIndex
CREATE UNIQUE INDEX "pm_schedules_entity_id_year_version_key" ON "pm_schedules"("entity_id", "year", "version");

-- CreateIndex
CREATE INDEX "pm_schedule_entries_schedule_id_idx" ON "pm_schedule_entries"("schedule_id");

-- CreateIndex
CREATE INDEX "pm_schedule_entries_window_start_window_end_idx" ON "pm_schedule_entries"("window_start", "window_end");

-- CreateIndex
CREATE UNIQUE INDEX "pm_schedule_entries_schedule_id_month_key" ON "pm_schedule_entries"("schedule_id", "month");

-- CreateIndex
CREATE INDEX "pm_executions_entity_id_status_idx" ON "pm_executions"("entity_id", "status");

-- CreateIndex
CREATE INDEX "pm_executions_schedule_entry_id_idx" ON "pm_executions"("schedule_entry_id");

-- CreateIndex
CREATE INDEX "filter_cleaning_profiles_organization_id_status_idx" ON "filter_cleaning_profiles"("organization_id", "status");

-- CreateIndex
CREATE INDEX "filter_pipeline_stages_profile_id_sort_order_idx" ON "filter_pipeline_stages"("profile_id", "sort_order");

-- CreateIndex
CREATE INDEX "filter_pipeline_connections_profile_id_idx" ON "filter_pipeline_connections"("profile_id");

-- CreateIndex
CREATE INDEX "filter_pipeline_connections_from_stage_id_idx" ON "filter_pipeline_connections"("from_stage_id");

-- CreateIndex
CREATE INDEX "filter_profiles_organization_id_is_active_idx" ON "filter_profiles"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "cleaning_cycles_cycle_code_key" ON "cleaning_cycles"("cycle_code");

-- CreateIndex
CREATE INDEX "cleaning_cycles_filter_id_status_idx" ON "cleaning_cycles"("filter_id", "status");

-- CreateIndex
CREATE INDEX "cleaning_cycles_ahu_id_status_idx" ON "cleaning_cycles"("ahu_id", "status");

-- CreateIndex
CREATE INDEX "cleaning_cycles_started_at_idx" ON "cleaning_cycles"("started_at");

-- CreateIndex
CREATE INDEX "cleaning_cycles_cleaning_reason_key_idx" ON "cleaning_cycles"("cleaning_reason_key");

-- CreateIndex
CREATE INDEX "cleaning_cycles_pm_execution_id_idx" ON "cleaning_cycles"("pm_execution_id");

-- CreateIndex
CREATE INDEX "filter_events_filter_id_cycle_id_idx" ON "filter_events"("filter_id", "cycle_id");

-- CreateIndex
CREATE INDEX "filter_events_performed_at_idx" ON "filter_events"("performed_at");

-- CreateIndex
CREATE INDEX "filter_events_event_type_filter_id_idx" ON "filter_events"("event_type", "filter_id");

-- CreateIndex
CREATE INDEX "filter_events_cycle_id_idx" ON "filter_events"("cycle_id");

-- CreateIndex
CREATE INDEX "checklist_profiles_organization_id_is_active_idx" ON "checklist_profiles"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "checklist_questions_profile_id_sort_order_idx" ON "checklist_questions"("profile_id", "sort_order");

-- CreateIndex
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parent_org_id_fkey" FOREIGN KEY ("parent_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_assignments" ADD CONSTRAINT "dashboard_assignments_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rule_recipients" ADD CONSTRAINT "notification_rule_recipients_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "notification_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rule_recipients" ADD CONSTRAINT "notification_rule_recipients_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pm_schedule_entries" ADD CONSTRAINT "pm_schedule_entries_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "pm_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pm_executions" ADD CONSTRAINT "pm_executions_schedule_entry_id_fkey" FOREIGN KEY ("schedule_entry_id") REFERENCES "pm_schedule_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_pipeline_stages" ADD CONSTRAINT "filter_pipeline_stages_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "filter_cleaning_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_pipeline_connections" ADD CONSTRAINT "filter_pipeline_connections_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "filter_cleaning_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_pipeline_connections" ADD CONSTRAINT "filter_pipeline_connections_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "filter_pipeline_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_pipeline_connections" ADD CONSTRAINT "filter_pipeline_connections_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "filter_pipeline_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_events" ADD CONSTRAINT "filter_events_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "cleaning_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_questions" ADD CONSTRAINT "checklist_questions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "checklist_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
