-- Links a partner-funded purchase to the INVESTMENT credit that mirrors it,
-- so the credit is derived from the purchase instead of typed in by hand.
-- Deliberately NOT backfilled: manual credits already exist for some of these
-- rows and generating a second one would double-count. The reconcile screen
-- adopts or generates them one by one instead.

-- AlterTable
ALTER TABLE "PartnerTxn" ADD COLUMN     "internalPurchaseId" TEXT,
ADD COLUMN     "purchaseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTxn_purchaseId_key" ON "PartnerTxn"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTxn_internalPurchaseId_key" ON "PartnerTxn"("internalPurchaseId");

-- AddForeignKey
ALTER TABLE "PartnerTxn" ADD CONSTRAINT "PartnerTxn_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerTxn" ADD CONSTRAINT "PartnerTxn_internalPurchaseId_fkey" FOREIGN KEY ("internalPurchaseId") REFERENCES "InternalPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
