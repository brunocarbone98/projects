-- Refresh token families: every token one sign-in produces by rotation shares a familyId, so a
-- replayed token revokes that sign-in's tokens only. Tokens issued before this migration each
-- become a family of their own (their id).
--
-- The default gives the same to every token the previous release inserts: it knows no familyId,
-- and it keeps serving while the next release boots (start.sh migrates before the new API starts,
-- and Railway switches traffic only once the new release is healthy) and again after a rollback,
-- since migrations are never reverted. It is set in this migration's own transaction, so no insert
-- ever meets the NOT NULL column without it. gen_random_uuid() is built into PostgreSQL 13 and
-- later.

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "familyId" TEXT;
UPDATE "refresh_tokens" SET "familyId" = "id";
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET NOT NULL;
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET DEFAULT gen_random_uuid()::text;

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");
