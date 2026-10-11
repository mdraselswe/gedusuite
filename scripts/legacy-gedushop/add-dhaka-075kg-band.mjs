/**
 * One-off: the Dhaka band above half a kilo, and the parcel that revealed it.
 *
 * Steadfast charged 75 for a 0.7kg Dhaka parcel. This app's rules said 85 —
 * the 65 band plus a started kilo at the courier's 20 — so the over-weight
 * rule was wrong, and wrong in the direction that hides: it had quoted 65 for
 * the same parcel while no weight was on it, which made the order look ten
 * taka better than it was.
 *
 * Every inside-Dhaka charge seen on this account so far:
 *
 *   0.15kg → 55   0.30kg → 65   0.70kg → 75
 *   0.20kg → 55   0.40kg → 65
 *                 0.50kg → 65
 *
 * — steps of 10 every quarter kilo. So the next band is 0.75kg at 75.
 *
 * ONE data point above half a kilo, which is not enough to know whether the
 * step is 0.25kg or 0.5kg wide: a 1kg band at 75 fits it just as well. The
 * narrower band is chosen deliberately, because the two disagree only about
 * parcels between 0.75 and 1kg, and there the narrow reading quotes 95 where
 * the wide one quotes 75. Over-quoting a parcel is a visible surprise on the
 * next payout; under-quoting it is an order that looks more profitable than it
 * was, which is the error nobody goes looking for.
 *
 * Left alone: extraKgRate, and the other two zones. Nothing has yet been
 * shipped over half a kilo outside Dhaka, and inventing that row from this one
 * would be the same guess that put 20 there in the first place. Worth getting
 * the negotiated rate sheet from Steadfast and typing it in whole.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/add-dhaka-075kg-band.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/add-dhaka-075kg-band.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

const ZONE = "Dhaka City";
const BAND = { uptoKg: 0.75, rate: 75 };
/** The parcel this was read off, so re-quoting it lands on 75 rather than 65. */
const WEIGH = { tracking: "283640539", weightKg: 0.7 };

async function main() {
  const slugArg = process.argv.find((a) => a.startsWith("--slug="));
  const slug = slugArg ? slugArg.slice("--slug=".length) : "gedushop";
  const ws = await prisma.workspace.findFirst({ where: { slug } });
  if (!ws) throw new Error(`No workspace "${slug}"`);

  const zone = await prisma.courierZone.findFirst({
    where: { workspaceId: ws.id, name: ZONE, courier: { name: "Steadfast" } },
    include: { bands: { orderBy: { uptoKg: "asc" } } },
  });
  if (!zone) throw new Error(`No zone "${ZONE}"`);

  console.log(`Workspace ${slug} — ${APPLY ? "APPLYING" : "dry run"}\n`);
  console.log(
    `${ZONE} bands now: ${zone.bands.map((b) => `≤${b.uptoKg}kg ৳${b.rate}`).join(", ")}`,
  );

  const already = zone.bands.find((b) => Number(b.uptoKg) === BAND.uptoKg);
  if (already) {
    console.log(`band ≤${BAND.uptoKg}kg already exists at ৳${already.rate}`);
  } else {
    console.log(`band + ≤${BAND.uptoKg}kg ৳${BAND.rate}`);
    if (APPLY) {
      await prisma.courierRateBand.create({
        data: { workspaceId: ws.id, zoneId: zone.id, uptoKg: BAND.uptoKg, rate: BAND.rate },
      });
    }
  }

  const order = await prisma.order.findFirst({
    where: { workspaceId: ws.id, courierTrackingId: WEIGH.tracking },
    select: { id: true, weightKg: true, deliveryCost: true, customer: { select: { name: true } } },
  });
  if (!order) {
    console.log(`!! ${WEIGH.tracking} not found`);
  } else {
    console.log(
      `${WEIGH.tracking} ${order.customer?.name}: weight ${order.weightKg ?? "—"} → ${WEIGH.weightKg}` +
        ` (cost already ৳${order.deliveryCost}, which this band now re-quotes to)`,
    );
    if (APPLY) {
      await prisma.order.update({ where: { id: order.id }, data: { weightKg: WEIGH.weightKg } });
    }
  }

  console.log(APPLY ? "\nDone." : "\nDry run — nothing written. Re-run with --apply.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
