-- AlterTable
ALTER TABLE "PartnerTxn" ADD COLUMN     "boostSpendId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTxn_boostSpendId_key" ON "PartnerTxn"("boostSpendId");

-- AddForeignKey
ALTER TABLE "PartnerTxn" ADD CONSTRAINT "PartnerTxn_boostSpendId_fkey" FOREIGN KEY ("boostSpendId") REFERENCES "BoostDailySpend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

