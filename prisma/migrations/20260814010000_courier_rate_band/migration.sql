-- Weight steps in a zone's price list.
--
-- Steadfast charges this shop 55 for a 0.15kg Dhaka parcel and 65 for a 0.5kg
-- one. `baseWeightKg` + `extraKgRate` cannot say that: the pair only ever adds
-- money above an included weight, never takes it off below one. So every light
-- parcel was quoted 10 too high, and the courier balance carried the difference
-- as a gap nobody could name.
--
-- The same shape also fixes the other end. A 0.8kg parcel outside Dhaka costs
-- 135 — 115 for the first half kilo and 20 for the rest — which the old model
-- quoted as 115 flat, because its included weight was set to a whole kilo.
--
-- Purely additive: a zone with no bands prices exactly as it did.
CREATE TABLE "CourierRateBand" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "uptoKg" DECIMAL(6,3) NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "CourierRateBand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourierRateBand_zoneId_idx" ON "CourierRateBand"("zoneId");
CREATE INDEX "CourierRateBand_workspaceId_idx" ON "CourierRateBand"("workspaceId");

ALTER TABLE "CourierRateBand" ADD CONSTRAINT "CourierRateBand_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourierRateBand" ADD CONSTRAINT "CourierRateBand_zoneId_fkey"
    FOREIGN KEY ("zoneId") REFERENCES "CourierZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
