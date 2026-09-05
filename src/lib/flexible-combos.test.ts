import { describe, expect, it } from "vitest";
import { allocateFlexiblePrice, recipeBuildable, resolveComboPicks, withProductVariants, comboWebsiteRecipe, type ComboRecipe, type RecipeComponent } from "@/lib/flexible-combos";
import { stockShortfall } from "@/lib/combos";
import { groupComboLines } from "@/lib/combo-lines";

const yellow: RecipeComponent = { productVariantId: "yellow", productId: "spider", quantity: 5, salePrice: 50 };
const blue: RecipeComponent = { ...yellow, productVariantId: "blue" };
const mixed: ComboRecipe = { id: "mixed", flexibleVariants: true, components: [yellow, blue] };
const fixed: ComboRecipe = { ...mixed, id: "fixed", flexibleVariants: false };
const stock = (yellow: number, blue: number) => new Map([["yellow", yellow], ["blue", blue]]);
const pick = (quantity = 1) => [{ comboSetId: mixed.id, quantity }];

describe("all colours of a flexible product", () => {
  const red = { ...yellow, productVariantId: "red", quantity: 0 };
  const other = { ...red, productVariantId: "other", productId: "another-toy" };
  it("includes a colour absent from the recipe without changing its ten pieces", () => {
    const components = withProductVariants(mixed.components, [red, other, yellow, red], true);
    expect(components).toEqual([yellow, blue, red]);
    expect(components.reduce((n, c) => n + c.quantity, 0)).toBe(10);
    const available = new Map([["red", 20]]);
    expect(recipeBuildable(components, available, true)).toBe(2);
    const result = resolveComboPicks([{ ...mixed, components }], pick(2), available);
    expect(result).toEqual([[[{ ...red, quantity: 10 }], [{ ...red, quantity: 10 }]]]);
  });
  it("supports choosing only one variant to define the product and total", () => {
    const components = withProductVariants([{ ...yellow, quantity: 10 }], [blue, red], true);
    expect(resolveComboPicks([{ ...mixed, components }], pick(), new Map([["red", 10]]))).toEqual([[[{ ...red, quantity: 10 }]]]);
  });
  it("accepts manual quantities for the new colour and rejects another product", () => {
    const components = withProductVariants(mixed.components, [red, other], true);
    const selection = { ...pick()[0], allocation: [{ productVariantId: "red", quantity: 10 }] };
    expect(resolveComboPicks([{ ...mixed, components }], [selection], new Map([["red", 10]]))).toEqual([[[{ ...red, quantity: 10 }]]]);
    expect(() => resolveComboPicks([{ ...mixed, components }], [{ ...selection, allocation: [{ productVariantId: "other", quantity: 10 }] }], new Map([["other", 10]]))).toThrow();
  });
  it("does not add alternatives to fixed combos", () => {
    expect(withProductVariants(fixed.components, [red], false)).toEqual([yellow, blue]);
    expect(recipeBuildable(withProductVariants(fixed.components, [red], false), new Map([["red", 20]]), false)).toBe(0);
  });
  it("keeps multiple product totals separate when both gain new colours", () => {
    const battery = { ...yellow, productVariantId: "battery", productId: "battery", quantity: 2 };
    const batteryBlue = { ...battery, productVariantId: "battery-blue", quantity: 0 };
    const components = withProductVariants([...mixed.components, battery], [red, batteryBlue], true);
    const available = new Map([["red", 20], ["battery-blue", 2]]);
    expect(recipeBuildable(components, available, true)).toBe(1);
    const lines = resolveComboPicks([{ ...mixed, components }], pick(), available).flat(2);
    expect(lines.find((l) => l.productVariantId === "red")?.quantity).toBe(10);
    expect(lines.find((l) => l.productVariantId === "battery-blue")?.quantity).toBe(2);
  });
});

describe("shared website listing for all colours", () => {
  const linked = { ...yellow, productName: "Spider Man", wooProductId: 123 };
  it("does not require a website link for each new colour", () => {
    expect(comboWebsiteRecipe([{ ...linked, quantity: 10 }], [{ productId: "spider", wooProductId: null }], true)).toEqual([{ id: 123, qty: 10 }]);
  });
  it("inherits the product listing from a sibling and merges the original recipe totals", () => {
    expect(comboWebsiteRecipe([{ ...linked, wooProductId: null }, { ...linked, productVariantId: "blue", wooProductId: null }], [{ productId: "spider", wooProductId: 123 }], true)).toEqual([{ id: 123, qty: 10 }]);
  });
  it("rejects conflicting colour-specific website links instead of pushing a fixed recipe", () => {
    expect(() => comboWebsiteRecipe([linked], [{ productId: "spider", wooProductId: 456 }], true)).toThrow(/different website/);
  });
  it("still requires exact links for fixed combos", () => {
    expect(() => comboWebsiteRecipe([{ ...linked, wooProductId: null }], [{ productId: "spider", wooProductId: 123 }], false)).toThrow(/Link/);
    expect(comboWebsiteRecipe([linked, { ...linked, productVariantId: "blue", wooProductId: 456 }], [], false)).toEqual([{ id: 123, qty: 5 }, { id: 456, qty: 5 }]);
  });
});

describe("flexible combo stock and allocation", () => {
  it("uses pooled stock only when explicitly enabled", () => {
    expect(recipeBuildable(mixed.components, stock(3, 17), true)).toBe(2);
    expect(recipeBuildable(mixed.components, stock(3, 17), false)).toBe(0);
    expect(recipeBuildable([], stock(3, 17), true)).toBe(0);
    expect(recipeBuildable(mixed.components, stock(-3, 10), true)).toBe(1);
  });
  it("fills the user's ten-piece offer entirely from blue", () => {
    const available = stock(0, 10);
    expect(resolveComboPicks([mixed], pick(), available)).toEqual([[[{ ...blue, quantity: 10 }]]]);
    expect(available).toEqual(stock(0, 10));
  });
  it("splits across available colours and preserves one record group per set", () => {
    const sets = resolveComboPicks([mixed], pick(2), stock(3, 17))[0];
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.reduce((n, c) => n + c.quantity, 0))).toEqual([10, 10]);
    expect(stockShortfall(sets.flat(), stock(3, 17))).toEqual([]);
  });
  it("reserves gifts, loose lines, manual picks and fixed combos before automatic choices", () => {
    const picks = [...pick(), { comboSetId: "fixed", quantity: 1 }];
    const result = resolveComboPicks([mixed, fixed], picks, stock(8, 15), [{ productVariantId: "yellow", quantity: 3 }]);
    expect(result[0]).toEqual([[{ ...blue, quantity: 10 }]]);
    expect(result[1]).toEqual([[yellow, blue]]);
  });
  it("reassigns overlapping pools instead of rejecting a feasible basket", () => {
    const narrow = { ...mixed, id: "narrow", components: [{ ...yellow, quantity: 11 }] };
    const result = resolveComboPicks([mixed, narrow], [...pick(), { comboSetId: "narrow", quantity: 1 }], stock(11, 10));
    expect(result[0]).toEqual([[{ ...blue, quantity: 10 }]]);
    expect(result[1]).toEqual([[{ ...yellow, quantity: 11 }]]);
  });
  it("does not silently substitute variants on a fixed combo", () => {
    const result = resolveComboPicks([fixed], [{ comboSetId: "fixed", quantity: 1 }], stock(0, 10));
    expect(result).toEqual([[[yellow, blue]]]);
    expect(stockShortfall(result.flat(2), stock(0, 10))).toHaveLength(1);
    expect(() => resolveComboPicks([fixed], [{ comboSetId: "fixed", quantity: 1, allocation: [{ productVariantId: "blue", quantity: 10 }] }], stock(0, 10))).toThrow(/Fixed/);
  });
  it("accepts a manual 3 yellow / 7 blue split", () => {
    const allocation = [{ productVariantId: "yellow", quantity: 3 }, { productVariantId: "blue", quantity: 7 }];
    const result = resolveComboPicks([mixed], [{ ...pick()[0], allocation }], stock(10, 10));
    expect(result.flat(2).reduce((n, c) => n + c.quantity, 0)).toBe(10);
    expect(result.flat(2).find((c) => c.productVariantId === "yellow")?.quantity).toBe(3);
  });
  it.each([
    [{ productVariantId: "yellow", quantity: 9 }],
    [{ productVariantId: "unknown", quantity: 10 }],
    [{ productVariantId: "yellow", quantity: 5 }, { productVariantId: "yellow", quantity: 5 }],
    [{ productVariantId: "yellow", quantity: 10.5 }],
    [{ productVariantId: "yellow", quantity: -1 }, { productVariantId: "blue", quantity: 11 }],
  ])("rejects invalid manual allocation %j", (...allocation) => {
    expect(() => resolveComboPicks([mixed], [{ ...pick()[0], allocation }], stock(20, 20))).toThrow();
  });
  it("checks product totals, not just the total number of pieces", () => {
    const battery = { ...blue, productVariantId: "battery", productId: "battery", quantity: 2 };
    const recipe = { ...mixed, components: [yellow, blue, battery] };
    expect(recipeBuildable(recipe.components, new Map([...stock(0, 20), ["battery", 1]]), true)).toBe(0);
    expect(() => resolveComboPicks([recipe], [{ ...pick()[0], allocation: [{ productVariantId: "blue", quantity: 12 }] }], stock(20, 20))).toThrow();
  });
  it("rejects a basket sharing more stock than exists", () => {
    expect(() => resolveComboPicks([mixed], pick(2), stock(3, 16))).toThrow(/stock/);
  });
  it("leaves manual overselling visible to the authoritative stock guard", () => {
    const result = resolveComboPicks([mixed], [{ ...pick()[0], allocation: [{ productVariantId: "blue", quantity: 10 }] }], stock(10, 0));
    expect(stockShortfall(result.flat(2), stock(10, 0))).toEqual([{ productVariantId: "blue", need: 10, have: 0 }]);
  });
});

describe("flexible combo price and returns", () => {
  it("keeps rounding exact across tiny shares and an unpriced final variant", () => {
    const components = Array.from({ length: 5 }, (_, i) => ({ ...yellow, productVariantId: String(i), quantity: 1, salePrice: i === 4 ? 0 : 0.01 }));
    const lines = allocateFlexiblePrice(components, 0.02);
    expect(Math.round(lines.reduce((n, c) => n + c.unitPrice * c.quantity - c.discount, 0) * 100)).toBe(2);
    expect(lines.every((l) => l.discount >= 0 && l.discount <= l.unitPrice * l.quantity)).toBe(true);
  });
  it.each([null, 0, 10, 100])("keeps the offered price with catalogue price %s", (salePrice) => {
    const lines = allocateFlexiblePrice([{ ...yellow, quantity: 3, salePrice }, { ...blue, quantity: 7, salePrice }], 399.99);
    expect(Math.round(lines.reduce((n, c) => n + c.unitPrice * c.quantity - c.discount, 0) * 100)).toBe(39999);
    expect(lines.every((l) => l.discount >= 0)).toBe(true);
  });
  it("uses existing invoice and partial-return math for the actual variants", () => {
    const lines = allocateFlexiblePrice([{ ...blue, quantity: 10 }], 400);
    const grouped = groupComboLines(lines.map((l) => ({ ...l, id: "line", comboSetId: "mixed", comboKey: "set-1", label: "Blue", returned: 2 })), new Map([["mixed", "Buy 8 Get 2"]]));
    expect(grouped.groups[0]).toMatchObject({ kind: "combo", sets: 1, net: 320, returned: 2 });
  });
});
