-- Make users.email optional (no longer mandatory at user creation / contact-admin
-- create-user requests). The @unique index is retained; Postgres treats NULLs as
-- distinct, so multiple users may have a NULL email.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
