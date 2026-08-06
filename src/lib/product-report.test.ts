import { describe, expect, it } from "vitest";
import { allocateOrderLines } from "@/lib/product-report";
import { computeOrderTotals } from "@/lib/orders";

type Item = {
  id: string;
  unitPrice: number;
  unitCost: number;
  quantity: number;
  discount: number;
  returns: { quantity: number; refundAmount: number }[];
};

function order(over: Record<string, number | null>, items: Item[]) {
  return {
    deliveryCharge: (over.deliveryCharge ?? 0) as number,
    deliveryCost: over.deliveryCost ?? null,
    codFeeCost: (over.codFeeCost ?? 0) as number,
    packagingCost: (over.packagingCost ?? 0) as number,
    giftCost: (over.giftCost ?? 0) as number,
    discount: (over.discount ?? 0) as number,
    items,
  };
}

const line = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  unitPrice: 500,
  unitCost: 300,
  quantity: 2,
  discount: 0,
  returns: [],
  ...over,
});

/**
 * The invariant the product detail page rests on: whatever an order's costs
 * are and however they're split, the lines must add back up to the order. A
 * product page and an order breakdown that disagree are worse than either.
 */
const cases: { name: string; order: ReturnType<typeof order> }[] = [
  {
    name: "two lines with every cost in play",
    order: order(
      { deliveryCharge: 80, deliveryCost: 60, codFeeCost: 12, packagingCost: 25, giftCost: 40, discount: 100 },
      [line("a", { quantity: 3, discount: 50 }), line("b", { unitPrice: 200, unitCost: 120, quantity: 2 })],
    ),
  },
  {
    name: "one line partly returned",
    order: order({ deliveryCharge: 120, deliveryCost: 150, codFeeCost: 9, packagingCost: 30 }, [
      line("a", { quantity: 4, discount: 80, returns: [{ quantity: 2, refundAmount: 900 }] }),
      line("b", { unitPrice: 200, unitCost: 120, quantity: 1 }),
    ]),
  },
  {
    name: "everything returned — no revenue left to weight by",
    order: order({ deliveryCost: 90, packagingCost: 30, giftCost: 20 }, [
      line("a", { quantity: 2, returns: [{ quantity: 2, refundAmount: 1000 }] }),
      line("b", { unitPrice: 200, unitCost: 120, quantity: 1, returns: [{ quantity: 1, refundAmount: 200 }] }),
    ]),
  },
  {
    name: "a line discounted below its own revenue",
    order: order({ deliveryCharge: 60, deliveryCost: 60, codFeeCost: 5, packagingCost: 20, discount: 30 }, [
      line("a", { unitPrice: 100, unitCost: 80, quantity: 1, discount: 400 }),
      line("b", { unitPrice: 900, unitCost: 500, quantity: 1 }),
    ]),
  },
  {
    name: "single line, pass-through delivery",
    order: order({ deliveryCharge: 70, packagingCost: 15, giftCost: 5, codFeeCost: 3 }, [
      line("a", { unitPrice: 350, unitCost: 210, quantity: 6, discount: 100, returns: [{ quantity: 1, refundAmount: 350 }] }),
    ]),
  },
];

describe("allocateOrderLines", () => {
  for (const c of cases) {
    it(`adds back up to the order: ${c.name}`, () => {
      const totals = computeOrderTotals(c.order);
      const lines = [...allocateOrderLines(c.order).values()];
      const sum = (pick: (l: (typeof lines)[number]) => number) =>
        lines.reduce((s, l) => s + pick(l), 0);

      // computeOrderTotals rounds each field to 2dp; the line sums don't, so
      // they can legitimately differ by less than a paisa.
      expect(sum((l) => l.netProfit)).toBeCloseTo(totals.netProfit, 2);
      expect(sum((l) => l.revenue)).toBeCloseTo(totals.netRevenue, 2);
      expect(sum((l) => l.cogs)).toBeCloseTo(totals.cogs, 2);
      expect(sum((l) => l.packagingCost)).toBeCloseTo(totals.packagingCost, 2);
      expect(sum((l) => l.giftCost)).toBeCloseTo(totals.giftCost, 2);
      expect(sum((l) => l.codFeeCost)).toBeCloseTo(totals.codFeeCost, 2);
      expect(sum((l) => l.deliveryMargin)).toBeCloseTo(totals.deliveryMargin, 2);
      expect(sum((l) => l.share)).toBeCloseTo(1, 6);
    });
  }

  it("weights by revenue, so the bigger line carries more of the order's costs", () => {
    const lines = allocateOrderLines(
      order({ packagingCost: 100 }, [
        line("big", { unitPrice: 900, quantity: 1, unitCost: 0 }),
        line("small", { unitPrice: 100, quantity: 1, unitCost: 0 }),
      ]),
    );
    expect(lines.get("big")!.packagingCost).toBeCloseTo(90, 6);
    expect(lines.get("small")!.packagingCost).toBeCloseTo(10, 6);
  });

  it("reports kept and returned units per line", () => {
    const l = allocateOrderLines(
      order({}, [line("a", { quantity: 5, returns: [{ quantity: 2, refundAmount: 0 }] })]),
    ).get("a")!;
    expect(l.keptUnits).toBe(3);
    expect(l.returnedUnits).toBe(2);
  });
});
