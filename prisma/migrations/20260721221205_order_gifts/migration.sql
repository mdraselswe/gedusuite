-- CreateTable
CREATE TABLE "OrderGift" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productVariantId" TEXT,
    "label" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OrderGift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderGift_orderId_idx" ON "OrderGift"("orderId");

-- CreateIndex
CREATE INDEX "OrderGift_productVariantId_idx" ON "OrderGift"("productVariantId");

-- AddForeignKey
ALTER TABLE "OrderGift" ADD CONSTRAINT "OrderGift_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderGift" ADD CONSTRAINT "OrderGift_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

