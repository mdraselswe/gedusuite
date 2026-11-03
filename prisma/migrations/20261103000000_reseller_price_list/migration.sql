-- Reseller price list: the shop's settings and Google Sheet link, plus the
-- per-variant exceptions. Additive only.
CREATE TABLE "ResellerPriceList" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Reseller price list',
    "tiers" JSONB NOT NULL DEFAULT '[{"minQty":1,"discountPct":10},{"minQty":5,"discountPct":15},{"minQty":10,"discountPct":20}]',
    "minMarginPct" DECIMAL(6,2) NOT NULL DEFAULT 10,
    "roundTo" INTEGER NOT NULL DEFAULT 5,
    "notes" TEXT,
    "googleEmail" TEXT,
    "googleAccessToken" TEXT,
    "googleRefreshToken" TEXT,
    "googleExpiryDate" BIGINT,
    "sheetId" TEXT,
    "viewers" JSONB NOT NULL DEFAULT '[]',
    "publicLink" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "syncLockedUntil" TIMESTAMP(3),
    "syncPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResellerPriceList_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResellerVariantPrice" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "prices" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ResellerVariantPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResellerPriceList_workspaceId_key" ON "ResellerPriceList"("workspaceId");
CREATE UNIQUE INDEX "ResellerVariantPrice_productVariantId_key" ON "ResellerVariantPrice"("productVariantId");
CREATE INDEX "ResellerVariantPrice_workspaceId_idx" ON "ResellerVariantPrice"("workspaceId");

ALTER TABLE "ResellerPriceList" ADD CONSTRAINT "ResellerPriceList_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResellerVariantPrice" ADD CONSTRAINT "ResellerVariantPrice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResellerVariantPrice" ADD CONSTRAINT "ResellerVariantPrice_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
