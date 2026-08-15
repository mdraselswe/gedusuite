/**
 * Splitting a call-list order into goods and delivery.
 *
 * `total` on a lead is the grand total the customer was quoted — the figure the
 * caller reads back down the phone — and it stays that. Delivery is recorded
 * beside it rather than folded in, because before this the only way to get
 * shipping into the figure was to overwrite the total by hand, which threw the
 * breakdown away: the items said one number, the total said another, and
 * nothing recorded whether the difference was shipping or a discount.
 *
 * It has to work from whichever end is known. A catalogue order prices its own
 * items and adds delivery on top. A phone order routinely has free-typed items
 * with no price at all, so there is nothing to add up — there the split is read
 * back out of the total that was agreed.
 */

import { round2 } from "@/lib/money";

/**
 * What the total should become when the items price themselves.
 * Null when they don't, and the total is then whatever was typed.
 */
export function suggestedLeadTotal(
  goodsTotal: number | null,
  deliveryCharge: number,
): number | null {
  if (goodsTotal === null) return null;
  return round2(goodsTotal + Math.max(0, deliveryCharge));
}

export type LeadBreakdown = { goods: number; delivery: number };

/**
 * The goods/delivery split to show under the field, or null when there isn't
 * one worth showing.
 *
 * Goods are floored at zero: a delivery charge typed larger than the total is a
 * half-finished edit, not a negative amount of product.
 */
export function leadBreakdown(
  goodsTotal: number | null,
  deliveryCharge: number,
  grandTotal: number,
): LeadBreakdown | null {
  const delivery = Math.max(0, deliveryCharge);
  if (goodsTotal !== null) return { goods: goodsTotal, delivery };
  if (delivery > 0 && grandTotal > 0) {
    return { goods: Math.max(0, round2(grandTotal - delivery)), delivery };
  }
  return null;
}
