-- AlterTable
ALTER TABLE "UserGoogleConnection" ADD COLUMN     "workspaceId" TEXT;

-- AddForeignKey
ALTER TABLE "UserGoogleConnection" ADD CONSTRAINT "UserGoogleConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: for any existing personal connection with no workspaceId, infer it from
-- the connected user's first membership so the auto-sync cron has somewhere to sync.
UPDATE "UserGoogleConnection" c
SET "workspaceId" = m."workspaceId"
FROM (
  SELECT DISTINCT ON ("userId") "userId", "workspaceId"
  FROM "Membership"
  ORDER BY "userId", "createdAt" ASC
) m
WHERE c."userId" = m."userId" AND c."workspaceId" IS NULL;
