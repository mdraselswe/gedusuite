-- AlterTable
ALTER TABLE "InternalPurchase" ADD COLUMN     "supplierId" TEXT;

-- CreateIndex
CREATE INDEX "InternalPurchase_supplierId_idx" ON "InternalPurchase"("supplierId");

-- AddForeignKey
ALTER TABLE "InternalPurchase" ADD CONSTRAINT "InternalPurchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

