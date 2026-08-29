import { describe, expect, it } from "vitest";
import { groupComboLines, type SoldLine } from "@/lib/combo-lines";

function line(over: Partial<SoldLine> & { id: string }): SoldLine {
  return {
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    comboSetId: null,
    comboKey: null,
    label: "Item",
    returned: 0,
    ...over,
  };
}

const NAMES = new Map([["combo1", "Flight Starter Combo"]]);

describe("groupComboLines", () => {
  it("leaves ordinary lines alone", () => {
    const { groups, comboDiscount } = groupComboLines(
      [line({ id: "a", unitPrice: 500, quantity: 2 })],
      NAMES,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("item");
    expect(comboDiscount).toBe(0);
  });

  it("folds a set's components into one group at its net price", () => {
    const { groups, comboDiscount } = groupComboLines(
      [
        line({ id: "a", comboSetId: "combo1", comboKey: "k1", unitPrice: 900, discount: 203.23 }),
        line({
          id: "b",
          comboSetId: "combo1",
          comboKey: "k1",
          quantity: 3,
          unitPrice: 216.67,
          discount: 146.78,
        }),
      ],
      NAMES,
    );
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind).toBe("combo");
    if (g.kind !== "combo") return;
    expect(g.name).toBe("Flight Starter Combo");
    expect(g.sets).toBe(1);
    expect(g.gross).toBe(1550.01);
    expect(g.net).toBe(1200);
    // The caller nets this out of its own item-discount line, or the saving
    // would be subtracted once inside the group total and once again below it.
    expect(comboDiscount).toBe(350.01);
  });

  it("counts two of the same combo as two sets, not two groups", () => {
    const { groups } = groupComboLines(
      [
        line({ id: "a", comboSetId: "combo1", comboKey: "k1", unitPrice: 900, discount: 200 }),
        line({ id: "b", comboSetId: "combo1", comboKey: "k1", unitPrice: 650, discount: 150 }),
        line({ id: "c", comboSetId: "combo1", comboKey: "k2", unitPrice: 900, discount: 200 }),
        line({ id: "d", comboSetId: "combo1", comboKey: "k2", unitPrice: 650, discount: 150 }),
      ],
      NAMES,
    );
    expect(groups).toHaveLength(1);
    const g = groups[0];
    if (g.kind !== "combo") throw new Error("expected a combo group");
    expect(g.sets).toBe(2);
    expect(g.net).toBe(2400);
  });

  it("takes a returned piece off the price AND its share of the saving", () => {
    // Three batteries at 216.67 with 146.78 off; one comes back. Two thirds of
    // both the price and the discount survive — the same fraction rule
    // computeOrderTotals applies, so the two never disagree.
    const { groups } = groupComboLines(
      [
        line({ id: "a", comboSetId: "combo1", comboKey: "k1", unitPrice: 900, discount: 203.23 }),
        line({
          id: "b",
          comboSetId: "combo1",
          comboKey: "k1",
          quantity: 3,
          returned: 1,
          unitPrice: 216.67,
          discount: 146.78,
        }),
      ],
      NAMES,
    );
    const g = groups[0];
    if (g.kind !== "combo") throw new Error("expected a combo group");
    expect(g.returned).toBe(1);
    expect(g.gross).toBeCloseTo(1333.34, 2);
    expect(g.discount).toBeCloseTo(301.08, 2);
    expect(g.net).toBeCloseTo(1032.26, 2);
  });

  it("names a deleted combo rather than showing a blank", () => {
    const { groups } = groupComboLines(
      [line({ id: "a", comboSetId: "gone", comboKey: "k1", unitPrice: 100 })],
      NAMES,
    );
    const g = groups[0];
    if (g.kind !== "combo") throw new Error("expected a combo group");
    expect(g.name).toBe("Combo");
  });

  it("treats a combo id with no key as a loose line", () => {
    // Nothing writes this, but a hand-edited row must not be folded into a set
    // it may not belong to.
    const { groups } = groupComboLines(
      [line({ id: "a", comboSetId: "combo1", comboKey: null, unitPrice: 100 })],
      NAMES,
    );
    expect(groups[0].kind).toBe("item");
  });

  it("keeps combos and loose items in the order they were entered", () => {
    const { groups } = groupComboLines(
      [
        line({ id: "a", unitPrice: 100 }),
        line({ id: "b", comboSetId: "combo1", comboKey: "k1", unitPrice: 900 }),
        line({ id: "c", unitPrice: 50 }),
      ],
      NAMES,
    );
    expect(groups.map((g) => g.kind)).toEqual(["item", "combo", "item"]);
  });
});
