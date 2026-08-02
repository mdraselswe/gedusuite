-- CreateTable
CREATE TABLE "WooSyncState" (
    "workspaceId" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastResult" TEXT,

    CONSTRAINT "WooSyncState_pkey" PRIMARY KEY ("workspaceId")
);

