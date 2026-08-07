import type { Prisma } from "@prisma/client";

// Minimal shape needed to compute totals — works with a Prisma query that
// includes items and each item's returns.
export type OrderWithTotals = {
  deliveryCharge: Prisma.Decimal | number;
  deliveryCost?: Prisma.Decimal | number | null;
  /** The courier's percentage fee in taka. Absent on orders that predate it. */
  codFeeCost?: Prisma.Decimal | number | null;
  packagingCost: Prisma.Decimal | number;
  giftCost: Prisma.Decimal | number;
  discount: Prisma.Decimal | number;
  items: {
    unitPrice: Prisma.Decimal | number;
    unitCost: Prisma.Decimal | number;
    quantity: number;
    discount: Prisma.Decimal | number;
    returns: { quantity: number; refundAmount: Prisma.Decimal | number }[];
  }[];
};

const n = (v: Prisma.Decimal | number): number => Number(v);
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export type OrderTotals = {
  grossRevenue: number; // full ordered quantity × price, before returns/discounts
  itemDiscounts: number; // scaled to the quantity still kept
  orderDiscount: number; // likewise scaled — a returned unit takes its share of the discount with it
  refunds: number; // total cash refunded (reported separately, not re-subtracted)
  netRevenue: number; // effective revenue after discounts, on kept quantities
  cogs: number; // cost of kept quantities
  /**
   * What this order's packaging cost, as a note. NOT in netProfit — the
   * polybags were bought as an internal purchase, and that purchase is already
   * an operating expense. Charging both put the same 5,000 of packaging
   * through the accounts twice.
   */
  packagingCost: number;
  giftCost: number;
  deliveryCharge: number;
  deliveryCost: number; // actual amount paid to the courier
  deliveryMargin: number; // deliveryCharge − deliveryCost; can be + or −
  codFeeCost: number; // the courier's percentage fee on the collected amount
  netProfit: number; // sale − cost − discount − gift, plus/minus delivery margin, less the courier's COD fee
  customerTotal: number; // owed for kept goods incl. delivery
  returnedUnits: number;
};

/**
 * Server-side order math. Returns are applied per line via the effective
 * quantity (ordered − returned): a returned unit drops out of revenue AND cost,
 * so its margin disappears from profit exactly once. `refundAmount` is reported
 * for cash tracking but is NOT subtracted again (that would double-count the
 * return).
 *
 * Delivery: `deliveryCharge` is what the customer pays; `deliveryCost` is what
 * actually goes to the courier. When `deliveryCost` is null (not entered), it's
 * assumed to equal `deliveryCharge` — a pure pass-through, net zero effect on
 * profit (this is also what every pre-existing order in the DB means). When
 * they differ — the business keeps a cut, or pays more than it collected —
 * that difference (`deliveryMargin`) flows into net profit.
 */
export function computeOrderTotals(order: OrderWithTotals): OrderTotals {
  let grossRevenue = 0;
  let itemDiscounts = 0;
  let cogs = 0;
  let refunds = 0;
  let returnedUnits = 0;
  let effectiveRevenue = 0;

  for (const item of order.items) {
    const qty = item.quantity;
    const returnedQty = item.returns.reduce((s, r) => s + r.quantity, 0);
    const effectiveQty = Math.max(0, qty - returnedQty);
    const fraction = qty > 0 ? effectiveQty / qty : 0;

    grossRevenue += n(item.unitPrice) * qty;
    effectiveRevenue += n(item.unitPrice) * effectiveQty;
    itemDiscounts += n(item.discount) * fraction;
    cogs += n(item.unitCost) * effectiveQty;
    refunds += item.returns.reduce((s, r) => s + n(r.refundAmount), 0);
    returnedUnits += returnedQty;
  }

  // Scaled to what the customer kept, exactly as a line discount is. An order
  // discount is a reduction on the goods, so returning the goods takes the
  // reduction with them — left at full size on a fully returned order it
  // survived as a standalone negative, and the order reported a loss equal to
  // the discount on a sale that had been completely undone.
  const keptFraction = grossRevenue > 0 ? effectiveRevenue / grossRevenue : 0;
  const orderDiscount = n(order.discount) * keptFraction;
  const packagingCost = n(order.packagingCost);
  const giftCost = n(order.giftCost);
  const deliveryCharge = n(order.deliveryCharge);
  const deliveryCost = order.deliveryCost != null ? n(order.deliveryCost) : deliveryCharge;
  const deliveryMargin = deliveryCharge - deliveryCost;
  // Kept out of deliveryCost so a report can tell a bad delivery rate from a
  // bad COD rate — they're fixed by different decisions.
  const codFeeCost = order.codFeeCost != null ? n(order.codFeeCost) : 0;

  const netRevenue = effectiveRevenue - itemDiscounts - orderDiscount;
  // packagingCost is deliberately absent. Packaging material is bought as an
  // internal purchase, and every internal purchase is already charged to
  // profit as an operating expense — so subtracting a per-order share as well
  // put the same polybags through the accounts twice: 5,000 spent on bags
  // showed up as 5,000 of opex plus 5,000 spread across 500 orders. The
  // internal purchase is the one that has real money behind it, so that is the
  // one that counts; this figure stays on the order as a note about how much
  // packaging a particular parcel used.
  const netProfit = netRevenue - cogs - giftCost + deliveryMargin - codFeeCost;
  const customerTotal = netRevenue + deliveryCharge;

  return {
    grossRevenue: round2(grossRevenue),
    itemDiscounts: round2(itemDiscounts),
    orderDiscount: round2(orderDiscount),
    refunds: round2(refunds),
    netRevenue: round2(netRevenue),
    cogs: round2(cogs),
    packagingCost: round2(packagingCost),
    giftCost: round2(giftCost),
    deliveryCharge: round2(deliveryCharge),
    deliveryCost: round2(deliveryCost),
    deliveryMargin: round2(deliveryMargin),
    codFeeCost: round2(codFeeCost),
    netProfit: round2(netProfit),
    customerTotal: round2(customerTotal),
    returnedUnits,
  };
}

/** What a cancelled order still cost, broken down. */
export type CancelledCost = {
  /** Reported, not charged — see the note on OrderTotals.packagingCost. */
  packagingCost: number;
  giftCost: number;
  /** What the courier charged for the failed trip. */
  deliveryCost: number;
  /** What the customer paid anyway — a partial delivery, usually the shipping. */
  collected: number;
  /** Costs less anything collected. Can be negative: a cancellation can end up ahead. */
  total: number;
};

/**
 * A cancelled order sells nothing and its stock goes back on the shelf, so
 * computeOrderTotals has nothing to say about it — but the packaging is used,
 * the gift may be gone, and a parcel that reached the courier and came back
 * is charged for. That money is real and was previously invisible: every
 * report filters cancelled orders out entirely, so the loss simply vanished.
 *
 * Unlike computeOrderTotals, a null `deliveryCost` here means ZERO, not "same
 * as the delivery charge". That assumption is right for a delivered order
 * (pass-through) and completely wrong for a cancelled one — it would invent a
 * courier bill that was never sent. What the courier actually charged is
 * asked for when the order is cancelled.
 *
 * Nothing decides here whether the parcel was ever packed. An order cancelled
 * before anyone touched it should carry zero packaging and gift cost, and the
 * cancel dialog is where those get zeroed — a guess from the status would be
 * wrong as often as it was right.
 */
export function cancelledOrderCost(order: {
  packagingCost: Prisma.Decimal | number;
  giftCost: Prisma.Decimal | number;
  deliveryCost?: Prisma.Decimal | number | null;
  cancelledCollected?: Prisma.Decimal | number | null;
}): CancelledCost {
  const packagingCost = n(order.packagingCost);
  const giftCost = n(order.giftCost);
  const deliveryCost = order.deliveryCost != null ? n(order.deliveryCost) : 0;
  // A partial delivery — the customer paid the shipping and sent the goods
  // back — is not a total loss, and calling it one overstates the damage by
  // whatever they handed over.
  const collected = order.cancelledCollected != null ? n(order.cancelledCollected) : 0;
  return {
    packagingCost: round2(packagingCost),
    giftCost: round2(giftCost),
    deliveryCost: round2(deliveryCost),
    collected: round2(collected),
    // Packaging is out of the total for the same reason it's out of netProfit:
    // the bags were expensed when they were bought. Kept in the breakdown so a
    // cancellation still says what it consumed.
    total: round2(giftCost + deliveryCost - collected),
  };
}
