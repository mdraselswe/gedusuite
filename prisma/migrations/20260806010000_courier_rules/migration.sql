-- Courier pricing as data rather than code.
--
-- The delivery cost of an order was two hand-typed numbers: what the customer
-- paid and what the courier charged. That misses the courier's percentage fee
-- entirely — Steadfast takes 1% of what it hands over, so a 960 parcel costs
-- 123.45, not the 115 anyone would have written down. Every courier order was
-- reporting a few taka of profit that was actually a loss.
--
-- Rules live per workspace because published rates and negotiated rates are
-- different numbers, and per courier because the next company will not price
-- the same way. codFeeBase is the field that makes the difference portable:
-- some charge the percentage on the whole COD, some on what's left after
-- their own delivery charge.

-- CreateEnum
CREATE TYPE "CodFeeBase" AS ENUM ('GROSS', 'NET');

-- CreateEnum
CREATE TYPE "ReturnChargeType" AS ENUM ('NONE', 'FLAT', 'PERCENT_OF_DELIVERY');

-- CreateTable
CREATE TABLE "Courier" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "baseWeightKg" DECIMAL(6,3) NOT NULL DEFAULT 1,
    "extraKgRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "codFeePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "codFeeBase" "CodFeeBase" NOT NULL DEFAULT 'NET',
    "returnChargeType" "ReturnChargeType" NOT NULL DEFAULT 'NONE',
    "returnChargeValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Courier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierZone" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CourierZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Courier_workspaceId_idx" ON "Courier"("workspaceId");

-- CreateIndex
CREATE INDEX "CourierZone_courierId_idx" ON "CourierZone"("courierId");

-- CreateIndex
CREATE INDEX "CourierZone_workspaceId_idx" ON "CourierZone"("workspaceId");

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "courierId" TEXT,
ADD COLUMN     "courierZoneId" TEXT,
ADD COLUMN     "weightKg" DECIMAL(6,3),
ADD COLUMN     "codFeeCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
-- A partial delivery collects money on an order that is then cancelled: the
-- customer paid the shipping and refused the goods. Recorded so the
-- cancellation shows its real cost instead of the whole delivery charge.
ADD COLUMN     "cancelledCollected" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Shipping weight of one piece, so the courier quote can charge for the kilos
-- above its base weight instead of assuming every parcel is light.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "weightGrams" INTEGER;

-- CreateIndex
CREATE INDEX "Order_courierId_idx" ON "Order"("courierId");

-- AddForeignKey
ALTER TABLE "Courier" ADD CONSTRAINT "Courier_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierZone" ADD CONSTRAINT "CourierZone_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierZone" ADD CONSTRAINT "CourierZone_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL: losing a courier must never take sales history with it.
-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_courierZoneId_fkey" FOREIGN KEY ("courierZoneId") REFERENCES "CourierZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
