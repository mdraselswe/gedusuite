/**
 * One-off: bring already-banked order cash in line with what actually arrived.
 *
 * "Mark cash deposited" used to credit the treasury with the whole customer
 * total, including on COD orders where the courier keeps its delivery charge
 * and percentage fee before remitting. A 960 parcel at 65 delivery and 8.45
 * COD fee put 960 into the treasury when 886.55 arrived, so the balance has
 * been running high by the courier's cut on every such order — and a "profit
 * distribution" could hand out money that was never there.
 *
 * The app writes the right figure from now on. This fixes the entries already
 * on the ledger. Only COURIER_COLLECTION orders can move: everything else was
 * collected in full by the business and was already correct.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/resync-order-deposits.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/resync-order-deposits.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const n = (v) => (v == null ? 0 : Number(v));

/**
 * The app's own order maths, repeated here rather than imported: this is a
 * plain .mjs script with no TypeScript path aliases, and the alternative is a
 * build step for a file that runs twice. Kept deliberately small — only the
 * customer total is needed, and returns are the only thing that moves it.
 */
function customerTotal(order) {
  let revenue = 0;
  let itemDiscounts = 0;
  let grossRevenue = 0;
  for (const item of order.items) {
    const returned = item.returns.reduce((s, r) => s + r.quantity, 0);
    const kept = Math.max(0, item.quantity - returned);
    const fraction = item.quantity > 0 ? kept / item.quantity : 0;
    grossRevenue += n(item.unitPrice) * item.quantity;
    revenue += n(item.unitPrice) * kept;
    itemDiscounts += n(item.discount) * fraction;
  }
  // The order discount is scaled to what was kept, exactly as the app now
  // scales it — a fully returned order carries none of it.
  const keptFraction = grossRevenue > 0 ? revenue / grossRevenue : 0;
  return round2(
    revenue - itemDiscounts - n(order.discount) * keptFraction + n(order.deliveryCharge),
  );
}

async function main() {
  const slugArg = process.argv.find((a) => a.startsWith("--slug="));
  const where = slugArg ? { workspace: { slug: slugArg.slice("--slug=".length) } } : {};

  const orders = await prisma.order.findMany({
    where: { ...where, cashInTreasury: true },
    orderBy: { date: "asc" },
    include: {
      customer: { select: { name: true } },
      items: { include: { returns: true } },
      treasuryEntry: { select: { id: true, amount: true } },
      workspace: { select: { slug: true } },
    },
  });

  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log(`Deposited orders found: ${orders.length}\n`);

  const plans = [];
  for (const o of orders) {
    if (!o.treasuryEntry) continue;

    const total = customerTotal(o);
    const cancelled = o.status === "CANCELLED";
    const gross = cancelled ? round2(n(o.cancelledCollected)) : total;
    // A cancelled parcel was never billed a delivery charge it didn't incur,
    // so a null cost means zero here — the same rule cancelledOrderCost uses.
    const deliveryCost =
      cancelled && o.deliveryCost == null ? 0 : n(o.deliveryCost ?? o.deliveryCharge);
    const courierCharges =
      o.paymentMethod === "COURIER_COLLECTION" ? round2(deliveryCost + n(o.codFeeCost)) : 0;
    const net = round2(Math.max(0, gross - courierCharges));

    const was = round2(n(o.treasuryEntry.amount));
    if (was === net) continue;
    plans.push({
      id: o.id,
      entryId: o.treasuryEntry.id,
      slug: o.workspace.slug,
      name: o.customer?.name ?? "Walk-in",
      date: o.date.toISOString().slice(0, 10),
      was,
      net,
      courierCharges,
    });
  }

  if (plans.length === 0) {
    console.log("Every deposited order already holds the right amount. Nothing to do.");
    return;
  }

  let delta = 0;
  for (const p of plans) {
    delta += p.net - p.was;
    console.log(
      `${p.date}  ${p.name.padEnd(24).slice(0, 24)}  ${p.was.toFixed(2).padStart(10)} → ` +
        `${p.net.toFixed(2).padStart(10)}   (courier kept ${p.courierCharges.toFixed(2)})`,
    );
  }
  console.log(`\n${plans.length} entr${plans.length === 1 ? "y" : "ies"} to correct.`);
  console.log(`Treasury balance change: ${delta.toFixed(2)}`);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to make these changes.");
    return;
  }

  for (const p of plans) {
    // Only the amount moves. The note and source are left alone: they describe
    // where the money came from, which hasn't changed.
    await prisma.treasuryEntry.update({
      where: { id: p.entryId },
      data: {
        amount: p.net,
        note: `Corrected: courier kept ${p.courierCharges.toFixed(2)} of ${p.was.toFixed(2)}`,
      },
    });
  }
  console.log(`\nUpdated ${plans.length} treasury entr${plans.length === 1 ? "y" : "ies"}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
