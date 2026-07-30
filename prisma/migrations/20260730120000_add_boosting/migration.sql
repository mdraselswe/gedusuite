-- CreateEnum
CREATE TYPE "BoostStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "BoostCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "status" "BoostStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoostCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoostAdSet" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "budget" DECIMAL(12,2),
    "status" "BoostStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoostAdSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoostDailySpend" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adSetId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoostDailySpend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoostCampaign_workspaceId_idx" ON "BoostCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "BoostAdSet_workspaceId_idx" ON "BoostAdSet"("workspaceId");

-- CreateIndex
CREATE INDEX "BoostAdSet_campaignId_idx" ON "BoostAdSet"("campaignId");

-- CreateIndex
CREATE INDEX "BoostDailySpend_workspaceId_idx" ON "BoostDailySpend"("workspaceId");

-- CreateIndex
CREATE INDEX "BoostDailySpend_workspaceId_date_idx" ON "BoostDailySpend"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BoostDailySpend_adSetId_date_key" ON "BoostDailySpend"("adSetId", "date");

-- AddForeignKey
ALTER TABLE "BoostCampaign" ADD CONSTRAINT "BoostCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoostAdSet" ADD CONSTRAINT "BoostAdSet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoostAdSet" ADD CONSTRAINT "BoostAdSet_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BoostCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoostDailySpend" ADD CONSTRAINT "BoostDailySpend_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoostDailySpend" ADD CONSTRAINT "BoostDailySpend_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "BoostAdSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

