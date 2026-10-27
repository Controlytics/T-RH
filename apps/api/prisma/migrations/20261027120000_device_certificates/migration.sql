-- DEVICE CERTIFICATES (2026-10-27).
-- Spec: docs/superpowers/specs/2026-10-27-device-certificates-design.md
--
-- Hand-authored. Six nullable / defaulted columns, no data change:
--   * instruments.device_cert_* — the ONE certificate an instrument's device may
--     present (its random issue id is the identity every ingest channel
--     compares; the private key is never stored).
--   * instrument_profiles.require_device_certificate — the switch. DEFAULT false,
--     so every existing profile behaves exactly as before.
--
-- Nothing else: no DROP of the partitioned instrument_telemetry_history (Prisma
-- cannot see it), no audit-chain or FK noise.

ALTER TABLE "instruments" ADD COLUMN "device_cert_issue_id" TEXT;
ALTER TABLE "instruments" ADD COLUMN "device_cert_fingerprint" TEXT;
ALTER TABLE "instruments" ADD COLUMN "device_cert_not_after" TIMESTAMPTZ(3);
ALTER TABLE "instruments" ADD COLUMN "device_cert_issued_at" TIMESTAMPTZ(3);
ALTER TABLE "instruments" ADD COLUMN "device_cert_issued_by" TEXT;

ALTER TABLE "instrument_profiles" ADD COLUMN "require_device_certificate" BOOLEAN NOT NULL DEFAULT false;
