-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('OFFICE_SUPPLIES', 'PACKAGING_MATERIAL', 'EQUIPMENT', 'UTILITIES', 'OTHER');

-- CreateTable
CREATE TABLE "InternalPurchase" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "description" TEXT,
    "supplierName" TEXT,
    "cost" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'OTHER',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InternalPurchase_workspaceId_idx" ON "InternalPurchase"("workspaceId");

-- AddForeignKey
ALTER TABLE "InternalPurchase" ADD CONSTRAINT "InternalPurchase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
