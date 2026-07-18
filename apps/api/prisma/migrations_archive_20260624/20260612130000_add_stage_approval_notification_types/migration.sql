-- AlterEnum
-- Cleaning stage interlock (QA approval after WASH_OUT/DRY_OUT) notification types (2026-06-12).
ALTER TYPE "NotificationType" ADD VALUE 'STAGE_APPROVAL_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'STAGE_APPROVAL_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'STAGE_APPROVAL_REJECTED';
