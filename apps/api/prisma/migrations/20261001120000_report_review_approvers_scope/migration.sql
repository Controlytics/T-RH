-- Report reviews: the approver SET and the instruments a request covers,
-- FROZEN on the record (2026-10-01).
--
--   report_reviews.approver_roles     every role whose holders may approve it
--   report_reviews.approver_user_ids  every user named outright who may approve it
--   report_reviews.instrument_ids     the instruments the report is about
--
-- Operator: "per user or per role option should be removed in request place
-- and add that in configuration"; several roles and/or users, any of them may
-- approve. The set is copied from Configuration -> Report Approvers at the
-- moment of the request, so a later configuration change never re-routes a
-- pending request ("existing requests keep their assignee" - operator, yes).
--
-- And: "which are assigned to role or user for that users only assigned
-- instruments report requests should come". A request is visible only to users
-- whose instrument scope covers ANY of `instrument_ids`; an empty list (the
-- Audit Trail PDF, which is about no instrument) is not scope-restricted. IDS,
-- not codes: an instrument's code has been changeable since 2026-09-16.
--
-- BACKFILL, recorded as the data step it is:
--  * approver_roles / approver_user_ids take the row's single assignee, so
--    every reader reads ONE shape. assignee_role / assignee_user_id are left
--    untouched (they are what was recorded) and are no longer written.
--  * instrument_ids is resolved from request_meta.instrumentCodes by code,
--    case-insensitively, against today's instruments - best effort: a code
--    renamed since the request matches nothing, and that row then reads as
--    unscoped. 3 rows existed locally when this was written, all resolvable.
--
-- HAND-AUTHORED; `prisma migrate diff` also emits DROP TABLE
-- "instrument_telemetry_history", stripped as in every migration since
-- 2026-08-08 (see apps/api/src/lib/migration-guard.ts).

ALTER TABLE "report_reviews" ADD COLUMN "approver_roles" VARCHAR(50)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(50)[];
ALTER TABLE "report_reviews" ADD COLUMN "approver_user_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "report_reviews" ADD COLUMN "instrument_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "report_reviews" SET "approver_roles" = ARRAY["assignee_role"]::VARCHAR(50)[] WHERE "assignee_role" IS NOT NULL;
UPDATE "report_reviews" SET "approver_user_ids" = ARRAY["assignee_user_id"] WHERE "assignee_user_id" IS NOT NULL;

UPDATE "report_reviews" r
SET "instrument_ids" = sub.ids
FROM (
  SELECT r2."id", ARRAY_AGG(DISTINCT i."id") AS ids
  FROM "report_reviews" r2
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(r2."request_meta"->'instrumentCodes') = 'array' THEN r2."request_meta"->'instrumentCodes' ELSE '[]'::jsonb END
  ) AS c(code)
  JOIN "instruments" i ON LOWER(i."code") = LOWER(c.code)
  GROUP BY r2."id"
) sub
WHERE r."id" = sub."id";

CREATE INDEX "report_reviews_approver_roles_idx" ON "report_reviews" USING GIN ("approver_roles");
CREATE INDEX "report_reviews_instrument_ids_idx" ON "report_reviews" USING GIN ("instrument_ids");
