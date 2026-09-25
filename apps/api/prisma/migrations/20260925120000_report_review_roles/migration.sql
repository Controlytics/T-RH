-- Report reviews: the ROLE each signer held when they signed (2026-09-25).
--
--   report_reviews.requested_by_role   the requester's role at the request
--   report_reviews.decided_by_role     the approver's role at the decision
--
-- Operator: "reviewed by and approved by ... should come in table, Name, Role,
-- Date & Time for both should come side by side". The approved PDF's signature
-- block prints the role beside each name, so the role has to be FROZEN on the
-- record at the moment of the password-verified act — a user's role can change
-- later, and a signature block must read back the way it was signed.
--
-- BACKFILL, recorded here as the data step it is: rows written before this
-- column existed take the signer's CURRENT role from `users` by username
-- (requested_by_name / decided_by_name ARE usernames). That is the best
-- available fact for those rows, not the role at signing, which was never
-- stored; a row whose signer no longer exists stays NULL and prints a dash.
--
-- Nullable, no default, no enum. HAND-AUTHORED; `prisma migrate diff` also
-- emits DROP TABLE "instrument_telemetry_history", stripped as in every
-- migration since 2026-08-08 (see apps/api/src/lib/migration-guard.ts).

ALTER TABLE "report_reviews" ADD COLUMN "requested_by_role" VARCHAR(50);
ALTER TABLE "report_reviews" ADD COLUMN "decided_by_role" VARCHAR(50);

UPDATE "report_reviews" r
SET "requested_by_role" = u."role"
FROM "users" u
WHERE u."username" = r."requested_by_name" AND r."requested_by_role" IS NULL;

UPDATE "report_reviews" r
SET "decided_by_role" = u."role"
FROM "users" u
WHERE r."decided_by_name" IS NOT NULL
  AND u."username" = r."decided_by_name"
  AND r."decided_by_role" IS NULL;
