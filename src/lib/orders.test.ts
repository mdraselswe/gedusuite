import { describe, expect, it } from "vitest";
import { cancelledOrderCost, computeOrderTotals, type OrderWithTotals } from "@/lib/orders";

type Item = OrderWithTotals["items"][number] & { id?: string };

function order(over: Partial<OrderWithTotals>, items: Item[]): OrderWithTotals {
  return {
    deliveryCharge: 0,
    deliveryCost: null,
    codFeeCost: 0,
    packagingCost: 0,
    giftCost: 0,
    discount: 0,
    ...over,
    items,
  };
}

const line = (over: Partial<Item> = {}): Item => ({
  unitPrice: 500,
  unitCost: 300,
  quantity: 2,
  discount: 0,
  returns: [],
  ...over,
});

describe("computeOrderTotals", () => {
  it("is revenue less cost on a plain order", () => {
    const t = computeOrderTotals(order({}, [line()]));
    expect(t.netRevenue).toBe(1000);
    expect(t.cogs).toBe(600);
    expect(t.netProfit).toBe(400);
    expect(t.customerTotal).toBe(1000);
  });

  it("drops a returned unit's revenue AND its cost, so the margin leaves exactly once", () => {
    const t = computeOrderTotals(
      order({}, [line({ quantity: 2, returns: [{ quantity: 1, refundAmount: 500 }] })]),
    );
    expect(t.netRevenue).toBe(500);
    expect(t.cogs).toBe(300);
    expect(t.netProfit).toBe(200); // one unit's 200 margin, not zero and not 400
    expect(t.returnedUnits).toBe(1);
  });

  it("reports the refund without subtracting it a second time", () => {
    const t = computeOrderTotals(
      order({}, [line({ quantity: 1, returns: [{ quantity: 1, refundAmount: 500 }] })]),
    );
    expect(t.refunds).toBe(500);
    expect(t.netRevenue).toBe(0);
    expect(t.netProfit).toBe(0); // NOT -500
  });

  it("scales a line discount to the quantity actually kept", () => {
    // 100 off four units, two of them returned -> only 50 of the discount applies.
    const t = computeOrderTotals(
      order({}, [
        line({ quantity: 4, discount: 100, returns: [{ quantity: 2, refundAmount: 0 }] }),
      ]),
    );
    expect(t.itemDiscounts).toBe(50);
    expect(t.netRevenue).toBe(950); // 2 x 500 - 50
  });

  it("treats a blank delivery cost as pure pass-through", () => {
    const t = computeOrderTotals(order({ deliveryCharge: 80, deliveryCost: null }, [line()]));
    expect(t.deliveryCost).toBe(80);
    expect(t.deliveryMargin).toBe(0);
    expect(t.netProfit).toBe(400);
    expect(t.customerTotal).toBe(1080);
  });

  it("puts a real delivery margin — either sign — into profit", () => {
    const kept = computeOrderTotals(order({ deliveryCharge: 100, deliveryCost: 60 }, [line()]));
    expect(kept.deliveryMargin).toBe(40);
    expect(kept.netProfit).toBe(440);

    const lost = computeOrderTotals(order({ deliveryCharge: 60, deliveryCost: 100 }, [line()]));
    expect(lost.deliveryMargin).toBe(-40);
    expect(lost.netProfit).toBe(360);
  });

  it("subtracts gifts, the order discount and the COD fee", () => {
    const t = computeOrderTotals(
      order({ packagingCost: 25, giftCost: 40, discount: 100, codFeeCost: 12 }, [line()]),
    );
    expect(t.netRevenue).toBe(900);
    expect(t.netProfit).toBe(900 - 600 - 40 - 12);
  });

  it("reports packaging without charging it", () => {
    // The material was bought as an internal purchase and is already an
    // operating expense there. Charging a per-order share too put the same
    // 5,000 of polybags through the accounts as 10,000.
    const withPack = computeOrderTotals(order({ packagingCost: 25 }, [line()]));
    const without = computeOrderTotals(order({}, [line()]));
    expect(withPack.packagingCost).toBe(25);
    expect(withPack.netProfit).toBe(without.netProfit);
  });

  it("keeps the delivery charge out of revenue but inside what the customer owes", () => {
    const t = computeOrderTotals(order({ deliveryCharge: 120, deliveryCost: 120 }, [line()]));
    expect(t.netRevenue).toBe(1000);
    expect(t.customerTotal).toBe(1120);
  });

  it("survives an order returned in full", () => {
    const t = computeOrderTotals(
      order({ packagingCost: 30 }, [
        line({ quantity: 2, returns: [{ quantity: 2, refundAmount: 1000 }] }),
      ]),
    );
    expect(t.netRevenue).toBe(0);
    expect(t.cogs).toBe(0);
    // Zero, not −30: the packaging was expensed when the bags were bought.
    expect(t.netProfit).toBe(0);
  });

  it("takes the order discount away with the goods on a full return", () => {
    // A discount is a reduction on the sale. Undo the sale and the reduction
    // goes too — left at full size it survived as a standalone negative and
    // invented a 100 loss on an order that never happened.
    const t = computeOrderTotals(
      order({ discount: 100 }, [
        line({ quantity: 2, returns: [{ quantity: 2, refundAmount: 1000 }] }),
      ]),
    );
    expect(t.orderDiscount).toBe(0);
    expect(t.netRevenue).toBe(0);
    expect(t.netProfit).toBe(0);
    expect(t.customerTotal).toBe(0);
  });

  it("keeps the order discount in proportion on a partial return", () => {
    // 2 pieces at 500 with 100 off the order; one comes back, so half the
    // discount belongs to the half that stayed.
    const t = computeOrderTotals(
      order({ discount: 100 }, [
        line({ quantity: 2, returns: [{ quantity: 1, refundAmount: 500 }] }),
      ]),
    );
    expect(t.orderDiscount).toBe(50);
    expect(t.netRevenue).toBe(450);
    expect(t.netProfit).toBe(150); // 450 revenue − 300 cost
  });

  it("leaves the order discount alone when nothing came back", () => {
    const t = computeOrderTotals(order({ discount: 100 }, [line({ quantity: 2 })]));
    expect(t.orderDiscount).toBe(100);
    expect(t.netRevenue).toBe(900);
  });
});

describe("cancelledOrderCost", () => {
  it("counts the gift and the courier's return charge", () => {
    const c = cancelledOrderCost({ packagingCost: 25, giftCost: 40, deliveryCost: 60 });
    // Packaging is reported but not charged — the bags were expensed when they
    // were bought, here as everywhere else.
    expect(c.packagingCost).toBe(25);
    expect(c.total).toBe(100);
  });

  it("treats a missing delivery cost as zero, not as the delivery charge", () => {
    // The opposite of computeOrderTotals on purpose: a cancelled parcel that
    // never shipped was never billed for.
    const c = cancelledOrderCost({ packagingCost: 25, giftCost: 0, deliveryCost: null });
    expect(c.deliveryCost).toBe(0);
    expect(c.total).toBe(0);
  });

  it("nets off what the customer paid anyway on a partial delivery", () => {
    const c = cancelledOrderCost({
      packagingCost: 25,
      giftCost: 0,
      deliveryCost: 60,
      cancelledCollected: 100,
    });
    expect(c.total).toBe(-40); // ended up ahead
  });

  it("is free when nothing was packed or shipped", () => {
    expect(cancelledOrderCost({ packagingCost: 0, giftCost: 0 }).total).toBe(0);
  });
});
