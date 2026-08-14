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
  /** Delivery cost + COD fee the courier kept out of it, or billed anyway. */
  courierCharges: number;
  /**
   * gross − courierCharges. Signed: negative means the courier charged more
   * for the trip than it collected on it, and the shop owes it the difference.
   */
  net: number;
};

/** Enough of an order to work out what reaches the treasury. */
type DepositableOrder = {
  status: string;
  /** Required, not optional: a missing `select` here would silently stop
   * netting a courier's charges, and nothing would look wrong until the
   * balance did. */
  deliveryType: string;
  paymentMethod: string;
  paymentStatus: string;
  amountPaid?: Prisma.Decimal | number | null;
  cancelledCollected?: Prisma.Decimal | number | null;
  deliveryCost?: Prisma.Decimal | number | null;
  /** Required, not optional, for the same reason deliveryType is: a query that
   *  forgot to select it would go on crediting the treasury with money the
   *  courier never had, and nothing would look wrong until a balance did. */
  collectionShortfall: Prisma.Decimal | number;
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
 * The amount a courier's percentage fee is charged on: what its own ledger
 * shows for this parcel.
 *
 * Three actions re-quoted this and each worked it out again. They agreed until
 * a return was recorded, and then they didn't: the header edit quoted on the
 * invoice, the status change on `customerTotal`, which has the return taken
 * off. The same order therefore stored a different fee depending on which
 * action was saved last, and neither the orders list nor the courier page
 * could tell which one it was looking at.
 *
 * The invoice is the right base. The courier took its cut of what it collected
 * at the door, on the day; goods sent back afterwards don't bring any of it
 * back — exactly the reasoning `collectionShortfall` already follows in
 * computeOrderTotals. So `updateOrderStatus` was the one that was wrong.
 *
 * A cancellation collected only whatever came back with a partial delivery,
 * and a shortfall means the courier's ledger is lighter than the invoice by
 * that much. Both come off the same base rather than replacing it.
 */
export function codBaseFor(
  order: {
    status: string;
    cancelledCollected?: Prisma.Decimal | number | null;
    collectionShortfall?: Prisma.Decimal | number | null;
  },
  totals: Pick<OrderTotals, "invoicedTotal">,
): number {
  if (order.status === "CANCELLED") {
    return round2(Math.max(0, Number(order.cancelledCollected ?? 0)));
  }
  return round2(
    Math.max(0, totals.invoicedTotal - Number(order.collectionShortfall ?? 0)),
  );
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
 * What the courier actually has to hand over — what the customer paid, less
 * whatever never made it that far.
 *
 * The two are the same number on almost every order, and deliberately separate
 * where they aren't: `amountCollected` answers "has the customer settled up",
 * which decides whether anybody still owes anything, and this answers "how much
 * money exists", which decides what can arrive in the treasury and what the
 * courier's balance should read. A rider who banked 900 against a 960 invoice
 * left the customer square and the shop 60 short, and one number cannot say
 * both.
 */
export function amountRemitted(
  order: SettleableOrder & { collectionShortfall: Prisma.Decimal | number },
  totals: Pick<OrderTotals, "customerTotal">,
): number {
  const paid = amountCollected(order, totals);
  return round2(Math.max(0, paid - Number(order.collectionShortfall ?? 0)));
}

/**
 * Whether "nothing was collected" is a recorded fact or just a blank.
 *
 * A PARTIAL row nobody has typed a figure onto reads as zero collected and
 * isn't — the money came in, the number didn't. That distinction never
 * mattered while a deposit could only be positive; it matters now that a
 * courier charge with no collection behind it becomes real money leaving the
 * treasury. Guessing wrong there books an outflow against an order that may
 * have collected its full invoice.
 */
export function collectionRecorded(order: SettleableOrder): boolean {
  if (order.status === "CANCELLED") return true;
  if (order.paymentStatus === "PAID") return true;
  return order.paymentStatus === "PARTIAL" && Number(order.amountPaid ?? 0) > 0;
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
 * The charges are netted whenever the courier itself is what settles them —
 * either out of the COD it collected, or, when it collected nothing, off the
 * merchant's balance. A giveaway parcel is the plain case: the customer owes
 * nothing, the courier still charges 65 for carrying it, and Steadfast takes
 * that 65 out of the next payout. What is deliberately NOT netted is a courier
 * charge on an order whose cash a team member is holding: they hand over the
 * whole amount they collected, the courier bills its trip separately, and
 * taking it off here would understate what that person owes the shop.
 *
 * Signed, not floored. A parcel that collected less than it cost to carry
 * leaves the shop owing the courier, and a floor of zero is what made that
 * money invisible: it never reached the treasury as an outflow and never
 * showed up anywhere a balance could be checked against the courier's app.
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
  // part that was paid — less anything that went missing between the doorstep
  // and the courier's ledger, which is money the treasury is never going to
  // see however square the customer is.
  const gross = amountRemitted(order, totals);

  const deliveryCost = deliveryCostCharged(order, totals);
  const courierCharges =
    order.deliveryType === "COURIER" &&
    (order.paymentMethod === "COURIER_COLLECTION" || gross === 0)
      ? round2(deliveryCost + totals.codFeeCost)
      : 0;

  return { gross, courierCharges, net: round2(gross - courierCharges) };
}

/** "Courier remittance" when the courier collected it, otherwise a plain sale. */
export function cashEntrySource(paymentMethod: string, direction: "IN" | "OUT" = "IN"): string {
  // An outflow is never a sale of any kind — it is the courier's bill for a
  // trip that collected nothing to pay it with, and the treasury list has to
  // say so at a glance rather than showing a negative "Sales collection".
  if (direction === "OUT") return "Courier charges";
  return paymentMethod === "COURIER_COLLECTION" ? "Courier remittance" : "Sales collection";
}

/**
 * How a courier charge with no collection behind it reads in the treasury.
 *
 * cashEntryNote's wording ("after 65.00 courier charges") describes money
 * arriving less a deduction, which is the opposite of this: nothing arrived,
 * and the charge is the whole movement.
 */
export function courierChargeNote(order: NotedOrder, gross: number): string {
  return [
    order.customer?.name
      ? `Courier charges on ${order.customer.name}'s order`
      : "Courier charges on a walk-in order",
    order.status === "CANCELLED" ? "parcel came back" : null,
    gross > 0
      ? `only ${gross.toFixed(2)} was collected to cover them`
      : "nothing was collected to cover them",
  ]
    .filter(Boolean)
    .join(", ");
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
  if (deposit.gross <= 0 && !collectionRecorded(order)) return;

  if (amount === 0) {
    // The flag clears with the entry, so the order stops claiming a deposit it
    // no longer has. Un-cancelling later doesn't put it back — nothing here
    // knows whether the cash was ever returned to the customer — so the order
    // simply becomes markable again, which is the honest answer.
    await tx.treasuryEntry.deleteMany({ where: { workspaceId, orderId } });
    await tx.order.update({ where: { id: orderId }, data: { cashInTreasury: false } });
    return;
  }

  // An edit can turn a remittance into a bill and back — a return that wipes
  // out the goods leaves the courier's charge standing on its own — so the
  // direction is rewritten alongside the figure. Leaving `type` alone would
  // add a courier's 65 to the balance instead of taking it off.
  const outward = amount < 0;
  await tx.treasuryEntry.updateMany({
    where: { workspaceId, orderId },
    data: {
      type: outward ? "OUT" : "IN",
      amount: Math.abs(amount),
      source: cashEntrySource(order.paymentMethod, outward ? "OUT" : "IN"),
      note: outward
        ? courierChargeNote(order, deposit.gross)
        : cashEntryNote(order, totals.returnedUnits, deposit.courierCharges),
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
