-- Where this particular parcel went, as agreed when the order was taken.
--
-- Nullable and unbackfilled on purpose: an existing order has no recorded
-- delivery address of its own, and inventing one from the customer record now
-- would freeze today's address onto orders that shipped months ago. Null means
-- "read the customer record", which is what every document already did.
ALTER TABLE "Order" ADD COLUMN "shipName" TEXT;
ALTER TABLE "Order" ADD COLUMN "shipPhone" TEXT;
ALTER TABLE "Order" ADD COLUMN "shipAddress" TEXT;
