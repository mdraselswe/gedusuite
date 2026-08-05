/**
 * One-off: stop counting courier COD as money in hand before the courier has
 * actually paid it out.
 *
 * "Cash deposited" was being ticked when the customer paid the rider. At that
 * moment the money is with the COURIER, not the shop — the courier's own app
 * still lists it as their balance. Ticking it early inflates the treasury and
 * makes the reconciliation page think there is nothing outstanding.
 *
 * Undoes the mark exactly as the app does: the linked treasury entry is
 * removed with the flag, so the treasury balance drops by the same amount it
 * was raised. Re-tick each order when the courier's payout actually lands.
 *
 * Dry run by default. Pass --apply to write.
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const slugArg = process.argv.find((a) => a.startsWith("--slug="));
const SLUG = slugArg ? slugArg.slice("--slug=".length) : "gedushop";

const prisma = new PrismaClient();
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

async function treasuryBalance(workspaceId) {
  const rows = await prisma.treasuryEntry.groupBy({
    by: ["type"],
    where: { workspaceId },
    _sum: { amount: true },
  });
  return round2(
    rows.reduce((b, r) => b + (r.type === "IN" ? 1 : -1) * Number(r._sum.amount ?? 0), 0),
  );
}

async function main() {
  const workspace = await prisma.workspace.findUnique({
    where: { slug: SLUG },
    select: { id: true, name: true },
  });
  if (!workspace) return console.log(`No workspace "${SLUG}".`);
  const workspaceId = workspace.id;

  // Delivered by courier and already ticked as deposited — the ones whose
  // money the courier is, in fact, still holding.
  const orders = await prisma.order.findMany({
    where: {
      workspaceId,
      deliveryType: "COURIER",
      status: "DELIVERED",
      cashInTreasury: true,
    },
    orderBy: { date: "asc" },
    select: { id: true, date: true, customer: { select: { name: true } } },
  });

  const entries = await prisma.treasuryEntry.findMany({
    where: { workspaceId, orderId: { in: orders.map((o) => o.id) } },
    select: { orderId: true, amount: true, type: true },
  });
  const byOrder = new Map(entries.map((e) => [e.orderId, e]));

  const before = await treasuryBalance(workspaceId);
  let removed = 0;

  console.log(`Workspace: ${workspace.name}`);
  console.log(`Mode:      ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);
  console.log("Customer".padEnd(24) + "Date".padEnd(12) + "Treasury entry".padStart(16));
  console.log("-".repeat(52));
  for (const o of orders) {
    const e = byOrder.get(o.id);
    const amt = e ? Number(e.amount) : 0;
    if (e?.type === "IN") removed += amt;
    console.log(
      (o.customer?.name ?? "Walk-in").padEnd(24) +
        o.date.toISOString().slice(0, 10).padEnd(12) +
        (e ? amt.toFixed(2) : "none").padStart(16),
    );
  }
  console.log("-".repeat(52));
  console.log(`${orders.length} order(s) un-marked, ${round2(removed).toFixed(2)} of treasury entries removed.`);
  console.log(`Treasury balance: ${before.toFixed(2)} → ${round2(before - removed).toFixed(2)}`);
  console.log(
    `That money isn't gone — it moves from "in the box" to "the courier owes us", which is where it actually is.`,
  );

  if (!APPLY) return console.log("\nDry run — nothing written. Re-run with --apply to save.");

  for (const o of orders) {
    await prisma.$transaction([
      prisma.treasuryEntry.deleteMany({ where: { workspaceId, orderId: o.id } }),
      prisma.order.update({ where: { id: o.id }, data: { cashInTreasury: false } }),
    ]);
  }
  console.log(`\nUpdated ${orders.length} order(s). Treasury now ${(await treasuryBalance(workspaceId)).toFixed(2)}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
