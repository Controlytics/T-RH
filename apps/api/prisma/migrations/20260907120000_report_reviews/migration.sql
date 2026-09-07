-- Report review workflow (2026-09-07): every PDF download becomes a REQUEST an
-- approver signs; the frozen document is the record. Design:
-- docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
--
-- HAND-AUTHORED. `prisma migrate diff` also emits
--   DROP TABLE "instrument_telemetry_history";
-- which is STRIPPED, as it has been from every migration authored in this repo
-- since 2026-08-08. That table is PARTITIONED and therefore invisible to the
-- datamodel; dropping it destroys the telemetry record. `migration-guard.ts`
-- fails the build if a committed migration ever carries it.
--
-- A NEW enum type may be used in the transaction that creates it (the
-- restriction is only on ADD VALUE), so type and table share one migration.

CREATE TYPE "report_review_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "report_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "report_type" VARCHAR(100) NOT NULL,
  "title" VARCHAR(500) NOT NULL,
  "subtitle" VARCHAR(1000),
  "request_meta" JSONB NOT NULL,
  "data_snapshot" JSONB NOT NULL,
  "status" "report_review_status" NOT NULL DEFAULT 'PENDING',
  "requested_by" UUID NOT NULL,
  "requested_by_name" VARCHAR(255) NOT NULL,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "request_remarks" TEXT NOT NULL,
  "assignee_user_id" UUID,
  "assignee_role" VARCHAR(50),
  "decided_by" UUID,
  "decided_by_name" VARCHAR(255),
  "decided_at" TIMESTAMPTZ,
  "decision_remarks" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "report_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_reviews_status_assignee_user_id_idx" ON "report_reviews"("status", "assignee_user_id");
CREATE INDEX "report_reviews_status_assignee_role_idx" ON "report_reviews"("status", "assignee_role");
CREATE INDEX "report_reviews_requested_by_created_at_idx" ON "report_reviews"("requested_by", "created_at");
