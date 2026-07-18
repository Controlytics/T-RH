-- Drop the orphaned reports generate/sign tables + enums (2026-07-04).
-- The modules/reports/ + modules/report-templates/ features were removed as dead
-- code (no FE surface since 2026-06-08). ReportReview (report_reviews) is the
-- ACTIVE ad-hoc review workflow and is intentionally NOT touched here.
-- See tasks/REMOVE-REPORTS-MODULE-PLAN.md.

-- DropForeignKey
ALTER TABLE "report_instances" DROP CONSTRAINT "report_instances_generated_by_fkey";
ALTER TABLE "report_instances" DROP CONSTRAINT "report_instances_template_id_fkey";
ALTER TABLE "report_signatures" DROP CONSTRAINT "report_signatures_report_id_fkey";
ALTER TABLE "report_signatures" DROP CONSTRAINT "report_signatures_user_id_fkey";
ALTER TABLE "report_template_versions" DROP CONSTRAINT "report_template_versions_created_by_fkey";
ALTER TABLE "report_template_versions" DROP CONSTRAINT "report_template_versions_template_id_fkey";
ALTER TABLE "report_templates" DROP CONSTRAINT "report_templates_created_by_fkey";

-- DropTable
DROP TABLE "report_instances";
DROP TABLE "report_signatures";
DROP TABLE "report_template_versions";
DROP TABLE "report_templates";

-- DropEnum
DROP TYPE "ReportStatus";
DROP TYPE "ReportTemplateStatus";
