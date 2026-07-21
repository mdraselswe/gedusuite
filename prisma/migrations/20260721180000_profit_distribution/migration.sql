-- AlterTable
ALTER TABLE "PartnerTxn" ADD COLUMN     "distributionId" TEXT;

-- AlterTable
ALTER TABLE "TreasuryEntry" ADD COLUMN     "distributionId" TEXT;

-- CreateTable
CREATE TABLE "ProfitDistribution" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfitDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfitDistribution_workspaceId_idx" ON "ProfitDistribution"("workspaceId");

-- CreateIndex
CREATE INDEX "ProfitDistribution_workspaceId_date_idx" ON "ProfitDistribution"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "PartnerTxn_distributionId_idx" ON "PartnerTxn"("distributionId");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryEntry_distributionId_key" ON "TreasuryEntry"("distributionId");

-- AddForeignKey
ALTER TABLE "PartnerTxn" ADD CONSTRAINT "PartnerTxn_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "ProfitDistribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "ProfitDistribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfitDistribution" ADD CONSTRAINT "ProfitDistribution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
