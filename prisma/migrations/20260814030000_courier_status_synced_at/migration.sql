-- When this courier's in-flight parcels were last asked about.
--
-- Steadfast's webhook was built to push delivery status and, on this account,
-- has only ever pushed "in_review" — so the app fetches it instead. Vercel's
-- Hobby plan allows one cron run a day, which is too slow to be the only time
-- that happens, so the sales page runs the same sync when it is opened. This
-- column is what stops ten page views in a minute becoming ten rounds of API
-- calls, exactly as wooSyncState does for the call list.
ALTER TABLE "Courier" ADD COLUMN "statusSyncedAt" TIMESTAMP(3);
