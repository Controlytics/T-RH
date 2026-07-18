-- AlterEnum
-- Report review/approval workflow notification types (2026-06-11).
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_REVIEW_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_REVIEW_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_REVIEW_REJECTED';
