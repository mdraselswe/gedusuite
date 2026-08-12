-- Whether a record's `date` carries a real time of day, or only a day.
--
-- The forms ask for a date AND a time now, so what gets stored is the moment the
-- sale was made or the money moved. Everything entered before that holds midnight
-- UTC and has no time in it, and the time worth showing for those rows is when
-- they were entered — which lib/dhaka-time reads off `createdAt`.
--
-- The reason this is a column rather than a test on the timestamp: 6 AM in Dhaka
-- IS midnight UTC, so a sale deliberately timed at 6 AM is indistinguishable from
-- a row that never had a time at all. One minute of the day would have read wrong,
-- every day, with nothing in the data able to say which was meant.
ALTER TABLE "Order" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Purchase" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InternalPurchase" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TreasuryEntry" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PartnerTxn" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StockAdjustment" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BoostDailySpend" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProfitDistribution" ADD COLUMN "dateHasTime" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from what the stored timestamps already say, so nothing on screen
-- changes for an existing row. A value that isn't midnight UTC was written by the
-- app itself with a real instant — the treasury entry a paid order creates, cash
-- handed to a member — and those rows have shown their own time all along. A value
-- that IS midnight came from a date picker and never had one.
--
-- date_trunc runs in the column's own terms, which is UTC: Prisma stores
-- timestamp(3) without a zone. Idempotent, and false is already the default, so
-- only the "has a time" side needs writing.
UPDATE "Order" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
UPDATE "Purchase" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
UPDATE "InternalPurchase" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
UPDATE "TreasuryEntry" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
UPDATE "PartnerTxn" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
UPDATE "StockAdjustment" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
UPDATE "BoostDailySpend" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
UPDATE "ProfitDistribution" SET "dateHasTime" = true WHERE "date" <> date_trunc('day', "date");
