-- Spread an internal purchase's cost across the months it covers.
--
-- Nullable with no default and no backfill: every existing row keeps being
-- charged in full on its own date, exactly as before. Only a row somebody
-- explicitly sets a value on changes behaviour.
ALTER TABLE "InternalPurchase" ADD COLUMN "spreadMonths" INTEGER;
