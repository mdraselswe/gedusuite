-- AlterTable
ALTER TABLE "InternalPurchase" ADD COLUMN     "paidByPartnerId" TEXT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "paidByPartnerId" TEXT;

-- CreateIndex
CREATE INDEX "InternalPurchase_paidByPartnerId_idx" ON "InternalPurchase"("paidByPartnerId");

-- CreateIndex
CREATE INDEX "Purchase_paidByPartnerId_idx" ON "Purchase"("paidByPartnerId");

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_paidByPartnerId_fkey" FOREIGN KEY ("paidByPartnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalPurchase" ADD CONSTRAINT "InternalPurchase_paidByPartnerId_fkey" FOREIGN KEY ("paidByPartnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
