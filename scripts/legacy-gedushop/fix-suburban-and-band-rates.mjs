/**
 * One-off: the two delivery charges GeduSuite had wrong, and the zone and the
 * weight that made them wrong.
 *
 * Steadfast prices in three zones, not two. GeduSuite only ever knew "Dhaka
 * City" and "Outside Dhaka", so a Savar parcel — Steadfast's sub-urban rate,
 * ৳105 — was priced at the outside-Dhaka ৳115. And a parcel with no weight is
 * quoted at its zone's TOP band on purpose, which is right when nothing is
 * known and wrong the moment it is: no product in the catalogue carries a
 * weight, so a 0.2kg Dhaka parcel Steadfast charged ৳55 for was costed at ৳65.
 *
 * Both showed up on payout SFC-31364675 as ৳20 of delivery bills GeduSuite
 * thought it owed and Steadfast never charged. The cash was already right —
 * the payout import puts whatever it can't attribute into a difference entry —
 * so this moves ৳20 OUT of that unattributed line and onto the two orders that
 * earned it, which is where profit reads it from.
 *
 * The rate table fix is the point; these two orders are the history it leaves
 * behind. Nothing here is general — the consignment ids are hard-coded, and
 * both figures were read off Steadfast's own app.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/fix-suburban-and-band-rates.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/fix-suburban-and-band-rates.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/** The payout whose difference line these two orders are currently hiding in. */
const PAYOUT = "SFC-31364675";

/**
 * What Steadfast actually charged, per its own screens.
 *
 * `zone` moves the parcel onto the rate that explains the charge, so re-quoting
 * it later lands on the same number instead of drifting back. `weightKg` does
 * the same job for a banded zone: without it the order is a standing invitation
 * to be re-costed at the top band.
 */
const CORRECTIONS = [
  {
    tracking: "282717857",
    who: "Firoj Ahmmed",
    // Hemayetpur, Savar — sub-urban, and Steadfast's cancelled-parcels screen
    // shows ৳105 against the ৳115 every other returned parcel was charged.
    zone: "Dhaka Sub-urban",
    weightKg: 0.39,
    deliveryCost: 105,
  },
  {
    tracking: "282719499",
    who: "আজিজ",
    // The giveaway parcel: one small toy, inside Dhaka. Steadfast's parcel
    // list shows ৳55, which is the under-0.25kg band.
    zone: null,
    weightKg: 0.2,
    deliveryCost: 55,
  },
];

/** The zone Steadfast has and GeduSuite didn't. */
const SUBURBAN = {
  name: "Dhaka Sub-urban",
  rate: 105,
  // One band, like Outside Dhaka: the negotiated rate covers the courier's
  // base weight and nothing lighter is priced differently.
  bands: [{ uptoKg: 0.5, rate: 105 }],
};

async function main() {
  const slugArg = process.argv.find((a) => a.startsWith("--slug="));
  const slug = slugArg ? slugArg.slice("--slug=".length) : "gedushop";
  const ws = await prisma.workspace.findFirst({ where: { slug } });
  if (!ws) throw new Error(`No workspace "${slug}"`);
  const workspaceId = ws.id;

  const courier = await prisma.courier.findFirst({
    where: { workspaceId, name: "Steadfast" },
    include: { zones: { include: { bands: true }, orderBy: { sortOrder: "asc" } } },
  });
  if (!courier) throw new Error("No Steadfast courier on this workspace");

  console.log(`Workspace ${slug} — ${APPLY ? "APPLYING" : "dry run"}\n`);

  // ---- 1. The missing zone -------------------------------------------------
  let suburban = courier.zones.find((z) => z.name === SUBURBAN.name);
  if (suburban) {
    console.log(`zone "${SUBURBAN.name}" already exists (৳${suburban.rate})`);
  } else {
    // Between the two it sits between in price, so the dropdown reads in the
    // order somebody picking a zone thinks in.
    const outside = courier.zones.find((z) => z.name === "Outside Dhaka");
    const sortOrder = outside ? outside.sortOrder : courier.zones.length;
    console.log(`zone + "${SUBURBAN.name}" ৳${SUBURBAN.rate} (band ≤0.5kg ৳105), sortOrder ${sortOrder}`);
    if (APPLY) {
      if (outside) {
        await prisma.courierZone.updateMany({
          where: { courierId: courier.id, sortOrder: { gte: sortOrder } },
          data: { sortOrder: { increment: 1 } },
        });
      }
      suburban = await prisma.courierZone.create({
        data: {
          workspaceId,
          courierId: courier.id,
          name: SUBURBAN.name,
          rate: SUBURBAN.rate,
          sortOrder,
          bands: {
            create: SUBURBAN.bands.map((b) => ({ workspaceId, uptoKg: b.uptoKg, rate: b.rate })),
          },
        },
      });
    }
  }

  // ---- 2. The two orders, and the entries that follow them -----------------
  //
  // A dry run has to be able to show the payout arithmetic it is about to do,
  // and the ledger it would read that from hasn't moved yet — so the entries'
  // shift is carried forward by hand and added back below.
  let pendingDelta = 0;
  console.log("");
  for (const fix of CORRECTIONS) {
    const order = await prisma.order.findFirst({
      where: { workspaceId, courierTrackingId: fix.tracking },
      include: { treasuryEntry: true },
    });
    if (!order) {
      console.log(`!! ${fix.tracking} (${fix.who}) not found — skipped`);
      continue;
    }
    const was = Number(order.deliveryCost);
    const entry = order.treasuryEntry;
    console.log(
      `${fix.tracking} ${fix.who}: delivery ৳${was} → ৳${fix.deliveryCost}` +
        `, weight ${order.weightKg ?? "—"} → ${fix.weightKg}` +
        (fix.zone ? `, zone → ${fix.zone}` : ""),
    );
    // The order's whole cash movement is the courier's bill here: nothing was
    // collected on either parcel, so the entry is an OUT for exactly the
    // delivery cost and moves with it one for one. Asserted rather than
    // assumed — a parcel that had collected something would need the deposit
    // recomputed, and silently mis-writing that is worse than stopping.
    if (entry) {
      if (entry.type !== "OUT" || round2(Number(entry.amount)) !== was) {
        throw new Error(
          `${fix.tracking}: expected an OUT of ${was}, found ${entry.type} ${entry.amount} — stopping`,
        );
      }
      console.log(`  treasury ${entry.type} ৳${entry.amount} → ৳${fix.deliveryCost}`);
      // An OUT of 115 becoming an OUT of 105 moves the ledger UP by 10.
      pendingDelta = round2(pendingDelta + (was - fix.deliveryCost));
    }
    if (!APPLY) continue;
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          deliveryCost: fix.deliveryCost,
          weightKg: fix.weightKg,
          ...(fix.zone && suburban ? { courierZoneId: suburban.id } : {}),
        },
      });
      if (entry) {
        await tx.treasuryEntry.update({
          where: { id: entry.id },
          data: { amount: fix.deliveryCost },
        });
      }
    });
  }

  // ---- 3. Put the payout's difference back where it belongs ----------------
  //
  // The import wrote "Steadfast paid X; the orders in it come to Y" and an
  // entry for the gap. Y has just moved by 20, so the gap has to move with it
  // or the treasury ends up 20 taka richer than the bank — the one number this
  // whole exercise must not change.
  console.log("");
  const payout = await prisma.courierPayout.findFirst({
    where: { workspaceId, externalId: PAYOUT },
  });
  if (!payout) {
    console.log(`!! payout ${PAYOUT} not found — difference left alone`);
  } else {
    const ids = payout.consignmentIds;
    const orders = await prisma.order.findMany({
      where: { workspaceId, courierTrackingId: { in: ids } },
      include: { treasuryEntry: true },
    });
    // Read back off the ledger, not recomputed: what the treasury actually
    // holds against these parcels is the thing the difference has to complete.
    const ordersTotal = round2(
      orders.reduce((s, o) => {
        const e = o.treasuryEntry;
        return s + (e ? Number(e.amount) * (e.type === "IN" ? 1 : -1) : 0);
      }, 0) + (APPLY ? 0 : pendingDelta),
    );
    const total = Number(payout.total);
    const difference = round2(total - ordersTotal);
    const existing = await prisma.treasuryEntry.findFirst({
      where: { workspaceId, source: { endsWith: "payout difference" }, note: { contains: PAYOUT } },
    });
    console.log(
      `payout ${PAYOUT}: paid ৳${total}, orders now ৳${ordersTotal}` +
        `, difference ৳${existing ? existing.amount : "—"} → ৳${Math.abs(difference)}`,
    );
    console.log(`  ledger check: ${ordersTotal} + ${difference} = ${round2(ordersTotal + difference)} (want ${total})`);
    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        await tx.courierPayout.update({ where: { id: payout.id }, data: { ordersTotal } });
        if (!existing) return;
        if (Math.abs(difference) < 0.01) {
          await tx.treasuryEntry.delete({ where: { id: existing.id } });
          return;
        }
        await tx.treasuryEntry.update({
          where: { id: existing.id },
          data: {
            type: difference < 0 ? "OUT" : "IN",
            amount: Math.abs(difference),
            note:
              `Steadfast paid ৳${total} on ${PAYOUT}; the ${orders.length} order(s) in it ` +
              `come to ৳${ordersTotal}. The fee is charged on the payout as a whole and ` +
              `rounded, so the two never land on the same paisa.`,
          },
        });
      });
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
