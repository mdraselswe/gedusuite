-- Combo sets: a fixed group of products sold together at one price.
--
-- Nothing here stores stock. A combo's availability is derived from its
-- components every time it is asked for, because the same piece is on sale
-- twice — on its own and inside every combo containing it — and two numbers
-- for one shelf drift the moment either sells.
--
-- Orders carry no combo line either: a combo is expanded into ordinary
-- OrderItem rows at save time and tagged with comboSetId/comboKey, so stock
-- derivation, cost snapshots, returns and the profit reports keep working on
-- rows they already understand.

-- CreateTable
CREATE TABLE "ComboSet" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "freeDelivery" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "wooProductId" INTEGER,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComboSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComboItem" (
    "id" TEXT NOT NULL,
    "comboSetId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ComboItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComboSet_workspaceId_idx" ON "ComboSet"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ComboSet_workspaceId_wooProductId_key" ON "ComboSet"("workspaceId", "wooProductId");

-- CreateIndex
CREATE INDEX "ComboItem_comboSetId_idx" ON "ComboItem"("comboSetId");

-- CreateIndex
CREATE INDEX "ComboItem_productVariantId_idx" ON "ComboItem"("productVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ComboItem_comboSetId_productVariantId_key" ON "ComboItem"("comboSetId", "productVariantId");

-- AddForeignKey
ALTER TABLE "ComboSet" ADD CONSTRAINT "ComboSet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboItem" ADD CONSTRAINT "ComboItem_comboSetId_fkey" FOREIGN KEY ("comboSetId") REFERENCES "ComboSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboItem" ADD CONSTRAINT "ComboItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: which combo an order line came out of, and which instance of it.
-- Null on every ordinary line and on every order that predates combos.
ALTER TABLE "OrderItem" ADD COLUMN     "comboSetId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN     "comboKey" TEXT;

-- CreateIndex
CREATE INDEX "OrderItem_comboSetId_idx" ON "OrderItem"("comboSetId");
