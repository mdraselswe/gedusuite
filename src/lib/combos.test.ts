import { describe, expect, it } from "vitest";
import {
  allocateComboPrice,
  comboBuildable,
  componentsTotal,
  type ComboComponent,
} from "@/lib/combos";

// "Flight Starter": one aeroplane at 900, three batteries at 216.67 each.
// Lists for 1,550; sells for 1,200. The saving is 350.
const FLIGHT: ComboComponent[] = [
  { productVariantId: "plane", quantity: 1, salePrice: 900 },
  { productVariantId: "battery", quantity: 3, salePrice: 216.67 },
];

describe("comboBuildable", () => {
  it("is limited by the scarcest component, per set", () => {
    // 10 planes, 7 batteries, 3 batteries per set -> 2 sets.
    const stock = new Map([["plane", 10], ["battery", 7]]);
    expect(comboBuildable(FLIGHT, stock)).toBe(2);
  });

  it("is zero when any component is out", () => {
    expect(comboBuildable(FLIGHT, new Map([["plane", 5], ["battery", 0]]))).toBe(0);
  });

  it("is zero when a component has never been stocked at all", () => {
    // An absent key is not the same as a zero, and the map only ever carries
    // variants something has happened to.
    expect(comboBuildable(FLIGHT, new Map([["plane", 5]]))).toBe(0);
  });

  it("is zero for a recipe with no components", () => {
    // min() over nothing is Infinity — this would have advertised an unlimited
    // supply of an empty box.
    expect(comboBuildable([], new Map())).toBe(0);
  });

  it("never reports a negative count from negative stock", () => {
    expect(comboBuildable(FLIGHT, new Map([["plane", -3], ["battery", 9]]))).toBe(0);
  });
});

describe("componentsTotal", () => {
  it("is what the same goods list for bought separately", () => {
    expect(componentsTotal(FLIGHT)).toBe(1550.01);
  });

  it("counts an unpriced component as nothing rather than failing", () => {
    expect(componentsTotal([{ productVariantId: "x", quantity: 2, salePrice: null }])).toBe(0);
  });
});

describe("allocateComboPrice", () => {
  it("keeps catalogue prices and puts the saving in the discounts", () => {
    const lines = allocateComboPrice(FLIGHT, 1200);
    expect(lines.map((l) => l.unitPrice)).toEqual([900, 216.67]);
    expect(lines.map((l) => l.quantity)).toEqual([1, 3]);
  });

  it("splits the saving in proportion to what each line is worth", () => {
    const lines = allocateComboPrice(FLIGHT, 1200);
    // plane is 900/1550.01 of the value, batteries 650.01/1550.01.
    expect(lines[0].discount).toBeCloseTo(203.23, 2);
    expect(lines[1].discount).toBeCloseTo(146.78, 2);
  });

  it("makes the discounts sum to exactly the saving", () => {
    // The property that matters: an invoice one paisa off its own total is
    // unfindable. The last line absorbs the rounding remainder.
    const lines = allocateComboPrice(FLIGHT, 1200);
    const sum = lines.reduce((s, l) => s + l.discount, 0);
    expect(Math.round(sum * 100) / 100).toBe(350.01);
  });

  it("scales quantities and the saving by the number of sets", () => {
    const lines = allocateComboPrice(FLIGHT, 1200, 2);
    expect(lines.map((l) => l.quantity)).toEqual([2, 6]);
    const sum = lines.reduce((s, l) => s + l.discount, 0);
    expect(Math.round(sum * 100) / 100).toBe(700.02);
  });

  it("gives no discount when the combo is not actually cheaper", () => {
    // Priced at or above the parts: the customer still pays the combo price,
    // but there is no saving to spread, and a negative one would read as
    // negative revenue downstream.
    const lines = allocateComboPrice(FLIGHT, 1800);
    expect(lines.every((l) => l.discount === 0)).toBe(true);
  });

  it("splits by piece count when nothing has a price to be proportional to", () => {
    const unpriced: ComboComponent[] = [
      { productVariantId: "a", quantity: 1, salePrice: null },
      { productVariantId: "b", quantity: 3, salePrice: null },
    ];
    // Nothing lists for anything, so there is no saving either — but the split
    // must still not divide by zero.
    const lines = allocateComboPrice(unpriced, 500);
    expect(lines.map((l) => l.discount)).toEqual([0, 0]);
    expect(lines.map((l) => l.quantity)).toEqual([1, 3]);
  });

  it("never returns a negative discount", () => {
    const lines = allocateComboPrice(FLIGHT, 1200, 3);
    expect(lines.every((l) => l.discount >= 0)).toBe(true);
  });

  it("returns nothing for an empty recipe or a zero quantity", () => {
    expect(allocateComboPrice([], 1200)).toEqual([]);
    expect(allocateComboPrice(FLIGHT, 1200, 0)).toEqual([]);
  });
});
