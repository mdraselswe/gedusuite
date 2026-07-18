-- CreateEnum
CREATE TYPE "PartnerTxnType" AS ENUM ('INVESTMENT', 'EXPENSE', 'WITHDRAWAL', 'DEPOSIT_TO_TREASURY');

-- CreateEnum
CREATE TYPE "TreasuryDirection" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profitSharePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerTxn" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "type" "PartnerTxnType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "purpose" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "TreasuryDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "partnerId" TEXT,
    "partnerTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Partner_workspaceId_idx" ON "Partner"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_workspaceId_userId_key" ON "Partner"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "PartnerTxn_workspaceId_idx" ON "PartnerTxn"("workspaceId");

-- CreateIndex
CREATE INDEX "PartnerTxn_partnerId_idx" ON "PartnerTxn"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryEntry_partnerTxnId_key" ON "TreasuryEntry"("partnerTxnId");

-- CreateIndex
CREATE INDEX "TreasuryEntry_workspaceId_idx" ON "TreasuryEntry"("workspaceId");

-- CreateIndex
CREATE INDEX "TreasuryEntry_partnerId_idx" ON "TreasuryEntry"("partnerId");

-- AddForeignKey
ALTER TABLE "Partner" ADD CONSTRAINT "Partner_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Partner" ADD CONSTRAINT "Partner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerTxn" ADD CONSTRAINT "PartnerTxn_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerTxn" ADD CONSTRAINT "PartnerTxn_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryEntry" ADD CONSTRAINT "TreasuryEntry_partnerTxnId_fkey" FOREIGN KEY ("partnerTxnId") REFERENCES "PartnerTxn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
