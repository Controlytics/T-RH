-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ENABLED', 'DISABLED', 'LOCKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ACCOUNT_LOCKED', 'ACCOUNT_DISABLED', 'ACCOUNT_ENABLED', 'PASSWORD_RESET_REQUEST', 'PASSWORD_RESET_APPROVED', 'PASSWORD_RESET_REJECTED', 'USER_CREATED', 'USER_UPDATED', 'ROLE_CHANGED');

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
    "email" VARCHAR(100) NOT NULL,
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
    "user_id" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "processed_by" VARCHAR(50),
    "notes" TEXT,

    CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_trail" (
    "id" SERIAL NOT NULL,
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
    "signature_meaning" VARCHAR(255),

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
CREATE TABLE "asset_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "category" VARCHAR(50) NOT NULL DEFAULT 'General',
    "icon" VARCHAR(50) NOT NULL DEFAULT 'box',
    "version" INTEGER NOT NULL DEFAULT 1,
    "attribute_schema" JSONB NOT NULL DEFAULT '[]',
    "telemetry_schema" JSONB NOT NULL DEFAULT '[]',
    "expected_identifiers" JSONB NOT NULL DEFAULT '[]',
    "expected_relationships" JSONB NOT NULL DEFAULT '[]',
    "status_lifecycle" JSONB NOT NULL DEFAULT '[]',
    "alarm_rules" JSONB NOT NULL DEFAULT '[]',
    "checklist_schema" JSONB NOT NULL DEFAULT '[]',
    "max_parent_connections" INTEGER NOT NULL DEFAULT 1,
    "max_connections" INTEGER NOT NULL DEFAULT 10,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),
    "updated_by" VARCHAR(50),
    "data_ingestion_enabled" BOOLEAN NOT NULL DEFAULT false,
    "transport_type" VARCHAR(20),
    "credential_type" VARCHAR(20) DEFAULT 'TOKEN',
    "inactivity_timeout" INTEGER NOT NULL DEFAULT 60,
    "default_max_data_rate" INTEGER NOT NULL DEFAULT 600,
    "auto_provision" BOOLEAN NOT NULL DEFAULT true,
    "default_rule_chain_id" UUID,

    CONSTRAINT "asset_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_template_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "change_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(50),

    CONSTRAINT "asset_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(50) NOT NULL DEFAULT 'Active',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "telemetry_config" JSONB NOT NULL DEFAULT '{}',
    "custom_attributes" JSONB NOT NULL DEFAULT '{}',
    "parent_id" UUID,
    "uns_path" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),
    "updated_by" VARCHAR(50),

    CONSTRAINT "asset_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_relationships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_asset_id" UUID NOT NULL,
    "target_asset_id" UUID NOT NULL,
    "relationship_type" VARCHAR(50) NOT NULL,
    "custom_label" VARCHAR(100),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),
    "updated_by" VARCHAR(50),

    CONSTRAINT "asset_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_identifiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "asset_id" UUID NOT NULL,
    "identifier_type" VARCHAR(20) NOT NULL,
    "identifier_value" VARCHAR(255) NOT NULL,
    "label" VARCHAR(100),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" VARCHAR(50),
    "updated_by" VARCHAR(50),

    CONSTRAINT "asset_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "access_token" TEXT NOT NULL,
    "credential_data" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'INACTIVE',
    "allowed_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "device_fingerprint" TEXT,
    "max_data_rate_per_min" INTEGER NOT NULL DEFAULT 600,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "first_connected_at" TIMESTAMPTZ,
    "last_connected_at" TIMESTAMPTZ,
    "last_disconnected_at" TIMESTAMPTZ,
    "last_source_ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "device_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_chains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "is_root" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "first_rule_node_id" UUID,
    "configuration" JSONB,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rule_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_chain_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule_chain_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_by" VARCHAR(50) NOT NULL,
    "change_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_chain_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule_chain_id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "debug_enabled" BOOLEAN NOT NULL DEFAULT false,
    "position_x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rule_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_node_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule_chain_id" UUID NOT NULL,
    "from_node_id" UUID NOT NULL,
    "to_node_id" UUID NOT NULL,
    "label" VARCHAR(100) NOT NULL,

    CONSTRAINT "rule_node_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "alarm_type" VARCHAR(100) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "uns_path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_rule_chain" UUID,
    "trigger_details" JSONB,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_by" VARCHAR(50),
    "acknowledged_at" TIMESTAMPTZ,
    "ack_remarks" TEXT,
    "ack_signature_id" UUID,
    "cleared" BOOLEAN NOT NULL DEFAULT false,
    "cleared_at" TIMESTAMPTZ,
    "cleared_by" VARCHAR(50),
    "clear_remarks" TEXT,
    "clear_signature_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "alarms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "checklist_id" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "current_step" VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED',
    "current_sequence" INTEGER NOT NULL DEFAULT 1,
    "performed_by" VARCHAR(50) NOT NULL,
    "performed_at" TIMESTAMPTZ NOT NULL,
    "performed_signature_id" UUID,
    "checked_by" VARCHAR(50),
    "checked_at" TIMESTAMPTZ,
    "checked_remarks" TEXT,
    "checked_signature_id" UUID,
    "verified_by" VARCHAR(50),
    "verified_at" TIMESTAMPTZ,
    "verified_remarks" TEXT,
    "verified_signature_id" UUID,
    "rejected_by" VARCHAR(50),
    "rejected_at" TIMESTAMPTZ,
    "rejection_reason" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "checklist_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "electronic_signatures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "record_type" VARCHAR(30) NOT NULL,
    "record_id" TEXT NOT NULL,
    "signer_user_id" VARCHAR(50) NOT NULL,
    "signer_full_name" VARCHAR(100) NOT NULL,
    "signer_role" VARCHAR(50) NOT NULL,
    "signed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meaning" VARCHAR(100) NOT NULL,
    "record_hash" VARCHAR(64) NOT NULL,
    "signature_hash" VARCHAR(64) NOT NULL,
    "re_auth_verified" BOOLEAN NOT NULL DEFAULT true,
    "re_auth_method" VARCHAR(20) NOT NULL DEFAULT 'password',
    "signature_image" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "electronic_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "latest_telemetry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "value_num" DOUBLE PRECISION,
    "value_str" TEXT,
    "value_bool" BOOLEAN,
    "value_json" JSONB,
    "last_updated" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "latest_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uns_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "uns_path" TEXT NOT NULL,
    "path_segments" JSONB NOT NULL,
    "is_overridden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "uns_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectivity_status" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    "last_activity_at" TIMESTAMPTZ,
    "last_connected_at" TIMESTAMPTZ,
    "last_disconnected_at" TIMESTAMPTZ,
    "protocol" VARCHAR(20),
    "source_ip" VARCHAR(45),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connectivity_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "qr_data" TEXT NOT NULL,
    "image_path" TEXT NOT NULL,
    "svg_data" TEXT,
    "size" VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
    "include_label" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "data_streams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "data_type" VARCHAR(20) NOT NULL,
    "unit" VARCHAR(50),
    "uns_path" TEXT NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'device',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "data_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_system_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "data_type" VARCHAR(20) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "default_value" TEXT NOT NULL,
    "min_value" TEXT,
    "max_value" TEXT,
    "unit" VARCHAR(20),
    "requires_restart" BOOLEAN NOT NULL DEFAULT false,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" VARCHAR(50),
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_system_config_pkey" PRIMARY KEY ("id")
);

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
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_is_active_idx" ON "sessions"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_config_key_key" ON "system_config"("config_key");

-- CreateIndex
CREATE UNIQUE INDEX "field_id_config_field_id_key" ON "field_id_config"("field_id");

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
CREATE INDEX "notifications_for_user_id_idx" ON "notifications"("for_user_id");

-- CreateIndex
CREATE INDEX "notifications_for_role_idx" ON "notifications"("for_role");

-- CreateIndex
CREATE INDEX "notifications_is_read_idx" ON "notifications"("is_read");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_configs_user_id_key" ON "user_configs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_configs_role_key" ON "role_configs"("role");

-- CreateIndex
CREATE UNIQUE INDEX "asset_templates_name_key" ON "asset_templates"("name");

-- CreateIndex
CREATE INDEX "asset_templates_is_active_idx" ON "asset_templates"("is_active");

-- CreateIndex
CREATE INDEX "asset_templates_category_idx" ON "asset_templates"("category");

-- CreateIndex
CREATE INDEX "asset_template_versions_template_id_idx" ON "asset_template_versions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_template_versions_template_id_version_number_key" ON "asset_template_versions"("template_id", "version_number");

-- CreateIndex
CREATE INDEX "asset_instances_template_id_idx" ON "asset_instances"("template_id");

-- CreateIndex
CREATE INDEX "asset_instances_status_idx" ON "asset_instances"("status");

-- CreateIndex
CREATE INDEX "asset_instances_parent_id_idx" ON "asset_instances"("parent_id");

-- CreateIndex
CREATE INDEX "asset_instances_name_idx" ON "asset_instances"("name");

-- CreateIndex
CREATE INDEX "asset_instances_is_active_idx" ON "asset_instances"("is_active");

-- CreateIndex
CREATE INDEX "asset_relationships_source_asset_id_idx" ON "asset_relationships"("source_asset_id");

-- CreateIndex
CREATE INDEX "asset_relationships_target_asset_id_idx" ON "asset_relationships"("target_asset_id");

-- CreateIndex
CREATE INDEX "asset_relationships_relationship_type_idx" ON "asset_relationships"("relationship_type");

-- CreateIndex
CREATE UNIQUE INDEX "asset_relationships_source_asset_id_target_asset_id_relatio_key" ON "asset_relationships"("source_asset_id", "target_asset_id", "relationship_type");

-- CreateIndex
CREATE UNIQUE INDEX "asset_identifiers_identifier_value_key" ON "asset_identifiers"("identifier_value");

-- CreateIndex
CREATE INDEX "asset_identifiers_asset_id_idx" ON "asset_identifiers"("asset_id");

-- CreateIndex
CREATE INDEX "asset_identifiers_identifier_type_idx" ON "asset_identifiers"("identifier_type");

-- CreateIndex
CREATE UNIQUE INDEX "device_credentials_entity_id_key" ON "device_credentials"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_credentials_access_token_key" ON "device_credentials"("access_token");

-- CreateIndex
CREATE INDEX "device_credentials_status_idx" ON "device_credentials"("status");

-- CreateIndex
CREATE INDEX "rule_chains_is_root_idx" ON "rule_chains"("is_root");

-- CreateIndex
CREATE INDEX "rule_chains_is_active_idx" ON "rule_chains"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "rule_chain_versions_rule_chain_id_version_key" ON "rule_chain_versions"("rule_chain_id", "version");

-- CreateIndex
CREATE INDEX "rule_nodes_rule_chain_id_idx" ON "rule_nodes"("rule_chain_id");

-- CreateIndex
CREATE INDEX "rule_node_connections_rule_chain_id_idx" ON "rule_node_connections"("rule_chain_id");

-- CreateIndex
CREATE INDEX "alarms_entity_id_status_idx" ON "alarms"("entity_id", "status");

-- CreateIndex
CREATE INDEX "alarms_severity_status_idx" ON "alarms"("severity", "status");

-- CreateIndex
CREATE INDEX "alarms_created_at_idx" ON "alarms"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_reviews_checklist_id_key" ON "checklist_reviews"("checklist_id");

-- CreateIndex
CREATE INDEX "checklist_reviews_entity_id_idx" ON "checklist_reviews"("entity_id");

-- CreateIndex
CREATE INDEX "checklist_reviews_current_step_idx" ON "checklist_reviews"("current_step");

-- CreateIndex
CREATE INDEX "electronic_signatures_record_type_record_id_idx" ON "electronic_signatures"("record_type", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "latest_telemetry_entity_id_key_key" ON "latest_telemetry"("entity_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "uns_mappings_entity_id_key" ON "uns_mappings"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uns_mappings_uns_path_key" ON "uns_mappings"("uns_path");

-- CreateIndex
CREATE UNIQUE INDEX "connectivity_status_entity_id_key" ON "connectivity_status"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "qr_codes_entity_id_key" ON "qr_codes"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "help_articles_key_key" ON "help_articles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "help_article_versions_help_article_id_version_key" ON "help_article_versions"("help_article_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "data_streams_entity_id_key_key" ON "data_streams"("entity_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_system_config_key_key" ON "ingestion_system_config"("key");

-- AddForeignKey
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_templates" ADD CONSTRAINT "asset_templates_default_rule_chain_id_fkey" FOREIGN KEY ("default_rule_chain_id") REFERENCES "rule_chains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_template_versions" ADD CONSTRAINT "asset_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "asset_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_instances" ADD CONSTRAINT "asset_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "asset_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_instances" ADD CONSTRAINT "asset_instances_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "asset_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_relationships" ADD CONSTRAINT "asset_relationships_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "asset_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_relationships" ADD CONSTRAINT "asset_relationships_target_asset_id_fkey" FOREIGN KEY ("target_asset_id") REFERENCES "asset_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_identifiers" ADD CONSTRAINT "asset_identifiers_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_chain_versions" ADD CONSTRAINT "rule_chain_versions_rule_chain_id_fkey" FOREIGN KEY ("rule_chain_id") REFERENCES "rule_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_nodes" ADD CONSTRAINT "rule_nodes_rule_chain_id_fkey" FOREIGN KEY ("rule_chain_id") REFERENCES "rule_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node_connections" ADD CONSTRAINT "rule_node_connections_rule_chain_id_fkey" FOREIGN KEY ("rule_chain_id") REFERENCES "rule_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node_connections" ADD CONSTRAINT "rule_node_connections_from_node_id_fkey" FOREIGN KEY ("from_node_id") REFERENCES "rule_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node_connections" ADD CONSTRAINT "rule_node_connections_to_node_id_fkey" FOREIGN KEY ("to_node_id") REFERENCES "rule_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_article_versions" ADD CONSTRAINT "help_article_versions_help_article_id_fkey" FOREIGN KEY ("help_article_id") REFERENCES "help_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
