-- CreateEnum
CREATE TYPE "cleaning_stage_approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "cleaning_stage_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cycle_id" UUID NOT NULL,
    "filter_id" UUID NOT NULL,
    "stage_key" VARCHAR(40) NOT NULL,
    "status" "cleaning_stage_approval_status" NOT NULL DEFAULT 'PENDING',
    "approver_role" VARCHAR(50) NOT NULL,
    "reject_to_state_key" VARCHAR(40) NOT NULL,
    "attempt_seq" INTEGER NOT NULL DEFAULT 1,
    "details_snapshot" JSONB NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_by_name" VARCHAR(255) NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_by_name" VARCHAR(255),
    "decided_at" TIMESTAMPTZ,
    "decision_remarks" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cleaning_stage_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cleaning_stage_approvals_cycle_id_stage_key_idx" ON "cleaning_stage_approvals"("cycle_id", "stage_key");

-- CreateIndex
CREATE INDEX "cleaning_stage_approvals_status_approver_role_idx" ON "cleaning_stage_approvals"("status", "approver_role");

-- CreateIndex
CREATE INDEX "cleaning_stage_approvals_filter_id_idx" ON "cleaning_stage_approvals"("filter_id");
