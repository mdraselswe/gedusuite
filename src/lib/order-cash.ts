import type { Prisma } from "@prisma/client";
import { computeOrderTotals } from "@/lib/orders";

/**
 * Keeping an order's deposited cash in step with the order.
 *
 * "Mark cash deposited" writes a TreasuryEntry holding a snapshot of what the
 * customer owed at that moment. A snapshot goes stale: record a return, cancel
 * the order, edit a charge, and the treasury still insists on the old figure.
 * Only the header edit ever resynced it, so every other route drifted quietly —
 * and a treasury that disagrees with the orders behind it is worth less than no
 * treasury at all.
 *
 * One helper, called from every route that can move the number. Where a change
 * would leave the treasury holding money for a sale that didn't happen, the
 * entry goes and the flag clears; where it can't be resolved automatically
 * (unpaying a deposited order, deleting one) the action is blocked instead —
 * the same rule the rest of the finance modules already follow for derived rows.
 */

/** Enough of an order to describe the deposit in the ledger. */
type NotedOrder = {
  customer: { name: string } | null;
  heldBy: { user: { name: string | null; email: string } } | null;
};

/** How the deposit reads in the treasury list. */
export function cashEntryNote(order: NotedOrder, returnedUnits: number): string {
  const holder = order.heldBy ? (order.heldBy.user.name ?? order.heldBy.user.email) : null;
  return [
    order.customer?.name ? `Order for ${order.customer.name}` : "Walk-in order",
    holder ? `collected by ${holder}` : null,
    // Says why the figure is lower than the invoice, rather than leaving
    // someone to work it out from two screens.
    returnedUnits > 0 ? `net of ${returnedUnits} returned unit(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** "Courier remittance" when the courier collected it, otherwise a plain sale. */
export function cashEntrySource(paymentMethod: string): string {
  return paymentMethod === "COURIER_COLLECTION" ? "Courier remittance" : "Sales collection";
}

/**
 * Bring the order's treasury entry back in line with the order, or remove it
 * if there's no longer any of its money in the treasury. A no-op for orders
 * whose cash was never marked as deposited — they have no entry to keep.
 *
 * Must run inside the same transaction as whatever changed the order.
 */
export async function syncOrderCashEntry(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  orderId: string,
): Promise<void> {
  const order = await tx.order.findFirst({
    where: { id: orderId, workspaceId },
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
      heldBy: { include: { user: { select: { name: true, email: true } } } },
    },
  });
  if (!order || !order.cashInTreasury) return;

  const totals = computeOrderTotals(order);
  // A cancelled order sold nothing. Whatever the customer handed over anyway —
  // usually just the shipping on a refused parcel — is the only part of it the
  // business still holds.
  const amount =
    order.status === "CANCELLED"
      ? Number(order.cancelledCollected ?? 0)
      : totals.customerTotal;

  if (amount <= 0) {
    // The flag clears with the entry, so the order stops claiming a deposit it
    // no longer has. Un-cancelling later doesn't put it back — nothing here
    // knows whether the cash was ever returned to the customer — so the order
    // simply becomes markable again, which is the honest answer.
    await tx.treasuryEntry.deleteMany({ where: { workspaceId, orderId } });
    await tx.order.update({ where: { id: orderId }, data: { cashInTreasury: false } });
    return;
  }

  await tx.treasuryEntry.updateMany({
    where: { workspaceId, orderId },
    data: {
      amount,
      source: cashEntrySource(order.paymentMethod),
      note: cashEntryNote(order, totals.returnedUnits),
    },
  });
}

/**
 * Why an order can't be touched while its cash sits in the treasury, or null
 * when it can. Used by the two routes with no sensible automatic answer:
 * unpaying an order (the money is either in the treasury or it isn't) and
 * deleting one (deleting the entry loses money that arrived; keeping it leaves
 * a figure nobody can trace).
 */
export function blockedByDepositedCash(
  order: { cashInTreasury: boolean },
  action: "unpay" | "delete",
): string | null {
  if (!order.cashInTreasury) return null;
  const what = action === "unpay" ? "mark this order unpaid" : "delete this order";
  return (
    `This order's cash is confirmed in the treasury, so you can't ${what} yet. ` +
    `Undo the deposit on the order first — that removes the treasury entry — then try again.`
  );
}
