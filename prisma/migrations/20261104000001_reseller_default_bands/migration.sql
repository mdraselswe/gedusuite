-- New default bands: one piece −5%, 2–5 −15%, 6+ −20%. A single piece should
-- not be cheap enough to tempt anyone into posing as a reseller.
ALTER TABLE "ResellerPriceList" ALTER COLUMN "tiers" SET DEFAULT '[{"minQty":1,"discountPct":5},{"minQty":2,"discountPct":15},{"minQty":6,"discountPct":20}]';

-- Lists still on the old defaults move with them; lists the shop changed stay.
UPDATE "ResellerPriceList"
SET "tiers" = '[{"minQty":1,"discountPct":5},{"minQty":2,"discountPct":15},{"minQty":6,"discountPct":20}]'::jsonb
WHERE "tiers" = '[{"minQty":1,"discountPct":10},{"minQty":5,"discountPct":15},{"minQty":10,"discountPct":20}]'::jsonb;
