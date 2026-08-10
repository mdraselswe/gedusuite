-- What a call-list order agreed for delivery, separate from the goods.
-- Defaults to 0: existing leads carry a grand total with no breakdown behind
-- it, and inventing a split now would be a guess.
ALTER TABLE "OrderLead" ADD COLUMN "deliveryCharge" DECIMAL(12,2) NOT NULL DEFAULT 0;
