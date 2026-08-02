-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('NOT_CALLED', 'NO_ANSWER', 'PHONE_OFF', 'WRONG_NUMBER', 'CALL_LATER', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OrderLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'WOOCOMMERCE',
    "externalId" TEXT NOT NULL,
    "orderNo" TEXT,
    "rawPayload" JSONB,
    "customerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "altPhone" TEXT,
    "address" TEXT,
    "itemsText" TEXT NOT NULL DEFAULT '',
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "callStatus" "CallStatus" NOT NULL DEFAULT 'NOT_CALLED',
    "callAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastCalledAt" TIMESTAMP(3),
    "calledByName" TEXT,
    "customerAdvice" TEXT,
    "internalNote" TEXT,
    "convertedCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderLead_workspaceId_callStatus_idx" ON "OrderLead"("workspaceId", "callStatus");

-- CreateIndex
CREATE INDEX "OrderLead_workspaceId_orderedAt_idx" ON "OrderLead"("workspaceId", "orderedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLead_workspaceId_source_externalId_key" ON "OrderLead"("workspaceId", "source", "externalId");

-- AddForeignKey
ALTER TABLE "OrderLead" ADD CONSTRAINT "OrderLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

