-- CreateEnum
CREATE TYPE "StockAdjustmentType" AS ENUM ('DAMAGED', 'LOST', 'GIFT', 'CORRECTION');

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "type" "StockAdjustmentType" NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockAdjustment_workspaceId_idx" ON "StockAdjustment"("workspaceId");

-- CreateIndex
CREATE INDEX "StockAdjustment_productVariantId_idx" ON "StockAdjustment"("productVariantId");

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
