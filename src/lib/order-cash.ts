import type { Prisma } from "@prisma/client";
import { computeOrderTotals, type OrderTotals } from "@/lib/orders";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

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
  status?: string;
  customer: { name: string } | null;
  heldBy: { user: { name: string | null; email: string } } | null;
};

/** How the deposit reads in the treasury list. */
export function cashEntryNote(
  order: NotedOrder,
  returnedUnits: number,
  /** What the courier kept before remitting, when it collected the money. */
  courierCharges = 0,
): string {
  const holder = order.heldBy ? (order.heldBy.user.name ?? order.heldBy.user.email) : null;
  return [
    order.customer?.name ? `Order for ${order.customer.name}` : "Walk-in order",
    // Otherwise a 4.95 deposit against a 960 order reads as an error rather
    // than as the shipping a refused parcel collected on the doorstep.
    order.status === "CANCELLED" ? "cancelled — collected on a partial delivery" : null,
    holder ? `collected by ${holder}` : null,
    // Says why the figure is lower than the invoice, rather than leaving
    // someone to work it out from two screens.
    returnedUnits > 0 ? `net of ${returnedUnits} returned unit(s)` : null,
    courierCharges > 0 ? `after ${courierCharges.toFixed(2)} courier charges` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** What an order actually puts into the treasury, and what never got there. */
export type DepositAmount = {
  /** What the customer handed over. */
  gross: number;
  /** Delivery cost + COD fee the courier kept out of it before remitting. */
  courierCharges: number;
  /** gross − courierCharges, floored at zero: what the business receives. */
  net: number;
};

/** Enough of an order to work out what reaches the treasury. */
type DepositableOrder = {
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  amountPaid?: Prisma.Decimal | number | null;
  cancelledCollected?: Prisma.Decimal | number | null;
  deliveryCost?: Prisma.Decimal | number | null;
};

/** Just enough to answer "how much has the customer paid". */
type SettleableOrder = Pick<
  DepositableOrder,
  "status" | "paymentStatus" | "amountPaid" | "cancelledCollected"
>;

/**
 * What the courier will collect on the doorstep — the only money its
 * percentage fee is charged on, and the figure the booking API is given.
 *
 * The test is how the customer pays, not whether the order has been settled
 * yet: an order paid by bKash in advance still travels by courier, but there
 * is nothing for it to hand over and so no fee. (Payment status would be the
 * wrong test — every COD order is UNPAID at the moment it's created.)
 *
 * `amount` is the invoice on a live order and, on a cancelled one, only what
 * was collected on a partial delivery: the courier keeps its percentage of
 * the 120 it handed over, not of the 1,200 nobody ever paid. Quoting a
 * cancellation on the undelivered invoice charged a fee several times the
 * size of the money it was supposedly taken from.
 *
 * Lives here rather than in the orders action because booking a parcel needs
 * the same answer: the amount printed on the courier's label and the amount
 * its fee was quoted on have to be one number, or the reconciliation page is
 * comparing two different orders.
 */
export function codCollectable(paymentMethod: string, amount: number): number {
  return paymentMethod === "COURIER_COLLECTION" ? Math.max(0, amount) : 0;
}

/**
 * What the customer has actually handed over so far.
 *
 * PAID is taken to mean the whole customer total whatever `amountPaid` holds —
 * that is what makes every order predating the column behave as it did, and it
 * keeps a PAID order fully settled when a later return lowers what was owed.
 * `amountPaid` is only consulted for PARTIAL, and clamped to the total: a typo
 * must not create a customer who has overpaid into the treasury.
 *
 * A cancelled order sold nothing, so the only money in play is whatever was
 * collected on the doorstep of a refused parcel.
 */
export function amountCollected(
  order: SettleableOrder,
  totals: Pick<OrderTotals, "customerTotal">,
): number {
  if (order.status === "CANCELLED") return round2(Number(order.cancelledCollected ?? 0));
  if (order.paymentStatus === "PAID") return totals.customerTotal;
  if (order.paymentStatus !== "PARTIAL") return 0;
  return round2(
    Math.min(totals.customerTotal, Math.max(0, Number(order.amountPaid ?? 0))),
  );
}

/**
 * What the customer still owes. Zero on a cancelled order — there is nothing
 * left to collect on a sale that didn't happen, whatever was paid towards it.
 */
export function amountOutstanding(
  order: SettleableOrder,
  totals: Pick<OrderTotals, "customerTotal">,
): number {
  if (order.status === "CANCELLED") return 0;
  return round2(Math.max(0, totals.customerTotal - amountCollected(order, totals)));
}

/**
 * How much of an order's money the business actually ends up holding.
 *
 * A courier does not hand over what it collected — it hands over what is left
 * after its delivery charge and its percentage fee. The treasury used to be
 * credited with the full invoice anyway, so every COD order quietly added the
 * courier's cut to a balance that never contained it: a 960 parcel at 65
 * delivery and 8.45 COD fee put 960 in the treasury when 886.55 arrived. The
 * courier balance page has always netted these off (that is how it knows what
 * to expect from Steadfast); this is the same arithmetic, applied to the money
 * once it lands.
 *
 * Only COURIER_COLLECTION is netted. When the customer paid by bKash or handed
 * cash to somebody, the business really did receive the whole amount — paying
 * a rider afterwards is a separate movement, and inventing an outflow here
 * would take it out of the treasury twice.
 *
 * Floored at zero: a refused parcel can cost more to return than it collected,
 * and a negative "deposit" is not a thing. The loss is already carried by
 * cancelledOrderCost, which is where it belongs.
 */
/**
 * What the courier actually charged for the trip.
 *
 * computeOrderTotals reads a null deliveryCost as "same as the charge", which
 * is right for a delivered order (pass-through) and wrong for a cancelled one:
 * nothing was quoted, so nothing was charged, and assuming otherwise invents a
 * courier bill that was never sent.
 *
 * Exported because two places need the same answer — what reaches the treasury,
 * and what the courier is holding — and they were free to disagree while each
 * carried its own copy of the rule. The COD fee needs no such correction:
 * cancelling re-quotes it against the partial payment, so it is already the fee
 * on the money the courier has.
 */
export function deliveryCostCharged(
  order: { status: string; deliveryCost?: Prisma.Decimal | number | null },
  totals: Pick<OrderTotals, "deliveryCost">,
): number {
  return order.status === "CANCELLED" && order.deliveryCost == null
    ? 0
    : totals.deliveryCost;
}

export function depositAmount(
  order: DepositableOrder,
  totals: Pick<OrderTotals, "customerTotal" | "deliveryCost" | "codFeeCost">,
): DepositAmount {
  // What was collected, not what was invoiced: a part-paid order banks the
  // part that was paid.
  const gross = amountCollected(order, totals);

  const deliveryCost = deliveryCostCharged(order, totals);
  const courierCharges =
    order.paymentMethod === "COURIER_COLLECTION"
      ? round2(deliveryCost + totals.codFeeCost)
      : 0;

  return { gross, courierCharges, net: round2(Math.max(0, gross - courierCharges)) };
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
  const deposit = depositAmount(order, totals);
  const amount = deposit.net;

  // An order whose status says nothing has been collected, with money already
  // banked against it, is a contradiction — most often a PARTIAL row nobody has
  // typed the figure onto yet. Recomputing from it would read "collected
  // nothing" and delete a deposit for cash that genuinely arrived, from a
  // routine edit somewhere else entirely. Left alone for a person to resolve,
  // the same way blockedByDepositedCash leaves the other unresolvable cases.
  const unrecorded =
    deposit.gross <= 0 &&
    order.status !== "CANCELLED" &&
    order.paymentStatus !== "PAID";
  if (unrecorded) return;

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
      note: cashEntryNote(order, totals.returnedUnits, deposit.courierCharges),
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
