/**
 * One-off: put Steadfast's real price list into the app, and correct the two
 * parcels that were priced by the old one.
 *
 * Every number here was read off Steadfast's own "Delivered Parcels" list, not
 * guessed:
 *
 *   0.10kg Dhaka → 55      0.40kg Dhaka → 65      0.10kg outside → 115
 *   0.15kg Dhaka → 55      0.50kg Dhaka → 65      0.80kg outside → 135
 *
 * So Dhaka is priced in two steps and the outside rate covers half a kilo, not
 * the whole one the app had. The threshold between 55 and 65 is somewhere
 * between 0.15 and 0.40 — 0.25 is the midpoint, and a lighter parcel arriving
 * later is what will pin it exactly.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/apply-steadfast-rates.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/apply-steadfast-rates.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
const n = (v) => (v == null ? 0 : Number(v));

/** Weight steps per zone name, as Steadfast bills this shop. */
const BANDS = {
  "Dhaka City": [
    { uptoKg: 0.25, rate: 55 },
    { uptoKg: 0.5, rate: 65 },
  ],
  "Outside Dhaka": [{ uptoKg: 0.5, rate: 115 }],
};

/** Parcels the old rules priced wrong, and the consignment id typed wrong. */
const ORDER_FIXES = [
  {
    find: { tracking: "282716647" },
    who: "Rubina Akter",
    // 230 COD, 0.15kg, Dhaka: Steadfast charged 55, the app booked 65. The COD
    // fee follows it — 1% of what is left after the courier's own charge.
    //
    // The weight goes in too, and it is the part that makes this stick: an
    // unweighed parcel is quoted at the heaviest band, so the next edit of this
    // order would re-quote it straight back to 65.
    set: { deliveryCost: 55, codFeeCost: 1.75, weightKg: 0.15 },
    why: "Steadfast billed 55 for a 0.15kg Dhaka parcel, not 65",
  },
];

async function main() {
  const courier = await prisma.courier.findFirst({
    where: { name: "Steadfast" },
    include: { zones: { include: { bands: true } } },
  });
  if (!courier) throw new Error("no Steadfast courier row");
  const workspaceId = courier.workspaceId;

  console.log(APPLY ? "APPLYING" : "DRY RUN — nothing is written\n");

  // 1. Half a kilo, not a whole one.
  console.log(`baseWeightKg: ${n(courier.baseWeightKg)} -> 0.5`);
  if (APPLY) {
    await prisma.courier.update({ where: { id: courier.id }, data: { baseWeightKg: 0.5 } });
  }

  // 2. The weight steps.
  for (const zone of courier.zones) {
    const want = BANDS[zone.name];
    if (!want) {
      console.log(`zone "${zone.name}": no steps defined here — left alone`);
      continue;
    }
    const had = zone.bands.map((b) => `${n(b.uptoKg)}kg=${n(b.rate)}`).join(", ") || "none";
    const now = want.map((b) => `${b.uptoKg}kg=${b.rate}`).join(", ");
    console.log(`zone "${zone.name}": [${had}] -> [${now}]`);
    if (APPLY) {
      await prisma.courierRateBand.deleteMany({ where: { zoneId: zone.id } });
      await prisma.courierRateBand.createMany({
        data: want.map((b) => ({ workspaceId, zoneId: zone.id, uptoKg: b.uptoKg, rate: b.rate })),
      });
    }
  }

  // 3. The two parcels.
  for (const fix of ORDER_FIXES) {
    const order = await prisma.order.findFirst({
      where: { workspaceId, courierTrackingId: fix.find.tracking },
      include: { customer: { select: { name: true } } },
    });
    if (!order) {
      console.log(`! ${fix.who}: no order with consignment ${fix.find.tracking} — skipped`);
      continue;
    }
    const before = Object.fromEntries(
      Object.keys(fix.set).map((k) => [k, order[k] == null ? null : String(order[k])]),
    );
    console.log(
      `${fix.who} (${order.customer?.name}): ${JSON.stringify(before)} -> ${JSON.stringify(fix.set)}  — ${fix.why}`,
    );
    if (APPLY) {
      await prisma.order.update({ where: { id: order.id }, data: fix.set });
      // The app records every change a person makes; a change made by a script
      // that nobody can see afterwards is worse than the error it fixed.
      await prisma.activityLog.create({
        data: {
          workspaceId,
          actorLabel: "Steadfast reconciliation",
          action: "UPDATE",
          entity: "Order",
          entityId: order.id,
          entityLabel: `#${order.id.slice(-8).toUpperCase()} · ${order.customer?.name ?? "Walk-in"}`,
          summary: fix.why,
          changes: Object.fromEntries(
            Object.entries(fix.set).map(([k, to]) => [k, { from: before[k], to: String(to) }]),
          ),
        },
      });
    }
  }

  console.log(APPLY ? "\nDone." : "\nRe-run with --apply to write.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
