/**
 * One-off: the cancelled orders that kept money and still read UNPAID.
 *
 * `updateOrderStatus` writes what a refused parcel collected to
 * `cancelledCollected` and, until now, left `paymentStatus` alone. Every money
 * figure downstream reads `cancelledCollected` once an order is cancelled, so
 * nothing was ever out by a taka — but the badge on the orders list said UNPAID
 * against 130 taka of the customer's money, and an order that had a partial
 * payment recorded BEFORE it was cancelled showed PARTIAL for the same
 * situation. The action sets the pair now; this catches up the rows entered
 * the other way round.
 *
 * PAID is left alone: a prepaid order that gets cancelled has been paid in
 * full, and what happens to that money is a refund, not a payment status.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node -r dotenv/config scripts/fix-cancelled-payment-status.mjs dotenv_config_path=.env.local
 *   node -r dotenv/config scripts/fix-cancelled-payment-status.mjs --apply dotenv_config_path=.env.local
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

async function main() {
  const slugArg = process.argv.find((a) => a.startsWith("--slug="));
  const slug = slugArg ? slugArg.slice("--slug=".length) : "gedushop";
  const ws = await prisma.workspace.findFirst({ where: { slug } });
  if (!ws) throw new Error(`No workspace "${slug}"`);

  const rows = await prisma.order.findMany({
    where: {
      workspaceId: ws.id,
      status: "CANCELLED",
      cancelledCollected: { gt: 0 },
      paymentStatus: { not: "PAID" },
    },
    include: { customer: { select: { name: true } } },
  });

  console.log(`Workspace ${slug} — ${APPLY ? "APPLYING" : "dry run"}\n`);
  let touched = 0;
  for (const o of rows) {
    const collected = Number(o.cancelledCollected);
    if (o.paymentStatus === "PARTIAL" && Number(o.amountPaid) === collected) continue;
    touched++;
    console.log(
      `${o.courierTrackingId ?? o.id.slice(-8)} ${o.customer?.name ?? "Walk-in"}: ` +
        `${o.paymentStatus}/paid ৳${o.amountPaid} → PARTIAL/paid ৳${collected} ` +
        `(collected ৳${collected})`,
    );
    if (!APPLY) continue;
    // No syncOrderCashEntry: `amountCollected` already returns
    // `cancelledCollected` for a cancelled order whatever these two say, so the
    // deposit this order puts in the treasury does not move.
    await prisma.order.update({
      where: { id: o.id },
      data: { paymentStatus: "PARTIAL", amountPaid: collected },
    });
  }

  if (touched === 0) console.log("Nothing to fix.");
  console.log(APPLY ? "\nDone." : "\nDry run — nothing written. Re-run with --apply.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
