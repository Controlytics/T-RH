-- REPORT TEMPLATES (2026-11-02): what a dashboard widget's "Download report"
-- prints, per instrument PROFILE per widget TYPE. Any number of named templates
-- per (profile, widget type); at most one is the default; none is promoted when
-- the default is deleted (the download then uses the built-in).
-- Spec: docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §5
--
-- Hand-authored from `prisma migrate diff --from-url <dev> --to-schema-datamodel`;
-- ONLY the new table, its plain unique index and its FK are kept. Stripped, as on
-- every migration here: the DROP of the partitioned instrument_telemetry_history
-- (Prisma cannot see it), the audit_trail.chain_position / audit_chain_counter
-- noise, the instrument_credentials FK drop/re-add and the
-- notification_rule_recipients index drop.
--
-- `widget_type` is a validated string (WIDGET_TYPES in @digilog/shared), not an
-- enum. `profile_id` is TEXT because instrument_profiles.id is TEXT. ON DELETE
-- CASCADE: a template means nothing without its profile (the profile DELETE route
-- writes one REPORT_TEMPLATE_DELETED audit row per template it takes with it).

CREATE TABLE "report_templates" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "widget_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_templates_profile_id_widget_type_name_key" ON "report_templates"("profile_id", "widget_type", "name");

ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "instrument_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOT expressible in schema.prisma (documented on the model):
--
-- A name is unique per (profile, widget type) IGNORING CASE — "Gauge A" and
-- "gauge a" are one name. The route answers this index's P2002 as 409
-- TEMPLATE_NAME_IN_USE; there is no application pre-check, so the index IS the
-- rule (and two concurrent creates cannot both win).
CREATE UNIQUE INDEX "report_templates_profile_type_lower_name_key" ON "report_templates"("profile_id", "widget_type", lower("name"));

-- At most ONE default per (profile, widget type). Every route that sets a
-- default clears the others first in the same transaction, under a row lock on
-- the profile; this index is the invariant behind that rule, so two concurrent
-- "set as default" calls can never leave two defaults for `resolve` to choose
-- between.
CREATE UNIQUE INDEX "report_templates_one_default" ON "report_templates"("profile_id", "widget_type") WHERE "is_default";
