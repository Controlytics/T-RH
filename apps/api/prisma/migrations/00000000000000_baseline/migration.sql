-- compliance-core baseline (re-baselined 2026-07-18 after domain strip)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssigneeType" AS ENUM ('USER', 'ROLE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ENABLED', 'DISABLED', 'LOCKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ACCOUNT_LOCKED', 'ACCOUNT_DISABLED', 'ACCOUNT_ENABLED', 'PASSWORD_RESET_REQUEST', 'PASSWORD_RESET_APPROVED', 'PASSWORD_RESET_REJECTED', 'USER_CREATED', 'USER_UPDATED', 'ROLE_CHANGED', 'USER_CREATION_REQUEST_SUBMITTED', 'USER_CREATION_REQUEST_APPROVED', 'USER_CREATION_REQUEST_REJECTED', 'DEVICE_ONLINE', 'DEVICE_OFFLINE', 'DEVICE_INACTIVITY', 'USER_LOGIN', 'USER_LOCKED', 'CHECKLIST_SUBMITTED', 'CHECKLIST_APPROVED', 'CHECKLIST_REJECTED', 'SYSTEM_ERROR', 'PM_OVERDUE', 'PM_OVERDUE_COMPLETED', 'PM_SCHEDULE_QNN', 'GUEST_CLEANING_REQUEST', 'REPORT_REVIEW_REQUESTED', 'REPORT_REVIEW_APPROVED', 'REPORT_REVIEW_REJECTED', 'PASSWORD_EXPIRY_WARNING', 'PASSWORD_EXPIRED_NOTICE', 'STAGE_APPROVAL_REQUESTED', 'STAGE_APPROVAL_APPROVED', 'STAGE_APPROVAL_REJECTED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'IN_APP', 'TELEGRAM', 'WHATSAPP', 'SLACK');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('DEVICE_ONLINE', 'DEVICE_OFFLINE', 'DEVICE_INACTIVITY', 'USER_LOGIN', 'USER_CREATED', 'USER_LOCKED', 'CHECKLIST_SUBMITTED', 'CHECKLIST_APPROVED', 'CHECKLIST_REJECTED', 'SYSTEM_ERROR');

-- CreateTable
CREATE TABLE "dashboards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "layout" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
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
    "role_value" VARCHAR(50),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "hierarchy_level" INTEGER NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "color" VARCHAR(100) NOT NULL DEFAULT '#6366f1',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),
    "updated_by" VARCHAR(50),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "username" VARCHAR(50) NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(100),
    "password_hash" TEXT NOT NULL,
    "department" VARCHAR(50),
    "photo_url" VARCHAR(500),
    "role" VARCHAR(50) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ENABLED',
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ,
    "lockout_until" TIMESTAMPTZ,
    "password_changed_at" TIMESTAMPTZ,
    "password_expires_at" TIMESTAMPTZ,
    "force_password_change" BOOLEAN NOT NULL DEFAULT true,
    "is_temporary_password" BOOLEAN NOT NULL DEFAULT true,
    "auth_source" VARCHAR(10) NOT NULL DEFAULT 'local',
    "ldap_dn" TEXT,
    "last_login" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),
    "updated_by" VARCHAR(50),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "termination_reason" VARCHAR(50),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "config_key" VARCHAR(100) NOT NULL,
    "config_value" JSONB NOT NULL,
    "config_type" VARCHAR(50) NOT NULL,
    "requires_reauth" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(50),

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_id_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "field_id" VARCHAR(50) NOT NULL,
    "default_name" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "module" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(50),

    CONSTRAINT "field_id_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "processed_by" VARCHAR(50),
    "notes" TEXT,

    CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_type" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "requester_name" VARCHAR(100) NOT NULL,
    "requester_employee_id" VARCHAR(50),
    "requester_email" VARCHAR(100),
    "request_data" JSONB NOT NULL DEFAULT '{}',
    "remarks" VARCHAR(500),
    "admin_remarks" VARCHAR(500),
    "processed_by" VARCHAR(100),
    "manual_entry" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "admin_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_trail" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" VARCHAR(100),
    "user_name" VARCHAR(100),
    "user_role" VARCHAR(20),
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50),
    "target_id" VARCHAR(255),
    "before_value" JSONB,
    "after_value" JSONB,
    "reason" TEXT,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "session_id" VARCHAR(100),
    "checksum" VARCHAR(64) NOT NULL,
    "checksum_version" SMALLINT,
    "previous_checksum" VARCHAR(64),
    "chain_position" BIGSERIAL,
    "signature_meaning" VARCHAR(255),
    "redacted_at" TIMESTAMPTZ,
    "redacted_by" VARCHAR(100),
    "redaction_reason" TEXT,

    CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "target_user_id" VARCHAR(50),
    "for_user_id" VARCHAR(50),
    "for_role" VARCHAR(50),
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(50),
    "manual_entry" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "sidebar_items" JSONB NOT NULL DEFAULT '[]',
    "home_widgets" JSONB NOT NULL DEFAULT '[]',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(50),

    CONSTRAINT "user_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" VARCHAR(50) NOT NULL,
    "sidebar_items" JSONB NOT NULL DEFAULT '[]',
    "home_widgets" JSONB NOT NULL DEFAULT '[]',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(50),

    CONSTRAINT "role_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_articles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(100) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "help_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_article_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "help_article_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "changed_by" VARCHAR(50) NOT NULL,
    "change_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_article_versions_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE INDEX "dashboards_is_active_idx" ON "dashboards"("is_active");

-- CreateIndex
CREATE INDEX "dashboard_widgets_dashboard_id_idx" ON "dashboard_widgets"("dashboard_id");

-- CreateIndex
CREATE INDEX "dashboard_assignments_dashboard_id_idx" ON "dashboard_assignments"("dashboard_id");

-- CreateIndex
CREATE INDEX "dashboard_assignments_user_id_idx" ON "dashboard_assignments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "roles_hierarchy_level_idx" ON "roles"("hierarchy_level");

-- CreateIndex
CREATE INDEX "roles_is_active_idx" ON "roles"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "password_history_user_id_created_at_idx" ON "password_history"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_is_active_idx" ON "sessions"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_config_key_key" ON "system_config"("config_key");

-- CreateIndex
CREATE UNIQUE INDEX "field_id_config_field_id_key" ON "field_id_config"("field_id");

-- CreateIndex
CREATE INDEX "admin_requests_status_idx" ON "admin_requests"("status");

-- CreateIndex
CREATE INDEX "admin_requests_request_type_idx" ON "admin_requests"("request_type");

-- CreateIndex
CREATE INDEX "admin_requests_requested_at_idx" ON "admin_requests"("requested_at" DESC);

-- CreateIndex
CREATE INDEX "audit_trail_timestamp_idx" ON "audit_trail"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "audit_trail_user_id_idx" ON "audit_trail"("user_id");

-- CreateIndex
CREATE INDEX "audit_trail_action_idx" ON "audit_trail"("action");

-- CreateIndex
CREATE INDEX "audit_trail_target_type_target_id_idx" ON "audit_trail"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_trail_session_id_idx" ON "audit_trail"("session_id");

-- CreateIndex
CREATE INDEX "audit_trail_user_id_timestamp_idx" ON "audit_trail"("user_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "audit_trail_chain_position_idx" ON "audit_trail"("chain_position");

-- CreateIndex
CREATE INDEX "notifications_for_user_id_idx" ON "notifications"("for_user_id");

-- CreateIndex
CREATE INDEX "notifications_for_role_idx" ON "notifications"("for_role");

-- CreateIndex
CREATE INDEX "notifications_is_read_idx" ON "notifications"("is_read");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_for_user_id_is_read_created_at_idx" ON "notifications"("for_user_id", "is_read", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_configs_user_id_key" ON "user_configs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_configs_role_key" ON "role_configs"("role");

-- CreateIndex
CREATE UNIQUE INDEX "help_articles_key_key" ON "help_articles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "help_article_versions_help_article_id_version_key" ON "help_article_versions"("help_article_id", "version");

-- CreateIndex
CREATE INDEX "notification_logs_channel_idx" ON "notification_logs"("channel");

-- CreateIndex
CREATE INDEX "notification_logs_status_idx" ON "notification_logs"("status");

-- CreateIndex
CREATE INDEX "notification_logs_recipient_idx" ON "notification_logs"("recipient");

-- CreateIndex
CREATE INDEX "notification_logs_created_at_idx" ON "notification_logs"("created_at" DESC);

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
CREATE INDEX "notification_rules_is_active_priority_idx" ON "notification_rules"("is_active", "priority" DESC);

-- CreateIndex
CREATE INDEX "notification_rule_recipients_rule_id_idx" ON "notification_rule_recipients"("rule_id");

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_assignments" ADD CONSTRAINT "dashboard_assignments_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_article_versions" ADD CONSTRAINT "help_article_versions_help_article_id_fkey" FOREIGN KEY ("help_article_id") REFERENCES "help_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rule_recipients" ADD CONSTRAINT "notification_rule_recipients_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "notification_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rule_recipients" ADD CONSTRAINT "notification_rule_recipients_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Core 21 CFR §11.10(e) audit immutability trigger (from prisma/sql/invariants.sql)
CREATE OR REPLACE FUNCTION block_audit_trail_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_trail rows are immutable. Use the admin delete endpoint which temporarily disables this trigger under audit.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_trail_no_delete ON audit_trail;
CREATE TRIGGER audit_trail_no_delete BEFORE DELETE ON audit_trail FOR EACH ROW EXECUTE FUNCTION block_audit_trail_delete();
