-- Refresh token families: every token one sign-in produces by rotation shares a familyId, so a
-- replayed token revokes that sign-in's tokens only. Tokens issued before this migration each
-- become a family of their own (their id), so the NOT NULL column needs no default.

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "familyId" TEXT;
UPDATE "refresh_tokens" SET "familyId" = "id";
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");
