-- PAGE REPORTS ON TEMPLATES (2026-11-03): a report template is for a TEMPLATE
-- KIND — a widget type, or one of the five page reports (`page:data-report`,
-- `page:trend`, `page:instrument-alarms`, `page:alarms`, `page:audit-trail`) —
-- and the two application-wide kinds (`page:alarms`, `page:audit-trail`) belong
-- to no profile: `profile_id` NULL.
-- Spec: docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §5
--
-- Hand-authored. Stripped, as on every migration here: the DROP of the
-- partitioned instrument_telemetry_history (Prisma cannot see it), the
-- audit_trail.chain_position / audit_chain_counter noise, the
-- instrument_credentials FK drop/re-add and the notification_rule_recipients
-- index drop that `prisma migrate diff` proposes.
--
-- 1. `widget_type` → `kind`. A validated string (TEMPLATE_KINDS in
--    @digilog/shared), not an enum. A rename keeps every stored row.
ALTER TABLE "report_templates" RENAME COLUMN "widget_type" TO "kind";

-- 2. NULL profile = application-wide. The FK stays: a profile's DELETE still
--    cascades its own templates (each audited by that route); NULL rows are
--    never touched by it.
ALTER TABLE "report_templates" ALTER COLUMN "profile_id" DROP NOT NULL;

-- 3. The three unique indexes, NULL-safe. Postgres treats NULLs as DISTINCT in
--    a unique index, so on (profile_id, kind, …) two application templates of
--    one kind named "Audit" and "audit" — or two application defaults of one
--    kind — would never collide. COALESCE(profile_id, '') folds the application
--    scope into one key ('' is no profile id: ids are uuids).
DROP INDEX "report_templates_profile_id_widget_type_name_key";
DROP INDEX "report_templates_profile_type_lower_name_key";
DROP INDEX "report_templates_one_default";

-- NOT expressible in schema.prisma (documented on the model) — none of the
-- three is: Prisma cannot index an expression, so `@@unique` left the model.
--
-- The plain name, per scope × kind.
CREATE UNIQUE INDEX "report_templates_scope_kind_name_key" ON "report_templates"(COALESCE("profile_id", ''), "kind", "name");

-- A name is unique per scope × kind IGNORING CASE — "Audit" and "audit" are one
-- name. The route answers this index's P2002 as 409 TEMPLATE_NAME_IN_USE; there
-- is no application pre-check, so the index IS the rule.
CREATE UNIQUE INDEX "report_templates_scope_kind_lower_name_key" ON "report_templates"(COALESCE("profile_id", ''), "kind", lower("name"));

-- At most ONE default per scope × kind. Every route that sets a default clears
-- the others first in the same transaction — under the profile row lock for a
-- profile scope, under pg_advisory_xact_lock(hashtext('report_templates:' ||
-- kind)) for the application scope; this index is the invariant behind that.
CREATE UNIQUE INDEX "report_templates_one_default" ON "report_templates"(COALESCE("profile_id", ''), "kind") WHERE "is_default";
