/**
 * One-off: the two parcels behind the 49 taka the courier page was out by.
 *
 * Both read off Steadfast's own Parcels screen, and together they account for
 * the gap exactly — 5,700 collected less 590 of delivery bills is 5,110, and
 * 1% of that rounded is 51, which is the 5,059 Steadfast's balance shows.
 *
 * 284016722 goes to Keraniganj, which is Steadfast's sub-urban rate at 105.
 * The order was booked on the 15th and the sub-urban zone did not exist in
 * this app until the 16th, so there was no right answer on the dropdown at the
 * time — this is the same missing zone that had a Savar parcel paying 115.
 *
 * 283640539 is the two-item parcel, and Steadfast weighed it and charged 75
 * against the 65 this app quoted. Only the cost is corrected here: what the
 * over-weight rule actually is needs the weight off the app, and guessing a
 * rate table from one parcel is how the wrong rule gets in.
 *
 * What the customer paid is left alone. 284016722 charged 80 for delivery and
 * it cost 105, and that 25 taka loss is a fact about the order, not a typo.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/fix-suburban-and-overweight-parcels.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/fix-suburban-and-overweight-parcels.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const n = (v) => (v == null ? 0 : Number(v));

/** What Steadfast's app shows against each, and the zone that explains it. */
const CORRECTIONS = [
  { tracking: "284016722", who: "আমাতুর রহমান মারিয়াম", zone: "Dhaka Sub-urban", deliveryCost: 105 },
  { tracking: "283640539", who: "Masud Kaisar", zone: null, deliveryCost: 75 },
];

/**
 * The invoice the courier collected against — computeOrderTotals' own
 * `invoicedTotal`, before any return, since the courier took its cut at the
 * door on the day.
 */
function invoicedTotal(order) {
  const goods = order.items.reduce(
    (s, i) => s + n(i.unitPrice) * i.quantity - n(i.discount),
    0,
  );
  return round2(goods - n(order.discount) + n(order.deliveryCharge));
}

async function main() {
  const slugArg = process.argv.find((a) => a.startsWith("--slug="));
  const slug = slugArg ? slugArg.slice("--slug=".length) : "gedushop";
  const ws = await prisma.workspace.findFirst({ where: { slug } });
  if (!ws) throw new Error(`No workspace "${slug}"`);

  const courier = await prisma.courier.findFirst({
    where: { workspaceId: ws.id, name: "Steadfast" },
    include: { zones: true },
  });
  if (!courier) throw new Error("No Steadfast courier");
  const pct = Number(courier.codFeePercent);

  console.log(`Workspace ${slug} — ${APPLY ? "APPLYING" : "dry run"}\n`);

  for (const fix of CORRECTIONS) {
    const order = await prisma.order.findFirst({
      where: { workspaceId: ws.id, courierTrackingId: fix.tracking },
      include: { treasuryEntry: true, items: true, customer: { select: { name: true } } },
    });
    if (!order) {
      console.log(`!! ${fix.tracking} not found — skipped`);
      continue;
    }
    // Refused rather than handled: an order whose cash is already banked needs
    // its treasury entry recomputed alongside, and doing that silently inside
    // a one-off is how a ledger stops matching a bank.
    if (order.treasuryEntry) {
      throw new Error(`${fix.tracking} already has a treasury entry — stopping`);
    }
    const zone = fix.zone ? courier.zones.find((z) => z.name === fix.zone) : null;
    if (fix.zone && !zone) throw new Error(`No zone "${fix.zone}" on ${courier.name}`);

    // The fee follows the bill. Steadfast keeps its percentage of what it
    // hands over — the collection less the charge it actually made — so a
    // corrected delivery cost that left the fee alone would report a cut taken
    // from a charge that no longer exists.
    const collected =
      order.paymentMethod === "COURIER_COLLECTION"
        ? round2(Math.max(0, invoicedTotal(order) - n(order.collectionShortfall)))
        : 0;
    const codFeeCost = round2((Math.max(0, collected - fix.deliveryCost) * pct) / 100);

    console.log(
      `${fix.tracking} ${fix.who}\n` +
        `   delivery cost ৳${order.deliveryCost} → ৳${fix.deliveryCost}` +
        (fix.zone ? `, zone → ${fix.zone}` : "") +
        `   (customer paid ৳${order.deliveryCharge})\n` +
        `   COD fee ৳${order.codFeeCost} → ৳${codFeeCost}   (${pct}% of ${collected} − ${fix.deliveryCost})`,
    );
    if (!APPLY) continue;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        deliveryCost: fix.deliveryCost,
        codFeeCost,
        ...(zone ? { courierZoneId: zone.id } : {}),
      },
    });
  }

  console.log(APPLY ? "\nDone." : "\nDry run — nothing written. Re-run with --apply.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
