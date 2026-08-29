-- Links a variant to the same thing on the website, so a combo built here can
-- be pushed there as a recipe the shop can actually read.
ALTER TABLE "ProductVariant" ADD COLUMN "wooProductId" INTEGER;

CREATE INDEX "ProductVariant_wooProductId_idx" ON "ProductVariant"("wooProductId");
