-- The release before refresh token families inserts refresh tokens without a familyId. It keeps
-- serving while the next release boots (start.sh migrates before the new API starts, and Railway
-- switches traffic only once the new release is healthy), and it serves again after a rollback,
-- since migrations are never reverted. With this default each token it issues becomes a family of
-- its own, as the tokens issued before the families did, instead of failing every sign-in and
-- refresh. gen_random_uuid() is built into PostgreSQL 13 and later.

-- AlterTable
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET DEFAULT gen_random_uuid()::text;
