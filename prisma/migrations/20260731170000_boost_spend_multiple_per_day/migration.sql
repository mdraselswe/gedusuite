-- Facebook charges a card multiple times per day (per billing threshold), so
-- the one-entry-per-day uniqueness was wrong. Keep a plain index for lookups.
DROP INDEX "BoostDailySpend_adSetId_date_key";
CREATE INDEX "BoostDailySpend_adSetId_date_idx" ON "BoostDailySpend"("adSetId", "date");
