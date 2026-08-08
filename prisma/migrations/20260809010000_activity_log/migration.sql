-- Who changed what, and when.
--
-- A multi-admin system without this can say what the numbers are and never why
-- they moved. An order's delivery cost is 115 today and was 65 yesterday, and
-- the only way to find out who typed it was to ask everybody. The PRD has
-- asked for an audit trail since v1.0 (§7).
--
-- actorMembershipId is nullable and ON DELETE SET NULL: removing somebody from
-- the workspace must not delete the record of what they did, and must not fail
-- because of it either. actorLabel carries their name at the time, so the
-- history still reads correctly once the membership is gone.
CREATE TYPE "ActivityAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorMembershipId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" "ActivityAction" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "summary" TEXT NOT NULL,
    -- { field: { from, to } }. Null on CREATE and DELETE, where the summary
    -- and the row itself are the whole story.
    "changes" JSONB,
    -- Groups the rows written by one user action: cancelling an order touches
    -- the order and its treasury entry, and the history shows one line that
    -- opens into both.
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- The activity page reads newest-first per workspace…
CREATE INDEX "ActivityLog_workspaceId_createdAt_idx" ON "ActivityLog"("workspaceId", "createdAt");
-- …and a record's own history reads one entity's rows.
CREATE INDEX "ActivityLog_workspaceId_entity_entityId_createdAt_idx" ON "ActivityLog"("workspaceId", "entity", "entityId", "createdAt");

ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorMembershipId_fkey"
    FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
