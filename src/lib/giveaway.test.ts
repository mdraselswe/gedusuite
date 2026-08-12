import { describe, expect, it } from "vitest";
import { computeOrderTotals, goodsDiscount } from "@/lib/orders";
import { amountOutstanding, codCollectable, depositAmount } from "@/lib/order-cash";

/**
 * A product given away free, delivered by courier at the shop's expense.
 *
 * The real order this was written from: one piece bought for 80 and normally
 * sold at 130, Dhaka City delivery costing the shop 65. Giving it away has to
 * cost the business exactly the goods plus the trip — 145 — and must not leave
 * a taka of it looking like revenue, a due, or something for the courier to
 * collect. These are the numbers that say so.
 */
const giveaway = {
  // The goods are cancelled out by an order discount of the same size; there is
  // no "price 0" to type, since an order's item prices are fixed at creation.
  discount: 130,
  // The customer pays nothing to have it delivered…
  deliveryCharge: 0,
  // …but the courier still charges the shop for the trip.
  deliveryCost: 65,
  codFeeCost: 0,
  packagingCost: 0,
  giftCost: 0,
  items: [{ unitPrice: 130, unitCost: 80, quantity: 1, discount: 0, returns: [] }],
};

describe("a free order", () => {
  const totals = computeOrderTotals(giveaway);

  it("earns nothing", () => {
    expect(totals.netRevenue).toBe(0);
  });

  it("leaves the customer owing nothing", () => {
    expect(totals.customerTotal).toBe(0);
    expect(
      amountOutstanding({ status: "PACKED", paymentStatus: "UNPAID", amountPaid: 0 }, totals),
    ).toBe(0);
  });

  it("charges the business the product's purchase price", () => {
    expect(totals.cogs).toBe(80);
  });

  it("charges the business the courier's fee for the trip", () => {
    // Nothing was collected to take it out of, so the whole 65 is a loss on the
    // order rather than a margin on the delivery.
    expect(totals.deliveryMargin).toBe(-65);
  });

  it("costs exactly the goods plus the delivery, and nothing else", () => {
    expect(totals.netProfit).toBe(-145);
  });

  it("gives the courier nothing to collect", () => {
    // The parcel must go out non-COD; the fee the courier charges on a
    // collection therefore has nothing to apply to either.
    expect(codCollectable("COURIER_COLLECTION", totals.customerTotal)).toBe(0);
  });

  it("has no remittance to wait for", () => {
    // Which is why the treasury never grows an entry for it — see
    // syncOrderCashEntry, which deletes rather than writes a zero deposit.
    const deposit = depositAmount(
      { status: "DELIVERED", paymentStatus: "PAID", paymentMethod: "COURIER_COLLECTION" },
      totals,
    );
    expect(deposit.gross).toBe(0);
    expect(deposit.net).toBe(0);
  });

  it("still shows the shop owes the courier for the trip", () => {
    // What the courier balance page reads: collected − delivery − COD fee, not
    // floored at zero, so a free parcel reads as 65 owed to Steadfast.
    const cod = codCollectable("COURIER_COLLECTION", totals.customerTotal);
    expect(cod - totals.deliveryCost - totals.codFeeCost).toBe(-65);
  });

  it("would misreport if the delivery cost were left blank", () => {
    // The trap: blank means "same as the charge", and the charge is 0 — so the
    // 65 the shop really pays would vanish from profit entirely. It only bites
    // on an order with no courier and zone set; where there is one, saving with
    // the field empty re-quotes the cost from the zone's rate instead (see
    // quoteForOrder).
    const wrong = computeOrderTotals({ ...giveaway, deliveryCost: null });
    expect(wrong.netProfit).toBe(-80);
  });

  it("would misreport if the discount included the delivery", () => {
    // Discounting 210 (goods + delivery) instead of 130 turns the delivery the
    // shop is absorbing into negative revenue, and doubles the apparent cost.
    const wrong = computeOrderTotals({ ...giveaway, discount: 210 });
    expect(wrong.netRevenue).toBe(-80);
    expect(wrong.netProfit).toBe(-225);
  });
});

describe("goodsDiscount", () => {
  it("takes the whole goods total off a giveaway", () => {
    expect(goodsDiscount(true, 0, 130)).toBe(130);
  });

  it("ignores whatever was typed in the discount box", () => {
    // The box is read-only while the checkbox is ticked, but a hand-built
    // request — or a queued one from before the checkbox existed — can still
    // carry a figure, and it must not be able to price a giveaway.
    expect(goodsDiscount(true, 210, 130)).toBe(130);
    expect(goodsDiscount(true, 0, 130)).toBe(130);
  });

  it("leaves an ordinary order's discount alone", () => {
    expect(goodsDiscount(false, 50, 130)).toBe(50);
    expect(goodsDiscount(false, 0, 130)).toBe(0);
  });

  it("nets off line discounts rather than double-counting them", () => {
    // itemsNet is already price × qty less each line's own discount, so a
    // giveaway of goods worth 130 with 30 already off needs 100 more.
    expect(goodsDiscount(true, 0, 100)).toBe(100);
  });

  it("never produces a negative discount", () => {
    // A fully returned or oddly-priced order can leave itemsNet at or below
    // zero; a negative discount would read as revenue.
    expect(goodsDiscount(true, 0, -20)).toBe(0);
  });

  it("rounds to paisa", () => {
    expect(goodsDiscount(true, 0, 0.1 + 0.2)).toBe(0.3);
  });
});
