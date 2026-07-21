-- AlterTable
ALTER TABLE "InternalPurchase" ADD COLUMN     "paidFromTreasury" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "paidFromTreasury" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TreasuryEntry" ADD COLUMN     "internalPurchaseId" TEXT,
ADD COLUMN     "purchaseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryEntry_purchaseId_key" ON "TreasuryEntry"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryEntry_internalPurchaseId_key" ON "TreasuryEntry"("internalPurchaseId");

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_internalPurchaseId_fkey" FOREIGN KEY ("internalPurchaseId") REFERENCES "InternalPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
