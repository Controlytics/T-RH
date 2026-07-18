-- Add per-user password-expiry notification types (2026-07-08).
-- Drives the daily password-expiry warning sweep + one-time expiry notice.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PASSWORD_EXPIRY_WARNING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PASSWORD_EXPIRED_NOTICE';
