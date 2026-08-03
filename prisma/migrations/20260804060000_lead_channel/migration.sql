-- Which channel a call-list lead came through, separate from `source`, which
-- records how the row arrived and is half of the (workspace, source,
-- externalId) unique key the WooCommerce webhook relies on.
--
-- Nullable with no default and no backfill: an untagged lead should read as
-- "Not set" rather than silently claim a channel nobody chose.

-- AlterTable
ALTER TABLE "OrderLead" ADD COLUMN     "channel" TEXT;
