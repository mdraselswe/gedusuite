import type { Prisma } from "@prisma/client";

// Minimal shape needed to compute totals — works with a Prisma query that
// includes items and each item's returns.
export type OrderWithTotals = {
  deliveryCharge: Prisma.Decimal | number;
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
  orderDiscount: number;
  refunds: number; // total cash refunded (reported separately, not re-subtracted)
  netRevenue: number; // effective revenue after discounts, on kept quantities
  cogs: number; // cost of kept quantities
  packagingCost: number;
  giftCost: number;
  deliveryCharge: number;
  netProfit: number; // PRD: sale − cost − packaging − discount − gift (returns-aware)
  customerTotal: number; // owed for kept goods incl. delivery
  returnedUnits: number;
};

/**
 * Server-side order math. Returns are applied per line via the effective
 * quantity (ordered − returned): a returned unit drops out of revenue AND cost,
 * so its margin disappears from profit exactly once. `refundAmount` is reported
 * for cash tracking but is NOT subtracted again (that would double-count the
 * return). Delivery charge is a passthrough, excluded from profit.
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

  const orderDiscount = n(order.discount);
  const packagingCost = n(order.packagingCost);
  const giftCost = n(order.giftCost);
  const deliveryCharge = n(order.deliveryCharge);

  const netRevenue = effectiveRevenue - itemDiscounts - orderDiscount;
  const netProfit = netRevenue - cogs - packagingCost - giftCost;
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
    netProfit: round2(netProfit),
    customerTotal: round2(customerTotal),
    returnedUnits,
  };
}
