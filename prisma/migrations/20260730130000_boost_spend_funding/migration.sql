-- AlterTable
ALTER TABLE "BoostDailySpend" ADD COLUMN     "paidByPartnerId" TEXT,
ADD COLUMN     "paidFromTreasury" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TreasuryEntry" ADD COLUMN     "boostSpendId" TEXT;

-- CreateIndex
CREATE INDEX "BoostDailySpend_paidByPartnerId_idx" ON "BoostDailySpend"("paidByPartnerId");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryEntry_boostSpendId_key" ON "TreasuryEntry"("boostSpendId");

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_boostSpendId_fkey" FOREIGN KEY ("boostSpendId") REFERENCES "BoostDailySpend"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoostDailySpend" ADD CONSTRAINT "BoostDailySpend_paidByPartnerId_fkey" FOREIGN KEY ("paidByPartnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

