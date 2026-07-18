-- CreateEnum
CREATE TYPE "report_review_status" AS ENUM ('PENDING_REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "report_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_type" VARCHAR(100) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "subtitle" VARCHAR(1000),
    "data_snapshot" JSONB NOT NULL,
    "status" "report_review_status" NOT NULL DEFAULT 'PENDING_REVIEW',
    "generated_by" UUID NOT NULL,
    "generated_by_name" VARCHAR(255) NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignee_user_id" UUID,
    "assignee_role" VARCHAR(50),
    "reviewed_by" UUID,
    "reviewed_by_name" VARCHAR(255),
    "reviewed_at" TIMESTAMPTZ,
    "review_remarks" TEXT,
    "approved_by" UUID,
    "approved_by_name" VARCHAR(255),
    "approved_at" TIMESTAMPTZ,
    "approval_remarks" TEXT,
    "rejection_stage" VARCHAR(20),
    "rejected_by" UUID,
    "rejected_by_name" VARCHAR(255),
    "rejected_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "report_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_reviews_status_idx" ON "report_reviews"("status");

-- CreateIndex
CREATE INDEX "report_reviews_assignee_user_id_idx" ON "report_reviews"("assignee_user_id");

-- CreateIndex
CREATE INDEX "report_reviews_assignee_role_idx" ON "report_reviews"("assignee_role");

-- CreateIndex
CREATE INDEX "report_reviews_generated_by_idx" ON "report_reviews"("generated_by");
