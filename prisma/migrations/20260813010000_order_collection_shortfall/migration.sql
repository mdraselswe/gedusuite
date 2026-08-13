-- Money the customer paid that never reached the business.
--
-- A rider entered 900 into the courier's app against a 960 invoice and kept the
-- difference as a tip. The customer owes nothing, the courier will remit on 900,
-- and until now there was nowhere to say so: the order insisted on 960, the
-- courier balance expected 60 more than Steadfast would ever hand over, and the
-- only tools to hand were a discount the shop never gave or a partial payment
-- the customer never owes.
--
-- The shortfall, not the collected figure. The invoice moves — a return a week
-- later would leave a stored 900 short of nothing at all — while the 60 someone
-- walked off with stays true about that delivery.
--
-- Defaults to zero, so every existing order means what it has always meant.
ALTER TABLE "Order" ADD COLUMN "collectionShortfall" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "collectionNote" TEXT;
