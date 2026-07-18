-- CreateIndex
CREATE INDEX "InternalPurchase_workspaceId_date_idx" ON "InternalPurchase"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "Order_workspaceId_date_idx" ON "Order"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "PartnerTxn_workspaceId_date_idx" ON "PartnerTxn"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "Purchase_workspaceId_date_idx" ON "Purchase"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "StockAdjustment_workspaceId_date_idx" ON "StockAdjustment"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "TreasuryEntry_workspaceId_date_idx" ON "TreasuryEntry"("workspaceId", "date");
