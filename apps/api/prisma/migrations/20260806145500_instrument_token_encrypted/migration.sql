-- Add InstrumentCredential.tokenEncrypted.
--
-- Spec decision D5 stored the device token as a SHA-256 hash only, shown once at
-- issuance, on the reasoning that a retrievable credential is a standing
-- liability. That was reversed 2026-08-06 at the operator's explicit request: a
-- token that cannot be read back forces a regenerate-and-go-reconfigure-the-
-- device trip every time a technician needs the value. The compensating controls
-- are encryption at rest with a key held outside the database
-- (INSTRUMENT_TOKEN_KEY), INSTRUMENT_UPDATE + password re-auth on the reveal
-- endpoint, and an INSTRUMENT_TOKEN_VIEWED audit row per view.
--
-- NULLABLE, and no backfill is possible or attempted: the plaintext of an
-- already-issued token is not recoverable from its hash, which is the point of
-- the hash. Every credential issued before this migration stays unviewable and
-- reports TOKEN_NOT_RECOVERABLE; the operator regenerates if they need the value.
--
-- `token_hash` is untouched and remains the ONLY column authentication consults.

ALTER TABLE "instrument_credentials" ADD COLUMN "token_encrypted" TEXT;
