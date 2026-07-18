-- Make block_change_requests.organization_id nullable.
--
-- Rationale: the column was originally NOT NULL, which made the POST
-- /api/block-change-requests endpoint fail with "invalid input syntax for
-- type uuid: ''" whenever the requester had no organization — as is the
-- case for SUPER_ADMIN (GLOBAL scope) or any global-scope user. The service
-- now prefers the filter's own organizationId and falls back to the
-- requester's; if neither is set, the column is stored as NULL.
-- This is a safe, purely additive change.

ALTER TABLE "block_change_requests" ALTER COLUMN "organization_id" DROP NOT NULL;
