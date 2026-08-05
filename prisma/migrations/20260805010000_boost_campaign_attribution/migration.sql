-- Ties orders back to the boosting campaign that brought them in, so a
-- campaign's spend can be read against the revenue and profit it produced.
--
-- Both columns are nullable with no backfill:
--   * BoostCampaign.channel narrows the ESTIMATE for orders nobody tagged
--     (campaign window + matching Order.source). Null = don't narrow, which
--     the campaign page admits to rather than hiding.
--   * Order.boostCampaignId is only ever set by hand, and ON DELETE SET NULL
--     keeps sales history intact when a campaign is removed.

-- AlterTable
ALTER TABLE "BoostCampaign" ADD COLUMN     "channel" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "boostCampaignId" TEXT;

-- CreateIndex
CREATE INDEX "Order_boostCampaignId_idx" ON "Order"("boostCampaignId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_boostCampaignId_fkey" FOREIGN KEY ("boostCampaignId") REFERENCES "BoostCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
