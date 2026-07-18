-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('SELF', 'COURIER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BKASH', 'NAGAD', 'COURIER_COLLECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'UNPAID', 'PARTIAL');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryType" "DeliveryType" NOT NULL DEFAULT 'SELF',
    "deliveryCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "packagingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "giftCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "heldByMembershipId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Return" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "refundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Return_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_workspaceId_idx" ON "Customer"("workspaceId");

-- CreateIndex
CREATE INDEX "Order_workspaceId_idx" ON "Order"("workspaceId");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productVariantId_idx" ON "OrderItem"("productVariantId");

-- CreateIndex
CREATE INDEX "Return_workspaceId_idx" ON "Return"("workspaceId");

-- CreateIndex
CREATE INDEX "Return_orderItemId_idx" ON "Return"("orderItemId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_heldByMembershipId_fkey" FOREIGN KEY ("heldByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
