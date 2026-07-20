-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cashInTreasury" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TreasuryEntry" ADD COLUMN     "orderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryEntry_orderId_key" ON "TreasuryEntry"("orderId");

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

